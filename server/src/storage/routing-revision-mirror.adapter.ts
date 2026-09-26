import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { ContentPathResolver } from './content-path.resolver.js';
import {
  GitRevisionMirrorAdapter,
  waitForMirrorFlush,
  type MirrorOptions,
} from './git-revision-mirror.adapter.js';
import type { MovedOutSource, RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Routes each item's git mirror to the right repository (ADR-0001 multi-repo,
 * topic-first layout) — the hybrid main-repo-subtree / dedicated-repo model
 * that `ContentPathResolver` defines, re-resolved per write so config changes
 * take effect without a restart.
 */
export class RoutingRevisionMirror implements RevisionMirrorPort, OnModuleDestroy {
  private readonly logger = new Logger(RoutingRevisionMirror.name);
  private readonly paths: ContentPathResolver;
  private readonly repos = new Map<string, GitRevisionMirrorAdapter>();
  /** Sources whose push the `SyncService` owns (plan §12: push on publish + timer). */
  private readonly managedSources = new Set<string>();

  constructor(
    root: string,
    private readonly db: Kysely<Database>,
    private readonly opts: MirrorOptions = {},
  ) {
    this.paths = new ContentPathResolver(root, db);
  }

  async afterItemVersionPersisted(event: RevisionMirrorEvent, opts: { movedIn?: boolean } = {}): Promise<void> {
    const target = await this.paths.resolve(event.spaceId);
    const repo = this.repoFor(target.repoDir);
    repo.setRemote(target.remoteUrl, target.branch, target.credential); // hot-reload the remote (and its credential)
    repo.setPushOnCommit(!this.managedSources.has(target.sourceId));
    await repo.enqueue(event, target.conceptDir, opts);
  }

  /**
   * The departure half of a topic move (plan 8.3). Routed by the source the row
   * recorded, not by the item's topic — the topic now resolves to the repo it
   * moved INTO, so re-resolving would remove the file from the wrong tree.
   */
  async afterItemMovedOut(
    from: MovedOutSource,
    event: { itemId: string; path: string; actorId: string; versionToken: number },
  ): Promise<void> {
    const repo = this.repoFor(from.repoDir);
    repo.setRemote(from.remoteUrl, from.branch, from.credential);
    repo.setPushOnCommit(!this.managedSources.has(from.sourceId));
    await repo.enqueueRemoval(event, 'move');
  }

  /**
   * A soft delete (issue 76). Routed by the source the row recorded, like a
   * departure, and for the same reason — but committed as a removal, not as the
   * source half of a move.
   */
  async afterItemRemoved(
    from: MovedOutSource,
    event: { itemId: string; path: string; actorId: string; versionToken: number },
  ): Promise<void> {
    const repo = this.repoFor(from.repoDir);
    repo.setRemote(from.remoteUrl, from.branch, from.credential);
    repo.setPushOnCommit(!this.managedSources.has(from.sourceId));
    await repo.enqueueRemoval(event, 'delete');
  }

  /**
   * Mark a source as managed by the sync engine: its repo commits locally and
   * leaves pushing to `SyncService` (`pushOnCommit: false`). Undo with `false`.
   */
  setManaged(sourceId: string, managed: boolean): void {
    if (managed) this.managedSources.add(sourceId);
    else this.managedSources.delete(sourceId);
  }

  /** Commit (and, unless managed, push) what is pending for one repo dir. */
  async flushRepo(repoDir: string): Promise<void> {
    const repo = this.repos.get(repoDir);
    if (repo) await repo.flush();
  }

  /**
   * Assets are shared and content-addressed, so they live in the main repo's
   * `assets/` dir regardless of topic. Route the signal there.
   */
  async notifyAssetsChanged(actorId?: string): Promise<void> {
    await this.repoFor(this.paths.mainDir).notifyAssetsChanged(actorId);
  }

  /** Flush every repo (shutdown, or before a backfill assertion). */
  async flush(): Promise<void> {
    for (const repo of this.repos.values()) {
      await repo.flush().catch((err) => this.logger.warn(`flush failed: ${String(err)}`));
    }
  }

  async onModuleDestroy(): Promise<void> {
    const timeoutMs = this.opts.shutdownFlushTimeoutMs ?? DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    const repos = [...this.repos.values()];
    const flushes = Promise.all(repos.map((repo) => repo.onModuleDestroy())).then(() => undefined);
    await waitForMirrorFlush(
      flushes,
      timeoutMs,
      () => repos.forEach((repo) => repo.abortShutdown()),
    ).catch((err) => {
      this.logger.warn(`shutdown git mirror flush did not complete: ${String(err)}`);
    });
  }

  private repoFor(repoDir: string): GitRevisionMirrorAdapter {
    let repo = this.repos.get(repoDir);
    if (!repo) {
      repo = new GitRevisionMirrorAdapter(repoDir, this.db, this.opts);
      this.repos.set(repoDir, repo);
    }
    return repo;
  }
}
