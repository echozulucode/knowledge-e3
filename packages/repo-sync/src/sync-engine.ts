/**
 * `SyncEngine` — one instance per registered source, driving the plan §8.1
 * state machine over a `GitRepo`:
 *
 *   idle → fetching → merging → indexing → committing → pushing → idle
 *                        │ conflict                          │ rejected: fetch + merge, retry once, then `error`
 *                        ▼
 *                     conflict (blocks until `resolveConflict` / `abort`)
 *
 * Division of labour: the engine never writes concept files and never makes
 * the host's local commits — those still come from the server's existing
 * debounced committer (`GitRevisionMirror`), which is the `committing` state
 * in the diagram. Call `noteLocalCommit()` after each such commit so `ahead`
 * stays accurate between fetches. The engine only fetches, merges upstream,
 * hands the inbound diff to `hooks.onChangedPaths` (the host re-indexes those
 * files through `ContentCommands` with `source: git`), and pushes on the
 * §12 cadence: on publish (`requestPush('publish')`) or every `pushIntervalMs`.
 *
 * Policies (§8.2): `read-only` never pushes; `direct` and `review` merge
 * upstream into the working branch and push it. Item branches for `review`
 * mode are handled by `ReviewFlow`, not here.
 */
import type { GitRepo, PathChange, SourceRef, SyncPolicy, SyncStatus } from '@echozedlabs/knowledge-types';
import { EMPTY_TREE, SYSTEM_COMMITTER, type ConflictSides, type GitIdentity } from './git-repo.js';

/** `GitRepo` plus the `LocalGitRepo` helpers the engine relies on. */
export interface SyncRepo extends GitRepo {
  hasRemote(): Promise<boolean>;
  headSha(): Promise<string | null>;
  currentBranch(): Promise<string | null>;
  abortMerge(): Promise<void>;
  conflictSides(path: string): Promise<ConflictSides>;
  resolve(path: string, content: string): Promise<void>;
}

export type SyncLogLevel = 'info' | 'warn' | 'error';

export interface SyncHooks {
  /** Inbound files changed by a merge; the host re-indexes them. `ctx` is the merged range. */
  onChangedPaths(changes: PathChange[], ctx: { from: string; to: string }): Promise<void>;
  /** A merge left these paths conflicted; the host queues them (Admin → Repos → Conflicts). */
  onConflict(paths: string[]): Promise<void>;
  /** Every state transition. */
  onStatus(status: SyncStatus): void;
  log?: (level: SyncLogLevel, msg: string) => void;
}

export type PushReason = 'publish' | 'manual' | 'timer';

export type ConflictChoice = 'ours' | 'theirs' | { content: string };

export interface SyncEngineOptions {
  source: SourceRef;
  repo: SyncRepo;
  policy: SyncPolicy;
  hooks: SyncHooks;
  /** Millisecond clock (default `Date.now`); injectable for tests. */
  clock?: () => number;
  /** Push at least this often when there is anything to push (default 5 minutes). */
  pushIntervalMs?: number;
  /** Working branch (default `source.branch`, else the checked-out branch). */
  branch?: string;
  /** Remote name the upstream ref is read from (default `origin`). */
  remoteName?: string;
  /** Identity for merge-resolution commits (default `SYSTEM_COMMITTER`). */
  mergeAuthor?: GitIdentity;
}

export const DEFAULT_PUSH_INTERVAL_MS = 5 * 60 * 1000;

export class SyncEngine {
  private readonly source: SourceRef;
  private readonly repo: SyncRepo;
  private readonly policy: SyncPolicy;
  private readonly hooks: SyncHooks;
  private readonly clock: () => number;
  private readonly pushIntervalMs: number;
  private readonly remoteName: string;
  private readonly mergeAuthor: GitIdentity;
  private branch: string | null;

