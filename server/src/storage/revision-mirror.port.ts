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

export interface RevisionMirrorPort {
  /**
   * Called after the database transaction has persisted an item and its current
   * version. Implementations must treat the database as source of truth and
   * must not throw to force application-level rollback semantics.
   */
  afterItemVersionPersisted(event: RevisionMirrorEvent): Promise<void>;

  /**
   * Force any pending mirror writes to commit/push now. Optional — present on the
   * git adapters (used by backfill/sync-now and shutdown), absent on the no-op.
   */
  flush?(): Promise<void>;
}
