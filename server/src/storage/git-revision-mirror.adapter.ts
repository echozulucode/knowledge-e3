import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely } from 'kysely';
import { parse } from '@echozedlabs/codec';
import { renderBundleIndex, isContentUnchanged, parseBundleIndex, type BundleIndexEntry, type BundleLink } from '@echozedlabs/okf';
import { digestOf } from '@echozedlabs/content-store';
import { redactSecrets, resolveGitCredential, type GitCredentialRef } from '@echozedlabs/repo-sync';
import type { Database } from '../db/schema.js';
import type { SpaceView } from '../taxonomy/spaces.service.js';
import { exportSpaceName, pageLikeFromEvent, renderConceptFile } from './render-concept.js';
import type { RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

const execFileAsync = promisify(execFile);

/** Quiet period after the last write before a commit fires (coalesces bursts). */
const DEFAULT_QUIET_MS = 2_000;
/** Hard cap so a steady write stream still commits within this window. */
const DEFAULT_MAX_MS = 15_000;
/** Do not let process termination wait indefinitely for a remote Git operation. */
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 10_000;

/** Commit order for the two kinds of removal; the two never share a commit. */
const REMOVAL_REASONS = ['move', 'delete'] as const;

interface Pending {
  path: string;
  versionToken: number;
  /** Who made this edit — used to attribute the git commit to the real author. */
  actorId: string;
  /**
   * This write is the arrival half of a topic move (plan §8.3): the commit
   * message carries the item id so the departure in the other repo can be
   * matched to it by eye or by tooling.
   */
  movedIn?: boolean;
}

/**
 * Why a file stopped being tracked in THIS repo: the item moved to another
 * topic (possibly another repository), or it was deleted. The commit message
 * differs, so the reason travels with the pending entry.
 */
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/** A file to stop tracking in THIS repo: a departure, or a deletion. */
interface PendingRemoval extends Pending {
  itemId: string;
  reason: RemovalReason;
}

/** One file a commit pass confirmed, reported through {@link MirrorOptions.onCommitted}. */
export interface MirroredFile {
  itemId: string;
  /** Repo-relative path that was committed; `null` when the mirror has no repo. */
  path: string | null;
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
  /** Lifecycle-only flush bound; explicit sync/flush calls remain unbounded. */
  shutdownFlushTimeoutMs?: number;
  /** Remote git URL to push to after each commit/flush. Omit to keep commits local. */
  remoteUrl?: string;
  /** Branch to push to; omit to push the current branch by name. */
  branch?: string | null;
  /**
   * NAMES of the git credential this repo's pushes authenticate with (issue
   * 122) — `host_token_env` and `host_kind` from the source's registry row,
   * never a token. Omit to fall back to the instance-wide `GIT_HTTPS_TOKEN`.
   */
  credential?: GitCredentialRef | null;
  /**
   * Push after every commit and on `flush()` (default true). `false` for a
   * source the `SyncService` manages: commits stay local and the sync engine
   * pushes on publish or every five minutes (plan §12 decision 1).
   */
  pushOnCommit?: boolean;
  /**
   * Called after a successful commit pass with every item/path the pass
   * confirmed (committed, or found already at HEAD) and the pass's timestamp —
   * the write-first outbox marks its rows processed here. The path matters for
   * a move: the two repos confirm different paths for the same item, so only
   * the row for the path this repo committed may settle. Default: no-op.
   */
  onCommitted?: (committed: MirroredFile[], at: string) => Promise<void>;
}

/**
 * Phase A of the git-of-record pivot (see ADR-0001): git as a **verified
 * mirror** while the database stays canonical.
 *
 * Data flow per persisted version:
 *  1. Write the OKF concept file to the working tree immediately (fast, local) —
 *     unless it is already there byte-for-byte, which is the normal case since
 *     the write-first command (plan §7.3) wrote it before the index landed.
 *  2. Mark `revision_mirror_state.dirty = 1` for the item.
 *  3. Enqueue a **debounced** commit — a single background committer coalesces a
 *     burst of edits into one commit on the current branch, then records the
 *     commit/watermark, clears the dirty flag, and reports the batch through
 *     `onCommitted` so the outbox can mark its rows processed.
 *
 * Best-effort by contract: git never sits in the request path, so failures here
 * never throw into the write path.
 */
export class GitRevisionMirrorAdapter implements RevisionMirrorPort, OnModuleDestroy {
  private readonly logger = new Logger(GitRevisionMirrorAdapter.name);
  private readonly dir: string;
  private readonly quietMs: number;
  private readonly maxMs: number;
  private readonly shutdownFlushTimeoutMs: number;
  // Mutable so the router can hot-reload the remote without recreating the repo.
  private remoteUrl?: string;
  private branch?: string | null;
  private credential?: GitCredentialRef | null;
  private pushOnCommit: boolean;
  private configuredRemote?: string;
  private readonly onCommitted?: (committed: MirroredFile[], at: string) => Promise<void>;

  private readonly pending = new Map<string, Pending>();
  /** Files whose removal this repo still has to commit, keyed by path (unique per repo). */
  private readonly pendingRemovals = new Map<string, PendingRemoval>();
  /** Assets under `assets/` changed with no concurrent page edit; force a commit. */
  private assetsDirty = false;
  /**
   * Who dirtied `assets/` in the current window. A commit has exactly one
   * author, so this attributes the asset commit only when the whole window
   * belongs to one person; a window mixing uploaders (or one with no actor at
   * all, e.g. a rebuild healing missing bytes) keeps the system identity rather
   * than crediting an edit to somebody who did not make all of it.
   */
  private assetActors = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private firstEnqueueAt: number | null = null;
  /** Serializes git operations so overlapping timers/flushes never race. */
  private committing: Promise<void> = Promise.resolve();
  private initialized = false;
  /**
   * In-flight `ensureRepo` work, shared by every concurrent caller, so a
   * brand-new repo is initialized exactly once no matter how many writes
   * arrive together. `git init` happens to be idempotent, so this is a
   * hygiene guarantee rather than a fix for an observed failure — see the
   * test below and issue 88.
   */
  private initializing: Promise<void> | null = null;
  /** Shared by every Git subprocess so a bounded shutdown can terminate it. */
  private readonly gitAbortController = new AbortController();

  constructor(dir: string, private readonly db: Kysely<Database>, opts: MirrorOptions = {}) {
    this.dir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    this.shutdownFlushTimeoutMs = opts.shutdownFlushTimeoutMs ?? DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    this.remoteUrl = opts.remoteUrl;
    this.branch = opts.branch;
    this.credential = opts.credential;
    this.pushOnCommit = opts.pushOnCommit ?? true;
    this.onCommitted = opts.onCommitted;
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
  async enqueue(event: RevisionMirrorEvent, conceptDir: string, opts: { movedIn?: boolean } = {}): Promise<void> {
    try {
      await this.ensureRepo();
      const spaceName = await exportSpaceName(this.db, event.spaceId);
      const concept = renderConceptFile(pageLikeFromEvent(event), spaceName, conceptDir);
      const abs = join(this.dir, concept.path);
      // Content no-op guard: if the concept file already holds identical content
      // (ignoring trailing-whitespace / final-newline noise), skip the write so a
      // metadata-only touch or a rebuild doesn't churn the file. This is also the
      // normal write-first case — the command already wrote these exact bytes —
      // so the commit is still scheduled; the committer skips it when git sees
      // no change. (openwiki's content-hash guard, applied here.)
      const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
      if (!isContentUnchanged(existing, concept.content)) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, concept.content, 'utf8');
        await this.reconcileFileDigest(event.itemId, concept.path, concept.content);
      }

      this.pending.set(event.itemId, {
        path: concept.path,
        versionToken: event.versionToken,
        actorId: event.actorId,
        // Sticky within an uncommitted batch: once this batch carries the
        // arrival of a move, a later plain edit of the same item must not drop
        // the `e3-move-in` trailer the commit owes it.
        movedIn: opts.movedIn === true || this.pending.get(event.itemId)?.movedIn === true,
      });
      // The commit is scheduled even when the bookkeeping write fails: a
      // revision_mirror_state error degrades bookkeeping, never the commit the
      // file on disk is owed (issue 101). The catch below still records it.
      try {
        await this.markDirty(event.itemId, concept.path, event.versionToken);
      } finally {
        this.scheduleCommit();
      }
    } catch (err) {
      // Best-effort: never throw into the write path.
      this.logger.warn(`git mirror write failed for ${event.slug}: ${errMessage(err)}`);
      await this.recordError(event.itemId, err).catch(() => undefined);
    }
  }

  /**
   * A file this repo must stop tracking: the departure half of a topic move
   * (plan §8.3, `reason: 'move'`) or a soft delete (issue 76,
   * `reason: 'delete'`). Either way the write-first command has already
   * unlinked the file; the delete below is idempotent belt-and-braces for a
   * replay. The commit message carries the item id — for a move so the
   * departure and the arrival commit in the other repo can be matched, for a
   * deletion so the log records which item left and why.
   *
   * `revision_mirror_state` is deliberately NOT touched: that row now describes
   * the repo the item moved INTO, and the arrival's `markSynced` owns it.
   * Best-effort, like every other path here: never throws into the write path.
   */
  async enqueueRemoval(
    ev: { itemId: string; path: string; actorId: string; versionToken: number },
    reason: RemovalReason = 'move',
  ): Promise<void> {
    try {
      await this.ensureRepo();
      const abs = join(this.dir, ev.path);
      if (existsSync(abs)) rmSync(abs, { force: true });
      // A write of this very path that has not committed yet is moot: the file
      // is gone, and `git add`-ing a path that was never tracked and no longer
      // exists fails the whole commit pass. (An edit followed immediately by a
      // delete, inside one debounce window.) The removal entry below settles
      // that write's outbox row too — they share the path.
      if (this.pending.get(ev.itemId)?.path === ev.path) this.pending.delete(ev.itemId);
      this.pendingRemovals.set(ev.path, {
        itemId: ev.itemId,
        path: ev.path,
        versionToken: ev.versionToken,
        actorId: ev.actorId,
        reason,
      });
      this.scheduleCommit();
    } catch (err) {
      this.logger.warn(`git mirror removal failed for ${ev.path}: ${errMessage(err)}`);
      await this.recordError(ev.itemId, err).catch(() => undefined);
    }
  }

  /**
   * An asset (image/attachment) was written to or removed from `assets/`.
   * Schedule a commit so the change reaches git even when no page edit is
   * pending — otherwise uploaded bytes never become durable and deletions never
   * stick across a rebuild (ADR-0003, phase 2). Best-effort: never throws.
   */
  async notifyAssetsChanged(actorId?: string): Promise<void> {
    this.assetsDirty = true;
    // A signal with no actor joins the window as the empty id, which resolves to
    // no user — so it poisons attribution for the whole window exactly like a
    // second uploader would, instead of letting one named uploader take credit
    // for bytes somebody (or nobody) else wrote.
    this.assetActors.add(actorId ?? '');
    this.scheduleCommit();
  }

  /**
   * Point this repo at a remote (or clear it). Applied on the next commit/flush.
   *
   * `credential` travels with the remote because the two belong together: one
   * routing mirror serves every source, so re-pointing the repo without
   * re-pointing the credential is how one source would end up pushing with
   * another's token (issue 122).
   */
  setRemote(remoteUrl: string | null, branch: string | null, credential?: GitCredentialRef | null): void {
    this.remoteUrl = remoteUrl ?? undefined;
    this.branch = branch;
    this.credential = credential ?? null;
  }

  /** Whether commits (and `flush`) push; see `MirrorOptions.pushOnCommit`. */
  setPushOnCommit(value: boolean): void {
    this.pushOnCommit = value;
  }

  /**
   * Commit anything pending, then push the current HEAD. The extra push (beyond
   * the one in doCommit) makes "Sync now" work when content is already committed
   * locally but the remote was configured later — there's no new commit to ride.
   * With `pushOnCommit` off the push is the sync engine's job (`SyncService.requestPush`).
   */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.commitNow();
    if (this.pushOnCommit) await this.pushNow();
  }

  async onModuleDestroy(): Promise<void> {
    await waitForMirrorFlush(
      this.flush(),
      this.shutdownFlushTimeoutMs,
      () => this.abortShutdown(),
    ).catch((err) => {
      this.logger.warn(`shutdown git mirror flush did not complete: ${errMessage(err)}`);
    });
  }

  /** Abort any in-flight Git child process after the shutdown deadline. */
  abortShutdown(): void {
    if (!this.gitAbortController.signal.aborted) {
      this.gitAbortController.abort(new Error('git mirror shutdown deadline exceeded'));
    }
  }

  // --- internals -----------------------------------------------------------

  private ensureRepo(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    // Memoize the in-flight init so concurrent callers await one `git init`
    // rather than each starting their own. Cleared on failure so a later call
    // can retry; `initialized` latches only on success.
    this.initializing ??= this.initRepo().then(
      () => {
        this.initialized = true;
        this.initializing = null;
      },
      (err: unknown) => {
        this.initializing = null;
        throw err;
      },
    );
    return this.initializing;
  }

  private async initRepo(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, '.git'))) {
      await this.git(['init']);
      // Ensure commits succeed even where no global identity is configured.
      await this.git(['config', 'user.email', 'knowledge-e3@localhost']);
      await this.git(['config', 'user.name', 'Knowledge E3']);
    }
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
    // Departures (the source half of a move) ride the same pass: they are a
    // content change to this bundle, so they refresh index.md like any other.
    const removals: [string, PendingRemoval][] = [...this.pendingRemovals.values()].map((r) => [r.itemId, r]);
    // Capture and clear the assets flag alongside the page batch, so a change
    // arriving mid-commit re-arms rather than being lost. Nothing to do only
    // when there is neither a page edit, a departure, nor an asset change.
    const assetsDirty = this.assetsDirty;
    const assetActors = this.assetActors;
    this.assetsDirty = false;
    this.assetActors = new Set();
    if (batch.length === 0 && removals.length === 0 && !assetsDirty) return;
    this.pending.clear();
    this.pendingRemovals.clear();

    try {
      await this.ensureRepo();
      // Attribute history to the real editor: commit each actor's files under
      // their own git author, so a rebuild can replay `created_by` faithfully.
      // A same-actor burst still collapses into a single commit (the common case).
      const byActor = groupByActor(batch);
      const removalsByActor = groupByActor(removals);
      const identities = await this.resolveIdentities([
        ...new Set([...byActor.keys(), ...removalsByActor.keys(), ...assetActors]),
      ]);
      const now = new Date().toISOString();

      // The bundle index is derived from the concept files, so regenerate it
      // only when concepts actually changed — an assets-only commit must not
      // rewrite (or, on a fresh repo, create) index.md.
      const contentChanged = batch.length > 0 || removals.length > 0;
      if (contentChanged) {
        // Keep the repo a *conformant OKF bundle*: refresh the root index up
        // front so it folds into the first content commit rather than a noisy
        // separate one. A departure changes the concept set too, so it counts.
        await this.writeBundleIndex();
        // Stage uploaded images so they ride the content commit and land in the
        // bundle (no-op when there's no assets dir, e.g. dedicated topic repos).
        await this.git(['add', '--', 'assets']).catch(() => undefined);
      }
      let indexPending = contentChanged;
      let committed = false;

      for (const [actorId, items] of byActor) {
        const paths = items.map(([, p]) => p.path);
        await this.addPaths(paths);
        if (indexPending) await this.git(['add', '--', 'index.md']);
        const checkPaths = indexPending ? [...paths, 'index.md'] : paths;
        const status = (await this.git(['status', '--porcelain', '--', ...checkPaths])).trim();
        if (status === '') {
          // Nothing changed for this actor (or the index): the files already
          // sit at HEAD, so they are synced as of the current commit.
          const head = await this.headSha();
          if (head) {
            const ref = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            for (const [itemId, p] of items) await this.markSynced(itemId, p, head, ref, now);
          }
          continue;
        }

        const who = identities.get(actorId) ?? SYSTEM_IDENTITY;
        await this.git([
          'commit',
          `--author=${who.name} <${who.email}>`,
          '-m',
          commitMessage(items),
        ]);
        indexPending = false; // the index (if it changed) is now committed
        committed = true;
        const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
        const ref = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        for (const [itemId, p] of items) {
          await this.markSynced(itemId, p, sha, ref, now);
        }
      }

      // Vanished paths: stage each one (`git add` records the deletion of a
      // tracked file; a path this repo never committed has nothing to stage and
      // is skipped) and commit it under the acting identity, with the item id in
      // the message. A departure and a deletion never share a commit — the
      // subject and the trailer say which of the two the log is recording.
      for (const [actorId, group] of removalsByActor) {
        for (const reason of REMOVAL_REASONS) {
          const items = (group as [string, PendingRemoval][]).filter(([, p]) => p.reason === reason);
          if (items.length === 0) continue;
          const paths = items.map(([, p]) => p.path);
          await this.git(['add', '--', ...paths]).catch(() => undefined);
          if (indexPending) await this.git(['add', '--', 'index.md']);
          const checkPaths = indexPending ? [...paths, 'index.md'] : paths;
          const status = (await this.git(['status', '--porcelain', '--', ...checkPaths])).trim();
          if (status === '') continue;
          const who = identities.get(actorId) ?? SYSTEM_IDENTITY;
          await this.git([
            'commit',
            `--author=${who.name} <${who.email}>`,
            '-m',
            removalCommitMessage(items, reason),
          ]);
          indexPending = false;
          committed = true;
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
      // `assets/` (so this is a no-op then). An upload is an edit by a person, so
      // it is authored by them when the window belongs to exactly one resolvable
      // actor; otherwise the system identity, which is what a mixed or
      // actor-less window honestly is (§7.1 per-edit authorship).
      if (assetsDirty) {
        await this.git(['add', '--all', '--', 'assets']).catch(() => undefined);
        const status = (await this.git(['status', '--porcelain', '--', 'assets'])).trim();
        if (status !== '') {
          const who = soleIdentity(assetActors, identities);
          await this.git([
            'commit',
            `--author=${who.name} <${who.email}>`,
            '-m',
            'knowledge-e3: update assets',
          ]);
          committed = true;
        }
      }

      // Push to the backend repo after committing (ADR-0001 multi-repo). Best-effort.
      if (committed && this.pushOnCommit) await this.pushNow();
      if (this.onCommitted && contentChanged) {
        await this.onCommitted(
          [
            ...batch.map(([itemId, p]) => ({ itemId, path: p.path })),
            ...removals.map(([itemId, p]) => ({ itemId, path: p.path })),
          ],
          now,
        );
      }
    } catch (err) {
      // Re-queue the batch so a later write/flush retries it; record the error.
      for (const [itemId, p] of batch) this.pending.set(itemId, p);
      for (const [, p] of removals) this.pendingRemovals.set(p.path, p);
      if (assetsDirty) {
        this.assetsDirty = true; // re-arm the asset commit too
        // Fold the window's actors back in so the retry still knows who to
        // credit; a signal that arrived mid-commit keeps its own entry.
        for (const actorId of assetActors) this.assetActors.add(actorId);
      }
      this.logger.warn(`git mirror commit failed: ${errMessage(err)}`);
      for (const [itemId] of [...batch, ...removals]) await this.recordError(itemId, err).catch(() => undefined);
    }
  }

  /**
   * Stage `paths`. One of them can have vanished between the batch snapshot and
   * this call — a soft delete landing inside the same commit pass — and `git
   * add` of a path that is neither on disk nor tracked fails the WHOLE pass,
   * which would then re-queue the same doomed batch on every timer and wedge
   * the repo. Such a path is dropped instead; the delete's own removal entry is
   * what commits it. Any other `git add` failure still propagates.
   */
  private async addPaths(paths: string[]): Promise<void> {
    try {
      await this.git(['add', '--', ...paths]);
      return;
    } catch (err) {
      const tracked = new Set((await this.git(['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
      const stageable = paths.filter((path) => tracked.has(path) || existsSync(join(this.dir, path)));
      if (stageable.length === paths.length) throw err;
      if (stageable.length) await this.git(['add', '--', ...stageable]);
    }
  }

  /** Current HEAD sha, or null on a repo with no commits yet. */
  private async headSha(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * When this adapter (not the write-first command) rewrote the file — the
   * paths that are not yet inverted, e.g. `resyncSpace` and the replay of an
   * item that predates write-first — keep the indexed digest of a row that
   * already tracks one in step with the bytes on disk, so the next command
   * write does not report a spurious `changed_on_disk` conflict. Rows that
   * never tracked a digest stay NULL. (Rename no longer lands here: it writes
   * its files through `ContentCommandsService.rename` and the guard above
   * finds them already identical.)
   */
  private async reconcileFileDigest(pageId: string, path: string, content: string): Promise<void> {
    await this.db
      .updateTable('pages')
      .set({ file_digest: digestOf(content), file_path: path })
      .where('id', '=', pageId)
      .where('file_digest', 'is not', null)
      .execute();
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
  private async writeBundleIndex(): Promise<void> {
    const { entries, issues } = this.scanConcepts();
    for (const issue of issues) this.logger.warn(`OKF conformance: ${issue}`);

    const topic = await this.indexTopic();
    const content = renderBundleIndex(entries, {
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Knowledge E3 — git-of-record bundle in Open Knowledge Format.',
      presentation: topic?.presentation,
      startHere: topic?.start_here ?? undefined,
      landingMarkdown: topic?.landing_markdown ?? undefined,
      links: this.curatedLinks(),
    });
    writeFileSync(join(this.dir, 'index.md'), content, 'utf8');
  }

  /**
   * The curated `links:` already in this bundle's `index.md`.
   *
   * The index is *derived* from the concept files and rewritten on every content
   * commit, but the curated links are *authored* there — the one thing in the
   * file a human puts in by hand. Reading them back and re-emitting them is what
   * stops the next commit from deleting a curator's work. Best-effort: an
   * unreadable index simply means no links to carry forward.
   */
  private curatedLinks(): BundleLink[] | undefined {
    try {
      const abs = join(this.dir, 'index.md');
      return existsSync(abs) ? parseBundleIndex(readFileSync(abs, 'utf8')).links : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The topic whose presentation the root `index.md` carries. A dedicated topic
   * repo lives at `<topics>/<slug>` with a flat `concepts/` root and a repo
   * binding, so that topic is the bound one; the main (shared) repo carries the
   * default topic. Best-effort: a lookup failure leaves the index plain.
   */
  private async indexTopic(): Promise<Pick<SpaceView, 'presentation' | 'start_here' | 'landing_markdown'> | null> {
    try {
      const dedicated = existsSync(join(this.dir, 'concepts'))
        ? await this.db
            .selectFrom('spaces')
            .innerJoin('content_sources', 'content_sources.space_id', 'spaces.id')
            .select(['spaces.presentation', 'spaces.start_here', 'spaces.landing_markdown'])
            .where('spaces.slug', '=', basename(this.dir))
            .executeTakeFirst()
        : undefined;
      if (dedicated) return dedicated;
      const row = await this.db
        .selectFrom('spaces')
        .select(['presentation', 'start_here', 'landing_markdown'])
        .where('id', '=', 'space_default')
        .executeTakeFirst();
      return row ?? null;
    } catch {
      return null;
    }
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

  /**
   * One `git` call in this repo's working tree, carrying the source's own
   * transport credential (issue 122) when one is configured: the token reaches
   * the child through `GIT_ASKPASS` and its environment, never argv, never a
   * remote URL, never gitconfig. Resolved per call from the names the registry
   * stored, so nothing here holds a secret between pushes.
   */
  private async git(args: string[]): Promise<string> {
    const cred = resolveGitCredential({ ...(this.credential ?? {}), remote: this.remoteUrl ?? null });
    try {
      const { stdout } = await execFileAsync('git', cred ? [...cred.args, ...args] : args, {
        cwd: this.dir,
        signal: this.gitAbortController.signal,
        // See `runGit`: a server has no terminal to answer a credential prompt on.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(cred?.env ?? {}) },
      });
      return stdout;
    } catch (err) {
      // A failed authenticated push is logged and can reach the operator; scrub
      // the token out of whatever git printed before it travels any further.
      throw cred ? new Error(redactSecrets(errMessage(err), cred.secrets)) : err;
    }
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

/**
 * The one identity a set of actors can be committed under, or the system
 * identity. A commit names a single author: crediting a two-uploader window to
 * whichever id happened to sort first would be a fabrication, and so would
 * crediting a window that contains an unattributed signal (the empty id, which
 * never resolves to a user).
 */
function soleIdentity(actorIds: Set<string>, identities: Map<string, GitIdentity>): GitIdentity {
  if (actorIds.size !== 1) return SYSTEM_IDENTITY;
  const [only] = actorIds;
  return identities.get(only!) ?? SYSTEM_IDENTITY;
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

/**
 * `knowledge-e3: mirror N items`, plus one `e3-move-in:` trailer per item that
 * arrived here through a topic move (plan 8.3). The trailer carries the item id
 * and its new path, so the arrival commit here and the departure commit in the
 * repo it left can be matched — in either direction — from the log alone.
 */
function commitMessage(items: [string, Pending][]): string {
  const subject = `knowledge-e3: mirror ${items.length} item${items.length === 1 ? '' : 's'}`;
  const moved = items.filter(([, p]) => p.movedIn);
  if (moved.length === 0) return subject;
  return `${subject}\n\n${moved.map(([itemId, p]) => `e3-move-in: ${itemId} ${p.path}`).join('\n')}`;
}

/**
 * The removal commit: the item id is in the message so a rebuild — or a human
 * reading the log — can follow it. A departure and a deletion get different
 * subjects and different trailers, because they are different events: the file
 * of a departure still exists somewhere, the file of a deletion does not.
 */
function removalCommitMessage(items: [string, PendingRemoval][], reason: RemovalReason): string {
  const plural = items.length === 1 ? '' : 's';
  const subject =
    reason === 'move'
      ? `knowledge-e3: move ${items.length} item${plural} out`
      : `knowledge-e3: remove ${items.length} item${plural}`;
  const trailer = reason === 'move' ? 'e3-move-out' : 'e3-remove';
  return `${subject}\n\n${items.map(([itemId, p]) => `${trailer}: ${itemId} ${p.path}`).join('\n')}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function waitForMirrorFlush(
  flush: Promise<void>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      flush,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
