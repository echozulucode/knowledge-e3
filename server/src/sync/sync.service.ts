/**
 * `SyncService` — hosts one `SyncEngine` (`@echozedlabs/repo-sync`) per enabled
 * source with a remote (plan §8.1). Division of labour: the server's debounced
 * committer (`GitRevisionMirrorAdapter`) makes local commits; the engine
 * fetches, merges, hands inbound paths to `InboundIndexService`, parks conflicts
 * in `ConflictQueueService`, and pushes on the §12 cadence — on publish
 * (`requestPush`) or when the 5-minute push interval has elapsed during a
 * scheduled cycle. Sources the service manages are marked on the routing
 * mirror so their commits stay local (`pushOnCommit: false`); `read-only`
 * sources only ever fetch, merge and index.
 *
 * Under test the engines stay off unless `KNOWLEDGE_E3_SYNC=1`; tests drive
 * cycles through `runNow`, which creates an engine on first use.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { SyncStatus } from '@echozedlabs/knowledge-types';
import {
  DEFAULT_PUSH_INTERVAL_MS,
  LocalGitRepo,
  SyncEngine,
  runGit,
  type ConflictChoice,
  type PushReason,
} from '@echozedlabs/repo-sync';
import { isTest, loadServerConfig } from '../config/server-config.js';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';
import { RoutingRevisionMirror } from '../storage/routing-revision-mirror.adapter.js';
import { ConflictQueueService } from './conflict-queue.service.js';
import { InboundIndexService } from './inbound-index.service.js';
import { prepareRepo } from './prepare-repo.js';
import { ReviewService, type ReviewRecord } from './review.service.js';
import { SourceRegistryService, envVarPresent, resolveLocalDir, type SourceRow } from './source-registry.service.js';
import type { SyncPushPort } from './sync.port.js';

interface Managed {
  row: SourceRow;
  repo: LocalGitRepo;
  engine: SyncEngine;
  timer: ReturnType<typeof setInterval> | null;
}

export interface SourceStatusView extends SourceRow {
  status: SyncStatus;
  /** True when a running engine manages this source. */
  managed: boolean;
  /**
   * Whether the env var this row NAMES holds a value on this server (plan B3 /
   * D4a). Booleans, never the value: the name is already in the registry and is
   * the half an operator can act on. Runbook §3.3's diagnosis is exactly this
   * question, and nothing could answer it before.
   */
  host_token_present: boolean;
  webhook_secret_present: boolean;
  /**
   * What the Sources → Details panel shows beside the selection (plan A1):
   * how many live items are indexed from this source, and the commit its
   * working tree is on. Present on the list (`statuses()`) and on the upsert
   * response; `view()` alone — synchronous, no I/O — leaves them out.
   */
  item_count?: number;
  /** Null when the working tree is missing, not a repository, unborn, or git did not answer in time. */
  head?: SourceHead | null;
}

/** The commit a source's working tree has checked out. */
export interface SourceHead {
  sha: string;
  /** Committer date, ISO 8601; null when git printed none. */
  committed_at: string | null;
}

/**
 * Bound on the one `git log -1` each source costs the list. The Sources page
 * polls this route, so a wedged repository (a stale lock on a network share, a
 * hung credential helper) must cost it a blank HEAD cell, never the page.
 */
export const HEAD_TIMEOUT_MS = 2_000;

/** Unit separator between the `git log` fields: neither a sha nor a date can contain it. */
const FIELD_SEP = String.fromCharCode(0x1f);