  private state: SyncStatus['state'] = 'idle';
  private ahead = 0;
  private behind = 0;
  private dirtyPaths: string[] = [];
  private conflictedPaths: string[] = [];
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private lastPushAt: number;
  private publishRequested = false;
  private running = false;
  /** Settles when the in-flight cycle (if any) finishes; see `whenIdle`. */
  private cycleDone: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** HEAD before the merge that is currently conflicted (for the post-resolution diff). */
  private preMergeHead: string | null = null;

  constructor(opts: SyncEngineOptions) {
    this.source = opts.source;
    this.repo = opts.repo;
    this.policy = opts.policy;
    this.hooks = opts.hooks;
    this.clock = opts.clock ?? Date.now;
    this.pushIntervalMs = opts.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
    this.remoteName = opts.remoteName ?? 'origin';
    this.mergeAuthor = opts.mergeAuthor ?? SYSTEM_COMMITTER;
    this.branch = opts.branch ?? opts.source.branch ?? null;
    this.lastPushAt = this.clock();
  }

  status(): SyncStatus {
    return {
      source: this.source.id,
      state: this.state,
      ahead: this.ahead,
      behind: this.behind,
      dirty_paths: [...this.dirtyPaths],
      conflicted_paths: [...this.conflictedPaths],
      last_synced_at: this.lastSyncedAt,
      last_error: this.lastError,
    };
  }

  /** The host made a local commit: bump `ahead` without a fetch. */
  noteLocalCommit(): void {
    this.ahead += 1;
    this.hooks.onStatus(this.status());
  }

