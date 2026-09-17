/**
 * System health (plan §5, issue 71): the operational-health report behind
 * `GET /admin/health/system`, and the bounded readiness probe behind `/readyz`.
 *
 * It answers "is this instance healthy right now?" — a different question from
 * Content health's "what in the library needs fixing", asked by the same person
 * at a different moment. Per §5 it deliberately does NOT call
 * `ContentHealthService.report()`: that report renders the whole library to OKF
 * and audits it on every request, and the two must not share a cost.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { BackupDrillStatus } from '@echozedlabs/knowledge-types';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { loadServerConfig } from '../config/server-config.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { SyncService, type SourceStatusView } from '../sync/sync.service.js';
import { BACKUP_DRILL_STATUS, NEVER_DRILLED, type BackupDrillStatusPort } from './backup-drill.port.js';
import {
  checkConflicts,
  checkContentRoot,
  checkDatabase,
  checkDisk,
  checkGitOutbox,
  checkMirrorState,
  checkRestoreDrill,
  checkSchema,
  checkSecrets,
  checkSources,
  readMirror,
} from './checks.js';
import {
  verdictOf,
  type SystemCheck,
  type SystemCheckId,
  type SystemHealthReport,
} from './system-health.types.js';

/**
 * The subset `/readyz` runs (item 13).
 *
 * Readiness is the narrow question "can this instance serve requests CORRECTLY
 * right now", not the broad "is everything well". These three are the ones
 * whose failure means every request is wrong or refused:
 *
 *  - `database`     — nothing is served without it.
 *  - `schema`       — a process holding a database it was not built for answers
 *                     500s, and this is the signal a botched restore produces.
 *                     `/healthz` cannot see it; that is why item 13 exists.
 *  - `content_root` — every publish writes the canonical file FIRST, so a
 *                     missing root is a write path that cannot complete.
 *
 * Everything else is deliberately out — see the class doc on `readiness()`.
 */
export const READINESS_CHECKS: readonly SystemCheckId[] = ['database', 'schema', 'content_root'];

@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger(SystemHealthService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly paths: ContentPathResolver,
    private readonly sync: SyncService,
    @Optional() @Inject(BACKUP_DRILL_STATUS) private readonly drill: BackupDrillStatusPort | null = null,
  ) {}

  /** The full admin report: every check, deep, plus the single verdict over them. */
  async report(now = new Date()): Promise<SystemHealthReport> {
    const root = this.paths.root;
    const cfg = loadServerConfig();
    const sources = await this.sources();

    const checks: SystemCheck[] = [
      await this.guard('database', 'Database', () => checkDatabase(this.db, { deep: true })),
      await this.guard('schema', 'Migrations applied', () => checkSchema(this.db)),
      await this.guard('content_root', 'Content root', () => checkContentRoot(root, { deep: true })),
      await this.guard('disk', 'Disk headroom', () => checkDisk(root)),
      await this.guard('sources', 'Sources', () =>
        checkSources(sources, { contentRoot: root, defaultSyncSeconds: cfg.sync.every, now }),
      ),
      await this.guard('secrets', 'Secrets', () => checkSecrets(sources, process.env)),
      ...(await this.mirrorChecks(now)),
      await this.guard('conflicts', 'Merge conflicts', () => checkConflicts(this.db)),
      await this.guard('restore_drill', 'Restore drill', async () => checkRestoreDrill(await this.drillStatus(), now)),
    ];

    return { verdict: verdictOf(checks), checked_at: now.toISOString(), checks };
  }

  /**
   * `/readyz`'s answer: the {@link READINESS_CHECKS} subset, run shallow.
   *
   * What is deliberately NOT here, and why — readiness pulls an instance out of
   * rotation, and every one of these would do that for something a restart
   * cannot fix and a running instance still serves through:
   *
   *  - **Disk headroom** — low disk is a statement about the near future, not
   *    an inability to answer now. Evicting the instance makes the outage
   *    happen sooner rather than later.
   *  - **Sources / sync lateness** — §5 is explicit: a source behind on its
   *    fetch still serves every page it has already indexed.
   *  - **Secrets** — a missing host token stops one source pushing; reads are
   *    unaffected, and no load balancer can help.
   *  - **Git mirror backlog and mirror errors** — the content is written and
   *    indexed; only the commit behind it is late. Serving is correct.
   *  - **Merge conflicts** — one source stops exchanging content; the instance
   *    keeps answering from the index.
   *  - **Restore drill** — a statement about the past. An instance that has
   *    never rehearsed a restore is unverified, not unable.
   *
   * Nothing here is reported to the caller. `/readyz` is `@Public()` because a
   * load balancer cannot authenticate, so it returns a bare status and an HTTP
   * code; the detail lives behind `@AdminOnly()` on `/admin/health/system`.
   */
  async readiness(): Promise<{ ready: boolean }> {
    const root = this.paths.root;
    const checks = await Promise.all([
      this.guard('database', 'Database', () => checkDatabase(this.db, { deep: false })),
      this.guard('schema', 'Migrations applied', () => checkSchema(this.db)),
      this.guard('content_root', 'Content root', () => checkContentRoot(root, { deep: false })),
    ]);
    const failed = checks.filter((c) => c.state === 'fail');
    if (failed.length > 0) {
      // Logged, never returned: the operator needs the reason and the anonymous
      // caller must not have it.
      this.logger.warn(`not ready: ${failed.map((c) => `${c.id} — ${c.summary}`).join('; ')}`);
    }
    return { ready: failed.length === 0 };
  }

  // ---------------------------------------------------------------- internals

  private async sources(): Promise<SourceStatusView[]> {
    try {
      return await this.sync.statuses();
    } catch (err) {
      this.logger.warn(`source statuses unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** The two mirror rows share one `mirrorHealth()` pass. */
  private async mirrorChecks(now: Date): Promise<SystemCheck[]> {
    try {
      const mirror = await readMirror(this.db, now);
      return [checkGitOutbox(mirror), checkMirrorState(mirror)];
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`mirror health failed: ${detail}`);
      return [
        crashed('git_outbox', 'Git mirror backlog', detail),
        crashed('mirror_state', 'Git mirror errors', detail),
      ];
    }
  }

  /**
   * An absent producer reports `never`, not "unknown" — see backup-drill.port.ts.
   * The producer is a separate module; this one depends only on the contract.
   */
  private async drillStatus(): Promise<BackupDrillStatus> {
    if (!this.drill) return NEVER_DRILLED;
    try {
      return await this.drill.status();
    } catch (err) {
      this.logger.warn(`restore drill status unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return NEVER_DRILLED;
    }
  }

  /**
   * A check that throws must not take the page down with it: a health report
   * that 500s tells an operator nothing at exactly the moment they need it.
   * The thrown check becomes its own `fail` row and the rest still render.
   */
  private async guard(id: SystemCheckId, title: string, run: () => Promise<SystemCheck> | SystemCheck): Promise<SystemCheck> {
    try {
      return await run();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`check ${id} threw: ${detail}`);
      return crashed(id, title, detail);
    }
  }
}

function crashed(id: SystemCheckId, title: string, detail: string): SystemCheck {
  return {
    id,
    title,
    state: 'fail',
    summary: 'This check could not run.',
    action: 'Read the server log for the full error; the check itself failed, so its subject is unknown.',
    link: null,
    evidence: [detail],
  };
}