@Injectable()
export class SyncService implements OnApplicationBootstrap, OnModuleDestroy, SyncPushPort {
  private readonly logger = new Logger(SyncService.name);
  private readonly engines = new Map<string, Managed>();
  /** Last status reported by each engine (also for sources whose engine has been stopped). */
  private readonly latest = new Map<string, SyncStatus>();
  /** Per-source serialization of cycles (a publish and a timer tick must not interleave). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private active = false;

  constructor(
    private readonly registry: SourceRegistryService,
    private readonly paths: ContentPathResolver,
    private readonly inbound: InboundIndexService,
    private readonly conflicts: ConflictQueueService,
    private readonly reviews: ReviewService,
    @Inject(REVISION_MIRROR) private readonly mirror: RevisionMirrorPort,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {
    this.conflicts.bindResolver((sourceId, path, choice) => this.resolveConflict(sourceId, path, choice));
  }

  async onApplicationBootstrap(): Promise<void> {
    const cfg = loadServerConfig();
    await this.registry.reconcileFromConfig(cfg.sources).catch((err) => {
      this.logger.warn(`source registry reconciliation failed: ${errMessage(err)}`);
    });
    if (isTest() && process.env['KNOWLEDGE_E3_SYNC'] !== '1') return;
    this.active = true;
    await this.reload();
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.engines.keys()]) this.stop(id);
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** (Re)create the engines from the registry: every enabled row with a remote. No-op unless booted active. */
  async reload(): Promise<void> {
    if (!this.active) return;
    const rows = await this.registry.list();
    const wanted = new Set(rows.filter(isSyncable).map((r) => r.id));
    for (const id of [...this.engines.keys()]) if (!wanted.has(id)) this.stop(id);
    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      const current = this.engines.get(row.id);
      if (current && sameConfig(current.row, row)) continue;
      if (current) this.stop(row.id);
      try {
        await this.start(row);
      } catch (err) {
        this.logger.warn(`[sync:${row.id}] could not start: ${errMessage(err)}`);
        await this.registry.recordSync(row.id, { error: errMessage(err) });
      }
    }
  }

  /**
   * One fetch → merge → index (→ push when due or `force`) cycle, now.
   *
   * The review policy (plan §8.2) is reconciled first: `ReviewService.reconcile`
   * fetches, brings the base branch up to date for every change request the host
   * reports as merged, and hands those files to the inbound indexer — so merge
   * detection happens after a fetch/merge and before the files are indexed. The
   * engine cycle that follows then finds nothing new to merge and only pushes.
   */
  runNow(sourceId: string, opts: { force?: boolean } = {}): Promise<SyncStatus> {
    return this.serialize(sourceId, async () => {
      const m = await this.engineFor(sourceId);
      await this.flushMirror(m);
      await this.reconcileReviews(m);
      return this.persist(m, await m.engine.runCycle(opts));
    });
  }

  /** Every change request this source has, open ones first (Admin → Repos → Reviews). */
  listReviews(sourceId: string): Promise<ReviewRecord[]> {
    return this.reviews.list(sourceId);
  }

  /** Re-ask the host about this source's open change requests (all, or one item's). */
  refreshReviews(sourceId: string, pageId?: string): Promise<ReviewRecord[]> {
    return this.serialize(sourceId, async () => {
      const m = await this.engineFor(sourceId);
      const fresh = (await this.registry.get(sourceId)) ?? m.row;
      return this.reviews.reconcile(fresh, m.repo, (changes) => this.inbound.applyChanges(fresh, changes), { pageId });
    });
  }

  /** Merge one item's change request through the host, then reconcile it. */
  mergeReview(sourceId: string, pageId: string): Promise<ReviewRecord> {
    return this.serialize(sourceId, async () => {
      const m = await this.engineFor(sourceId);
      const fresh = (await this.registry.get(sourceId)) ?? m.row;
      return this.reviews.merge(fresh, m.repo, pageId, (changes) => this.inbound.applyChanges(fresh, changes));
    });
  }

  /** Flag a push and run a cycle: the pending debounced commit is flushed first so the push carries it. */
  requestPush(sourceId: string, reason: PushReason = 'publish'): Promise<SyncStatus> {
    return this.serialize(sourceId, async () => {
      const m = await this.engineFor(sourceId);
      await this.flushMirror(m);
      return this.persist(m, await m.engine.requestPush(reason));
    });
  }

  async resolveConflict(sourceId: string, path: string, choice: ConflictChoice): Promise<SyncStatus> {
    const m = this.engines.get(sourceId);
    if (!m) throw new BadRequestException(`Source ${sourceId} has no running sync engine`);
    return this.persist(m, await m.engine.resolveConflict(path, choice));
  }

  /** Every registered source with its live (or last known) status, item count and HEAD. */
  async statuses(): Promise<SourceStatusView[]> {
    return this.detailedViews(await this.registry.list());
  }

  /**
   * `view()` plus the two facts that need I/O (plan A1). The cost is fixed, not
   * per item: ONE grouped count over `pages` for every source, and one bounded
   * `git log -1` per source, run in parallel. Neither can fail the list. A
   * count query that errors leaves `item_count` ABSENT rather than 0 — 0 would
   * tell the admin the source is empty — and a HEAD that errors is null.
   */
  async detailedViews(rows: SourceRow[]): Promise<SourceStatusView[]> {
    const [counts, heads] = await Promise.all([
      this.itemCounts().catch((err) => {
        this.logger.warn(`source item counts failed: ${errMessage(err)}`);
        return null;
      }),
      Promise.all(rows.map((row) => this.headOf(row))),
    ]);
    return rows.map((row, i) => ({
      ...this.view(row),
      ...(counts ? { item_count: counts.get(row.id) ?? 0 } : {}),
      head: heads[i] ?? null,
    }));
  }

  /** One registry row as the admin routes ship it: status, liveness, secret presence. */
  view(row: SourceRow): SourceStatusView {
    return {
      ...row,
      status: this.statusOf(row),
      managed: this.engines.has(row.id),
      host_token_present: envVarPresent(row.host_token_env),
      webhook_secret_present: envVarPresent(row.webhook_secret_env),
    };
  }

  statusOf(row: SourceRow): SyncStatus {
    const m = this.engines.get(row.id);
    if (m) return m.engine.status();
    return (
      this.latest.get(row.id) ?? {
        source: row.id,
        state: 'idle',
        ahead: 0,
        behind: 0,
        dirty_paths: [],
        conflicted_paths: [],
        last_synced_at: row.last_synced_at,
        last_error: row.last_error,
      }
    );
  }

  /** Live (not soft-deleted) items per `pages.source_id`, in one query. */
  private async itemCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('pages')
      .select((eb) => ['source_id', eb.fn.countAll<number>().as('n')])
      .where('source_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('source_id')
      .execute();
    return new Map(rows.map((r) => [r.source_id!, Number(r.n)]));
  }

  /**
   * The commit this source's working tree is on, or null. Only a directory that
   * is itself a repository is asked: `git -C` walks UP to the nearest enclosing
   * repository, so a missing clone under a content root that happens to sit in
   * a checkout would otherwise report that checkout's HEAD as the source's.
   */
  private async headOf(row: SourceRow): Promise<SourceHead | null> {
    const dir = resolveLocalDir(row.local_dir, this.paths.root);
    if (!existsSync(join(dir, '.git'))) return null;
    try {
      const out = await runGit(dir, ['log', '-1', '--format=%H%x1f%cI'], { timeoutMs: HEAD_TIMEOUT_MS });
      const [sha, committedAt] = out.split(FIELD_SEP);
      if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha.trim())) return null;
      return { sha: sha.trim(), committed_at: committedAt?.trim() || null };
    } catch {
      // Unborn branch, corrupt repository, or the timeout: a blank cell, not an error.
      return null;
    }
  }

  isManaged(sourceId: string): boolean {
    return this.engines.has(sourceId);
  }

  /** Wait for any in-flight cycle (tests; a publish's background push). */
  async settle(sourceId?: string): Promise<void> {
    const pending = sourceId ? [this.inflight.get(sourceId)] : [...this.inflight.values()];
    await Promise.allSettled(pending.filter(Boolean));
  }

  // ---------------------------------------------------------------- internals

  private async engineFor(sourceId: string): Promise<Managed> {
    const existing = this.engines.get(sourceId);
    if (existing) return existing;
    const row = await this.registry.get(sourceId);
    if (!row) throw new NotFoundException(`Source ${sourceId} is not registered`);
    if (!isSyncable(row)) throw new BadRequestException(`Source ${sourceId} is disabled or has no remote`);
    return this.start(row);
  }

  private async start(row: SourceRow): Promise<Managed> {
    const ref = this.registry.toSourceRef(row, this.paths.root);
    const repo = new LocalGitRepo(ref.local);
    await prepareRepo(repo, row);
    const engine = new SyncEngine({
      source: ref,
      repo,
      policy: ref.policy,
      pushIntervalMs: DEFAULT_PUSH_INTERVAL_MS,
      branch: row.branch ?? undefined,
      hooks: {
        onChangedPaths: async (changes) => {
          const fresh = (await this.registry.get(row.id)) ?? row;
          await this.inbound.applyChanges(fresh, changes);
        },
        onConflict: (paths) => this.conflicts.record(row.id, repo, paths),
        onStatus: (status) => this.latest.set(row.id, status),
        log: (level, msg) => (level === 'error' ? this.logger.error(msg) : level === 'warn' ? this.logger.warn(msg) : this.logger.log(msg)),
      },
    });
    const m: Managed = { row, repo, engine, timer: null };
    this.engines.set(row.id, m);
    if (this.mirror instanceof RoutingRevisionMirror) this.mirror.setManaged(row.id, true);
    if (this.active) {
      const everyMs = (row.sync_every_seconds ?? loadServerConfig().sync.every) * 1000;
      m.timer = setInterval(() => void this.runNow(row.id).catch(() => undefined), everyMs);
      m.timer.unref?.();
      this.logger.log(`[sync:${row.id}] ${row.mode} · ${row.remote_url} · every ${everyMs / 1000}s`);
    }
    return m;
  }

  private stop(sourceId: string): void {
    const m = this.engines.get(sourceId);
    if (!m) return;
    if (m.timer) clearInterval(m.timer);
    m.engine.stop();
    this.engines.delete(sourceId);
    if (this.mirror instanceof RoutingRevisionMirror) this.mirror.setManaged(sourceId, false);
  }

  /** Merge detection for the `review` policy; a host that cannot be reached never blocks the cycle. */
  private async reconcileReviews(m: Managed): Promise<void> {
    if (m.row.mode !== 'review') return;
    const fresh = (await this.registry.get(m.row.id)) ?? m.row;
    try {
      await this.reviews.reconcile(fresh, m.repo, (changes) => this.inbound.applyChanges(fresh, changes));
    } catch (err) {
      this.logger.warn(`[sync:${m.row.id}] review reconciliation failed: ${errMessage(err)}`);
    }
  }

  /** Commit whatever the debounced committer still holds for this repo so the merge/push sees it. */
  private async flushMirror(m: Managed): Promise<void> {
    if (this.mirror instanceof RoutingRevisionMirror) await this.mirror.flushRepo(m.repo.dir);
  }

  private async persist(m: Managed, status: SyncStatus): Promise<SyncStatus> {
    await this.registry
      .recordSync(m.row.id, { at: status.last_synced_at ?? undefined, error: status.last_error })
      .catch(() => undefined);
    return status;
  }

  private serialize<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.inflight.get(sourceId) ?? Promise.resolve();
    const next = prev.then(work, work);
    this.inflight.set(sourceId, next.catch(() => undefined));
    return next;
  }
}

function isSyncable(row: SourceRow): boolean {
  return row.enabled === 1 && Boolean(row.remote_url);
}

function sameConfig(a: SourceRow, b: SourceRow): boolean {
  return (
    a.local_dir === b.local_dir &&
    a.remote_url === b.remote_url &&
    a.branch === b.branch &&
    a.mode === b.mode &&
    a.role === b.role &&
    a.sync_every_seconds === b.sync_every_seconds
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