  /** Flag a push and run a cycle now; if a cycle is already running, the flag carries into the next one. */
  requestPush(reason: PushReason = 'publish'): Promise<SyncStatus> {
    this.log('info', `push requested (${reason})`);
    this.publishRequested = true;
    return this.runCycle();
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runCycle(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolves once no cycle is in flight. `stop()` only clears the timer; a cycle
   * that already started keeps running git child processes, and `state` can
   * read `idle` meanwhile (the fetch prelude does not change it). Anything that
   * must know the repository is untouched — deleting its directory, shutting
   * down — awaits this rather than polling `status()`.
   */
  whenIdle(): Promise<void> {
    return this.cycleDone;
  }

  /** One pass of the state machine. Overlapping calls return the current status; a conflict blocks until resolved. */
  async runCycle(opts: { force?: boolean } = {}): Promise<SyncStatus> {
    if (this.running || this.inConflict()) return this.status();
    this.running = true;
    let finished!: () => void;
    this.cycleDone = new Promise<void>((resolve) => (finished = resolve));
    try {
      const hasRemote = await this.repo.hasRemote();
      const upstream = hasRemote ? await this.upstreamRef() : null;
      if (upstream) {
        const merged = await this.fetchAndMerge(upstream);
        if (!merged) return this.status();
      }
      if (upstream && this.policy.mode !== 'read-only' && this.shouldPush(opts.force === true)) {
        await this.pushWithRetry(upstream);
      }
      await this.refreshFromRepo();
      this.lastSyncedAt = new Date(this.clock()).toISOString();
      this.lastError = null;
      this.setState('idle');
    } catch (e) {
      if (!this.inConflict()) this.fail(e);
    } finally {
      this.running = false;
      finished();
    }
    return this.status();
  }

  /** Resolve one conflicted path; when none remain the merge is committed and its diff indexed. */
  async resolveConflict(path: string, choice: ConflictChoice): Promise<SyncStatus> {
    if (this.state !== 'conflict') throw new Error(`not in conflict state (${this.state})`);
    if (!this.conflictedPaths.includes(path)) throw new Error(`${path} is not conflicted`);
    let content: string | null;
    if (typeof choice === 'object') content = choice.content;
    else {
      const sides = await this.repo.conflictSides(path);
      content = sides[choice];
      if (content === null) throw new Error(`${path}: the ${choice} side deleted the file; pass { content } instead`);
    }
    await this.repo.resolve(path, content);
    this.conflictedPaths = this.conflictedPaths.filter((p) => p !== path);
    this.hooks.onStatus(this.status());
    if (this.conflictedPaths.length) return this.status();
    try {
      this.setState('merging');
      const from = this.preMergeHead ?? EMPTY_TREE;
      const to = await this.repo.commit([], `Merge ${this.remoteName}/${this.branch ?? ''} (resolved in Knowledge E3)`, this.mergeAuthor);
      this.preMergeHead = null;
      await this.index(from, to);
      await this.refreshFromRepo();
      this.setState('idle');
    } catch (e) {
      this.fail(e);
    }
    return this.status();
  }

  /** Abandon the conflicted merge; the tree returns to the pre-merge HEAD. */
  async abort(): Promise<SyncStatus> {
    if (this.state !== 'conflict') throw new Error(`not in conflict state (${this.state})`);
    await this.repo.abortMerge();
    this.conflictedPaths = [];
    this.preMergeHead = null;
    await this.refreshFromRepo();
    this.setState('idle');
    return this.status();
  }

  // ---------------------------------------------------------------- internals

  private async upstreamRef(): Promise<string | null> {
    this.branch ??= await this.repo.currentBranch();
    return this.branch ? `${this.remoteName}/${this.branch}` : null;
  }

  /** fetch → merge → index. Returns false when the merge conflicted (state is then `conflict`). */
  private async fetchAndMerge(upstream: string): Promise<boolean> {
    const oldHead = await this.repo.headSha();
    this.setState('fetching');
    await this.repo.fetch();
    this.setState('merging');
    let result;
    try {
      result = await this.repo.merge(upstream);
    } catch (e) {
      // A brand-new remote has no upstream branch yet; nothing to merge.
      if (/not something we can merge|unknown revision/i.test(String(e))) {
        this.log('info', `${upstream} not available yet; skipping merge`);
        return true;
      }
      throw e;
    }
    if (!result.ok) {
      this.preMergeHead = oldHead;
      this.conflictedPaths = result.conflicts;
      this.setState('conflict');
      await this.hooks.onConflict(result.conflicts);
      return false;
    }
    const newHead = await this.repo.headSha();
    if (newHead && newHead !== oldHead) await this.index(oldHead ?? EMPTY_TREE, newHead);
    return true;
  }

  private async index(from: string, to: string): Promise<void> {
    this.setState('indexing');
    const changes = await this.repo.changedPaths(from, to);
    this.log('info', `indexing ${changes.length} inbound path(s) ${from.slice(0, 7)}..${to.slice(0, 7)}`);
    await this.hooks.onChangedPaths(changes, { from, to });
  }

  private shouldPush(force: boolean): boolean {
    return force || this.publishRequested || this.clock() - this.lastPushAt >= this.pushIntervalMs;
  }

  private async pushWithRetry(upstream: string): Promise<void> {
    this.setState('pushing');
    let result = await this.repo.push();
    if (!result.ok && result.rejected) {
      this.log('warn', 'push rejected (non-fast-forward); fetching and retrying once');
      const merged = await this.fetchAndMerge(upstream);
      if (!merged) throw new Error('push rejected and the retry merge conflicted');
      this.setState('pushing');
      result = await this.repo.push();
    }
    if (!result.ok) throw new Error(result.error ?? 'push failed');
    this.lastPushAt = this.clock();
    this.publishRequested = false;
    this.ahead = 0;
  }

  private async refreshFromRepo(): Promise<void> {
    const s = await this.repo.status();
    this.ahead = s.ahead;
    this.behind = s.behind;
    this.dirtyPaths = s.dirty;
    this.conflictedPaths = s.conflicted;
  }

  private inConflict(): boolean {
    return this.state === 'conflict';
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.log('error', this.lastError);
    this.setState('error');
  }

  private setState(state: SyncStatus['state']): void {
    this.state = state;
    this.hooks.onStatus(this.status());
  }

  private log(level: SyncLogLevel, msg: string): void {
    this.hooks.log?.(level, `[sync:${this.source.id}] ${msg}`);
  }
}
