import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely } from 'kysely';
import { parse } from '@echozedlabs/codec';
import { pageToConcept, renderBundleIndex, type BundleIndexEntry, type PageInput } from '@echozedlabs/okf';
import type { Database } from '../db/schema.js';
import type { RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

const execFileAsync = promisify(execFile);

/** Quiet period after the last write before a commit fires (coalesces bursts). */
const DEFAULT_QUIET_MS = 2_000;
/** Hard cap so a steady write stream still commits within this window. */
const DEFAULT_MAX_MS = 15_000;

interface Pending {
  path: string;
  versionToken: number;
  /** Who made this edit — used to attribute the git commit to the real author. */
  actorId: string;
}

/** Git author identity for a commit. */
interface GitIdentity {
  name: string;
  email: string;
}

const SYSTEM_IDENTITY: GitIdentity = { name: 'Knowledge E3', email: 'knowledge-e3@localhost' };

export interface MirrorOptions {
  quietMs?: number;
  maxMs?: number;
  /** Remote git URL to push to after each commit/flush. Omit to keep commits local. */
  remoteUrl?: string;
  /** Branch to push to; omit to push the current branch by name. */
  branch?: string | null;
}

/**
 * Phase A of the git-of-record pivot (see docs/adr/0001-git-of-record-storage.md):
 * git as a **verified mirror** while the database stays canonical.
 *
 * Data flow per persisted version:
 *  1. Write the OKF concept file to the working tree immediately (fast, local).
 *  2. Mark `revision_mirror_state.dirty = 1` for the item.
 *  3. Enqueue a **debounced** commit — a single background committer coalesces a
 *     burst of edits into one commit on the current branch, then records the
 *     commit/watermark and clears the dirty flag.
 *
 * Best-effort by contract: the database is the source of truth in this phase, so
 * failures here never throw into the write path.
 */
export class GitRevisionMirrorAdapter implements RevisionMirrorPort, OnModuleDestroy {
  private readonly logger = new Logger(GitRevisionMirrorAdapter.name);
  private readonly dir: string;
  private readonly quietMs: number;
  private readonly maxMs: number;
  // Mutable so the router can hot-reload the remote without recreating the repo.
  private remoteUrl?: string;
  private branch?: string | null;
  private configuredRemote?: string;

  private readonly pending = new Map<string, Pending>();
  /** Assets under `assets/` changed with no concurrent page edit; force a commit. */
  private assetsDirty = false;
  private timer: NodeJS.Timeout | null = null;
  private firstEnqueueAt: number | null = null;
  /** Serializes git operations so overlapping timers/flushes never race. */
  private committing: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(dir: string, private readonly db: Kysely<Database>, opts: MirrorOptions = {}) {
    this.dir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    this.remoteUrl = opts.remoteUrl;
    this.branch = opts.branch;
  }

  /** Port entry point — single-repo use writes a flat `concepts/` bundle. */
  async afterItemVersionPersisted(event: RevisionMirrorEvent): Promise<void> {
    await this.enqueue(event, 'concepts');
  }

  /**
   * Write a concept into this repo under `conceptDir` (e.g. `concepts` for a
   * dedicated/root bundle, or `<topic>/concepts` for a topic subtree in a shared
   * repo), then schedule a debounced commit. Best-effort: never throws.
   */
  async enqueue(event: RevisionMirrorEvent, conceptDir: string): Promise<void> {
    try {
      await this.ensureRepo();
      const spaceName = await this.resolveSpaceName(event.spaceId);
      const concept = pageToConcept(toPageInput(event, spaceName), () => undefined, {
        linkStyle: 'preserve',
        conceptDir,
      });
      const abs = join(this.dir, concept.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, concept.content, 'utf8');

      this.pending.set(event.itemId, {
        path: concept.path,
        versionToken: event.versionToken,
        actorId: event.actorId,
      });
      await this.markDirty(event.itemId, concept.path, event.versionToken);
      this.scheduleCommit();
    } catch (err) {
      // Best-effort: never throw into the write path.
      this.logger.warn(`git mirror write failed for ${event.slug}: ${errMessage(err)}`);
      await this.recordError(event.itemId, err).catch(() => undefined);
    }
  }

  /**
   * An asset (image/attachment) was written to or removed from `assets/`.
   * Schedule a commit so the change reaches git even when no page edit is
   * pending — otherwise uploaded bytes never become durable and deletions never
   * stick across a rebuild (ADR-0003, phase 2). Best-effort: never throws.
   */
  async notifyAssetsChanged(): Promise<void> {
    this.assetsDirty = true;
    this.scheduleCommit();
  }

  /** Point this repo at a remote (or clear it). Applied on the next commit/flush. */
  setRemote(remoteUrl: string | null, branch: string | null): void {
    this.remoteUrl = remoteUrl ?? undefined;
    this.branch = branch;
  }

  /**
   * Commit anything pending, then push the current HEAD. The extra push (beyond
   * the one in doCommit) makes "Sync now" work when content is already committed
   * locally but the remote was configured later — there's no new commit to ride.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.commitNow();
    await this.pushNow();
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush().catch(() => undefined);
  }

  // --- internals -----------------------------------------------------------

  private async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, '.git'))) {
      await this.git(['init']);
      // Ensure commits succeed even where no global identity is configured.
      await this.git(['config', 'user.email', 'knowledge-e3@localhost']);
      await this.git(['config', 'user.name', 'Knowledge E3']);
    }
    this.initialized = true;
  }

  /** Idempotently point `origin` at the current remote (supports hot-reload). */
  private async ensureRemote(): Promise<void> {
    if (!this.remoteUrl || this.remoteUrl === this.configuredRemote) return;
    await this.git(['remote', 'add', 'origin', this.remoteUrl]).catch(() =>
      this.git(['remote', 'set-url', 'origin', this.remoteUrl!]),
    );
    this.configuredRemote = this.remoteUrl;
  }

  /** Push to the configured remote after a commit. Best-effort: never throws. */
  private async pushNow(): Promise<void> {
    if (!this.remoteUrl || !existsSync(join(this.dir, '.git'))) return;
    await this.ensureRemote();
    const refspec = this.branch ? `HEAD:${this.branch}` : 'HEAD';
    try {
      await this.git(['push', 'origin', refspec]);
    } catch (err) {
      this.logger.warn(`git mirror push failed for ${this.dir}: ${errMessage(err)}`);
    }
  }

  private scheduleCommit(): void {
    const now = Date.now();
    if (this.firstEnqueueAt === null) this.firstEnqueueAt = now;
    this.clearTimer();
    if (now - this.firstEnqueueAt >= this.maxMs) {
      void this.commitNow();
      return;
    }
    this.timer = setTimeout(() => void this.commitNow(), this.quietMs);
    // Don't keep the process alive solely for a pending commit.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private commitNow(): Promise<void> {
    this.committing = this.committing.then(() => this.doCommit());
    return this.committing;
  }

  private async doCommit(): Promise<void> {
    this.clearTimer();
    this.firstEnqueueAt = null;
    const batch = [...this.pending.entries()];
    // Capture and clear the assets flag alongside the page batch, so a change
    // arriving mid-commit re-arms rather than being lost. Nothing to do only
    // when there is neither a page edit nor an asset change.
    const assetsDirty = this.assetsDirty;
    this.assetsDirty = false;
    if (batch.length === 0 && !assetsDirty) return;
    this.pending.clear();

    try {
      await this.ensureRepo();
      // Attribute history to the real editor: commit each actor's files under
      // their own git author, so a rebuild can replay `created_by` faithfully.
      // A same-actor burst still collapses into a single commit (the common case).
      const byActor = groupByActor(batch);
      const identities = await this.resolveIdentities([...byActor.keys()]);
      const now = new Date().toISOString();

      // The bundle index is derived from the concept files, so regenerate it
      // only when concepts actually changed — an assets-only commit must not
      // rewrite (or, on a fresh repo, create) index.md.
      if (batch.length > 0) {
        // Keep the repo a *conformant OKF bundle*: refresh the root index up
        // front so it folds into the first content commit rather than a noisy
        // separate one.
        this.writeBundleIndex();
        // Stage uploaded images so they ride the content commit and land in the
        // bundle (no-op when there's no assets dir, e.g. dedicated topic repos).
        await this.git(['add', '--', 'assets']).catch(() => undefined);
      }
      let indexPending = batch.length > 0;
      let committed = false;

      for (const [actorId, items] of byActor) {
        const paths = items.map(([, p]) => p.path);
        await this.git(['add', '--', ...paths]);
        if (indexPending) await this.git(['add', '--', 'index.md']);
        const checkPaths = indexPending ? [...paths, 'index.md'] : paths;
        const status = (await this.git(['status', '--porcelain', '--', ...checkPaths])).trim();
        if (status === '') continue; // nothing changed for this actor (or the index)

        const who = identities.get(actorId) ?? SYSTEM_IDENTITY;
        await this.git([
          'commit',
          `--author=${who.name} <${who.email}>`,
          '-m',
          commitMessage(items.length),
        ]);
        indexPending = false; // the index (if it changed) is now committed
        committed = true;
        const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
        const ref = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        for (const [itemId, p] of items) {
          await this.markSynced(itemId, p, sha, ref, now);
        }
      }

      // If no content commit landed but the index still changed, commit it alone.
      if (indexPending) {
        await this.git(['add', '--', 'index.md']);
        const status = (await this.git(['status', '--porcelain', '--', 'index.md'])).trim();
        if (status !== '') {
          await this.git(['commit', '-m', 'knowledge-e3: update bundle index']);
          committed = true;
        }
      }

      // Asset-only changes: an upload/delete with no concurrent page edit. When a
      // page edit was present, its commit above already swept in the staged
      // `assets/` (so this is a no-op then). Attribute to the system identity —
      // assets are bundle files, not authored OKF concepts.
      if (assetsDirty) {
        await this.git(['add', '--all', '--', 'assets']).catch(() => undefined);
        const status = (await this.git(['status', '--porcelain', '--', 'assets'])).trim();
        if (status !== '') {
          await this.git(['commit', '-m', 'knowledge-e3: update assets']);
          committed = true;
        }
      }

      // Push to the backend repo after committing (ADR-0001 multi-repo). Best-effort.
      if (committed) await this.pushNow();
    } catch (err) {
      // Re-queue the batch so a later write/flush retries it; record the error.
      for (const [itemId, p] of batch) this.pending.set(itemId, p);
      if (assetsDirty) this.assetsDirty = true; // re-arm the asset commit too
      this.logger.warn(`git mirror commit failed: ${errMessage(err)}`);
      for (const [itemId] of batch) await this.recordError(itemId, err).catch(() => undefined);
    }
  }

  /** Resolve each actor id to a git author identity (username + email). */
  private async resolveIdentities(actorIds: string[]): Promise<Map<string, GitIdentity>> {
    const out = new Map<string, GitIdentity>();
    if (actorIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'email'])
      .where('id', 'in', actorIds)
      .execute();
    for (const r of rows) {
      out.set(r.id, { name: r.username || 'Knowledge E3', email: r.email || SYSTEM_IDENTITY.email });
    }
    return out;
  }

  /**
   * Regenerate the bundle-root `index.md` (with `okf_version`) from the concept
   * files in the working tree — so a clone of this repo is always a conformant
   * OKF bundle. Conformance issues are logged best-effort; the emitter guarantees
   * a `type` on every concept by construction. Staging/committing is handled by
   * the caller so the index folds into a content commit.
   */
  private writeBundleIndex(): void {
    const { entries, issues } = this.scanConcepts();
    for (const issue of issues) this.logger.warn(`OKF conformance: ${issue}`);

    const content = renderBundleIndex(entries, {
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Knowledge E3 — git-of-record bundle in Open Knowledge Format.',
    });
    writeFileSync(join(this.dir, 'index.md'), content, 'utf8');
  }

  /**
   * Read every concept file once: build the index entries (sorted for a stable
   * bundle) and check OKF conformance (non-empty `type`) in the same pass. Walks
   * recursively so it covers both a flat `concepts/` bundle and topic subtrees
   * (`<topic>/concepts/*.md`) in a shared repo.
   */
  private scanConcepts(): { entries: BundleIndexEntry[]; issues: string[] } {
    const entries: BundleIndexEntry[] = [];
    const issues: string[] = [];
    for (const relPath of conceptFilesUnder(this.dir).sort()) {
      const parsed = parse(readFileSync(join(this.dir, relPath), 'utf8'));
      const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
      const type = fm['type'];
      if (typeof type !== 'string' || type.trim() === '') {
        issues.push(`${relPath} has no \`type\` (OKF requires one)`);
      }
      entries.push({
        path: relPath,
        title: typeof fm['title'] === 'string' ? (fm['title'] as string) : undefined,
        description: typeof fm['description'] === 'string' ? (fm['description'] as string) : undefined,
      });
    }
    return { entries, issues };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.dir });
    return stdout;
  }

  /**
   * Export a human space *name*, not the internal `space_*` id, so a rebuild's
   * `ensureSpace` resolves it back to the same space (slugifying the id would
   * mint a divergent one). Returns null for the default space / no space.
   */
  private async resolveSpaceName(spaceId: string | null): Promise<string | null> {
    if (!spaceId || spaceId === 'space_default') return null;
    const row = await this.db
      .selectFrom('spaces')
      .select('name')
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return row?.name ?? null;
  }

  private async markDirty(pageId: string, path: string, versionToken: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto('revision_mirror_state')
      .values({
        page_id: pageId,
        backend: 'git',
        path,
        last_synced_version_token: null,
        last_commit: null,
        last_ref: null,
        dirty: 1,
        error: null,
        created_at: now,
        updated_at: now,
        last_synced_at: null,
      })
      .onConflict((oc) =>
        oc.column('page_id').doUpdateSet({ backend: 'git', path, dirty: 1, updated_at: now }),
      )
      .execute();
  }

  private async markSynced(
    pageId: string,
    p: Pending,
    sha: string,
    ref: string,
    now: string,
  ): Promise<void> {
    await this.db
      .updateTable('revision_mirror_state')
      .set({
        last_commit: sha,
        last_ref: ref,
        last_synced_version_token: p.versionToken,
        dirty: 0,
        error: null,
        updated_at: now,
        last_synced_at: now,
      })
      .where('page_id', '=', pageId)
      .execute();
  }

  private async recordError(pageId: string, err: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('revision_mirror_state')
      .set({ error: errMessage(err).slice(0, 500), updated_at: now })
      .where('page_id', '=', pageId)
      .execute();
  }
}

