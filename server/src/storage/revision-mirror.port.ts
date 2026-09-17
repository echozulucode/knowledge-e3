export const REVISION_MIRROR = Symbol('REVISION_MIRROR');

export interface RevisionMirrorEvent {
  itemId: string;
  versionId: string;
  versionToken: number;
  actorId: string;
  title: string;
  slug: string;
  rawMarkdown: string;
  /** Lifecycle status of the persisted version. */
  status: 'draft' | 'published';
  /** Space (topic) id the item belongs to, if any. */
  spaceId: string | null;
  /** Owning user id, so ownership survives a rebuild from files. */
  ownerId: string | null;
  /** Canonical taxonomy at persist time (DB-derived). */
  tags: string[];
  categories: string[];
  groups: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a moved item's file used to live (plan 8.3). Enough to reach the repo
 * it left without re-resolving a topic that no longer points there.
 */
export interface MovedOutSource {
  /** Source registry id the row recorded before the move (`main` / `topic:<slug>`). */
  sourceId: string;
  /** Absolute working-tree dir of that repository. */
  repoDir: string;
  remoteUrl: string | null;
  branch: string | null;
}

export interface RevisionMirrorPort {
  /**
   * Called after the database transaction has persisted an item and its current
   * version. Implementations must treat the database as source of truth and
   * must not throw to force application-level rollback semantics.
   *
   * `movedIn` marks the arrival half of a topic move, so the commit message can
   * carry the item id (see `afterItemMovedOut` for the other half).
   */
  afterItemVersionPersisted(event: RevisionMirrorEvent, opts?: { movedIn?: boolean }): Promise<void>;

  /**
   * The departure half of a topic move: `path` no longer belongs to `from`'s
   * repository, so that repo must commit its removal. Called AFTER the index
   * transaction and the source-side outbox row, never before — the file itself
   * was already unlinked by the write-first command. Optional: the no-op mirror
   * has no repo to remove anything from.
   */
  afterItemMovedOut?(
    from: MovedOutSource,
    event: { itemId: string; path: string; actorId: string; versionToken: number },
  ): Promise<void>;

  /**
   * The item was soft-deleted (issue 76): its file no longer belongs in `from`'s
   * repository, so that repo must commit the removal. Called AFTER the index
   * transaction and its `delete` outbox row; the file itself was already
   * unlinked by the write-first command.
   *
   * Deliberately NOT folded into `afterItemMovedOut`: the two would run the same
   * code, but that call's commit reads `knowledge-e3: move N items out` with an
   * `e3-move-out:` trailer per item — an honest log for a departure and a lie
   * for a deletion, and the git log is the only record a rebuild or a human has
   * of why a file left. Same reasoning as `movedIn` on the arrival half.
   */
  afterItemRemoved?(
    from: MovedOutSource,
    event: { itemId: string; path: string; actorId: string; versionToken: number },
  ): Promise<void>;

  /**
   * Force any pending mirror writes to commit/push now. Optional — present on the
   * git adapters (used by backfill/sync-now and shutdown), absent on the no-op.
   */
  flush?(): Promise<void>;

  /**
   * Signal that bundle assets (images/attachments under `assets/`) changed, so a
   * commit is scheduled even when no page edit is pending. Without this, an
   * upload or delete with no concurrent page write never reaches git: the bytes
   * are not durable (git is the only backup path on the cloud demo) and a
   * deletion does not stick across a rebuild-from-git (ADR-0003, phase 2).
   *
   * `actorId` is the human who uploaded or deleted the file, so the asset commit
   * is authored by them like every other edit (§7.1 per-edit authorship). It is
   * optional because a caller that genuinely has no actor — a heal of missing
   * bytes during a rebuild — must not invent one; that case commits as the
   * system identity, which is the honest answer.
   * Optional — the no-op adapter omits it (DB/local disk only).
   */
  notifyAssetsChanged?(actorId?: string): Promise<void>;
}