function toPageInput(event: RevisionMirrorEvent, space: string | null): PageInput {
  return {
    id: event.itemId,
    slug: event.slug,
    title: event.title,
    status: event.status,
    space,
    ownerId: event.ownerId,
    tags: event.tags,
    categories: event.categories,
    groups: event.groups,
    rawMarkdown: event.rawMarkdown,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

/**
 * Relative paths of every concept file in a working tree: any `*.md` whose parent
 * directory is named `concepts` (so `concepts/x.md` and `<topic>/concepts/x.md`
 * both match), excluding `.git`. Paths use forward slashes.
 */
function conceptFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(abs, entry.name), childRel);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        (rel.endsWith('/concepts') || rel === 'concepts')
      ) {
        out.push(childRel);
      }
    }
  };
  walk(root, '');
  return out;
}

/** Partition a pending batch by editor, preserving insertion order. */
function groupByActor(batch: [string, Pending][]): Map<string, [string, Pending][]> {
  const out = new Map<string, [string, Pending][]>();
  for (const entry of batch) {
    const actorId = entry[1].actorId;
    const group = out.get(actorId);
    if (group) group.push(entry);
    else out.set(actorId, [entry]);
  }
  return out;
}

function commitMessage(count: number): string {
  return `knowledge-e3: mirror ${count} item${count === 1 ? '' : 's'}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
