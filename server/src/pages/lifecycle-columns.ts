/**
 * Indexed lifecycle/trust columns on `pages` (plan §7.4).
 *
 * The six columns are derived from frontmatter at write time so search, content
 * health and listings read columns instead of parsing every row's
 * `frontmatter_json`. They are an index, never the truth: a rebuild recomputes
 * them from the files. `display_state` is NOT stored — it depends on "now", so
 * it is derived at read time from `status` + these columns.
 */
import type { AuthedUser } from '../auth/auth.service.js';
import { deriveDisplayState, type DerivedDisplayState } from '@echozedlabs/content-model';
import { isStale } from '@echozedlabs/okf';
import { upstreamFileUrl, type HostKind } from '@echozedlabs/repo-sync';
import type {
  DisplayState,
  ItemSourceRef,
  LifecycleStatus,
  ReviewRef,
  SourceRole,
  SyncMode,
  TrustTier,
} from '@echozedlabs/knowledge-types';
import type { ReviewState } from '../db/schema.js';

/**
 * `ReviewRef` and the `in-review` display state are part of the shared contract
 * (`@echozedlabs/knowledge-types`): `DisplayState` carries `in-review` and
 * `ItemSummary` carries `review`, so summaries in feeds and search answer the
 * same question item views do. Re-exported here for the server modules that
 * already import the type from this file.
 */
export type { ItemSourceRef, ReviewRef } from '@echozedlabs/knowledge-types';

/** The `review_*` columns of a `pages` row as a `ReviewRef`; null when the item was never staged. */
export function reviewRefFrom(row: {
  review_state?: ReviewState | null;
  review_url?: string | null;
  review_branch?: string | null;
  review_opened_at?: string | null;
  review_closed_at?: string | null;
}): ReviewRef | null {
  if (!row.review_state) return null;
  return {
    state: row.review_state,
    url: row.review_url ?? null,
    branch: row.review_branch ?? null,
    opened_at: row.review_opened_at ?? null,
    closed_at: row.review_closed_at ?? null,
  };
}

/**
 * The `content_sources` row behind a page, as an `ItemSourceRef`. Null when the
 * page records no source (written before the registry) or the source is gone.
 * The upstream URL is derived, never stored: a remote can be re-pointed at any
 * time and a stale link is worse than none.
 */
export function sourceRefFrom(
  sourceId: string | null | undefined,
  filePath: string | null | undefined,
  source: {
    role: SourceRole;
    mode: SyncMode;
    remote_url: string | null;
    branch: string | null;
    host_kind: HostKind | null;
    host_base_url: string | null;
  } | null,
): ItemSourceRef | null {
  if (!sourceId || !source) return null;
  return {
    id: sourceId,
    role: source.role,
    mode: source.mode,
    path: filePath ?? null,
    url: filePath
      ? upstreamFileUrl({
          kind: source.host_kind,
          remote: source.remote_url,
          branch: source.branch,
          baseUrl: source.host_base_url,
          path: filePath,
        })
      : null,
  };
}

/** How much of an item's source ref a caller is entitled to see. */
export type SourceViewerLevel = 'anonymous' | 'user' | 'admin';

/**
 * What a viewer may know about where an item's file lives.
 *
 * `role` and `mode` are claims about TRUST — "this is somebody else's content",
 * "nothing is published from here" — and the reader-facing badge is built on
 * them, so they stay. `path` is the plumbing: an internal repository path that
 * nothing in the reader UI renders any more (plan §6, R4.1), so no viewer below
 * an operator is handed one. `url` is a door: a contributor can use it to reach
 * the original, so a signed-in viewer keeps it, and an anonymous one — who may
 * be looking at a public instance fronting a private repository — does not.
 *
 * An admin gets the full ref: Admin → Sources is where the id and the path are
 * meant to be read, and where an operator can act on them.
 */
export function redactSourceForViewer(source: ItemSourceRef | null, viewer: SourceViewerLevel): ItemSourceRef | null {
  if (!source || viewer === 'admin') return source;
  return { id: source.id, role: source.role, mode: source.mode, path: null, url: viewer === 'user' ? (source.url ?? null) : null };
}

/**
 * Every public read goes out through here (plan §6, R4.5). `source.path` names
 * an internal repository path and `source.url` points into a repo that may be
 * private, so what survives depends on who is asking — see
 * `redactSourceForViewer`.
 *
 * Applied at the controller rather than in `hydrate`, because the view is built
 * without a viewer and the write path legitimately needs the full ref.
 */
export function sourceViewerLevel(user: AuthedUser | undefined | null): SourceViewerLevel {
  if (!user?.id) return 'anonymous';
  return user.role === 'admin' ? 'admin' : 'user';
}

export function forViewer<T extends { source?: unknown } | null | undefined>(page: T, user: AuthedUser | undefined | null): T {
  if (!page || typeof page !== 'object') return page;
  const level = sourceViewerLevel(user);
  if (level === 'admin') return page;
  const view = page as { source?: Parameters<typeof redactSourceForViewer>[0] };
  if (view.source === undefined) return page;
  return { ...(page as object), source: redactSourceForViewer(view.source ?? null, level) } as T;
}

/**
 * A list row's `source` is shipped to nobody but an operator. No list surface
 * renders it — the badge lives on the article — so carrying it is a standing
 * invitation for the next list UI to leak one, which is the class of bug R4.5
 * closes rather than the instance.
 */
export function listForViewer<T extends { source?: unknown }>(pages: T[], user: AuthedUser | undefined | null): T[] {
  if (sourceViewerLevel(user) === 'admin') return pages;
  return pages.map((page) => {
    if (!page || typeof page !== 'object' || page.source === undefined) return page;
    const { source: _source, ...rest } = page as { source?: unknown };
    return rest as T;
  });
}

export interface LifecycleColumns {
  lifecycle_status: LifecycleStatus;
  stale_after: string | null;
  trust_tier: TrustTier;
  last_verified_at: string | null;
  generated_by: string | null;
  superseded_by: string | null;
}

/**
 * The subset of a `pages` row the read-time derivation needs. The lifecycle
 * fields are optional because `ItemView`/`PageView` do not carry them yet;
 * `trust_tier` being set is the signal that the row was written with columns.
 */
export interface LifecycleColumnRow {
  status: 'draft' | 'published';
  lifecycle_status?: string | null;
  stale_after?: string | null;
  trust_tier?: string | null;
  last_verified_at?: string | null;
  generated_by?: string | null;
  superseded_by?: string | null;
  /** Open change request (plan §8.2); when open the item reads as `in-review`. */
  review?: ReviewRef | null;
}

/** The six derived columns for a page about to be written with this frontmatter. */
export function lifecycleColumnsFrom(
  frontmatter: Record<string, unknown>,
  publicationStatus: 'draft' | 'published',
): LifecycleColumns {
  // Derive from what will be STORED: YAML dates arrive as Date objects but are
  // persisted as ISO strings in frontmatter_json, and readers derive from that.
  const stored = JSON.parse(JSON.stringify(frontmatter)) as Record<string, unknown>;
  const d = deriveDisplayState(stored, publicationStatus);
  return {
    lifecycle_status: d.lifecycle_status,
    stale_after: d.stale_after,
    trust_tier: d.trust_tier,
    last_verified_at: d.last_verified_at,
    generated_by: d.generated_by,
    superseded_by: d.superseded_by,
  };
}

/**
 * The reader-facing state from the indexed columns, as of `now`. Same rule as
 * content-model's `deriveDisplayState` (which works over frontmatter):
 *   draft ⇒ draft; deprecated ⇒ superseded (successor) | archived;
 *   past stale_after ⇒ needs-review; otherwise published.
 */
export function displayStateFromColumns(row: LifecycleColumnRow, now: Date): DisplayState {
  if (row.review?.state === 'open') return 'in-review';
  if (row.status === 'draft') return 'draft';
  if (row.lifecycle_status === 'deprecated') return row.superseded_by ? 'superseded' : 'archived';
  if (isStale(row.stale_after, now)) return 'needs-review';
  return 'published';
}

/**
 * Lifecycle signals for a row: from the columns when the row was written with
 * them, else derived from its frontmatter (rows that predate the columns, or
 * were inserted around the write path, until they are rewritten or backfilled).
 */
export function lifecycleSignals(
  row: LifecycleColumnRow,
  frontmatter: Record<string, unknown>,
  now: Date = new Date(),
): DerivedDisplayState {
  if (!row.trust_tier) {
    const derived = deriveDisplayState(frontmatter, row.status, now);
    return row.review?.state === 'open' ? { ...derived, display_state: 'in-review' } : derived;
  }
  return {
    display_state: displayStateFromColumns(row, now),
    lifecycle_status: row.lifecycle_status as LifecycleStatus,
    trust_tier: row.trust_tier as TrustTier,
    stale: isStale(row.stale_after, now),
    stale_after: row.stale_after ?? null,
    last_verified_at: row.last_verified_at ?? null,
    generated_by: row.generated_by ?? null,
    superseded_by: row.superseded_by ?? null,
  };
}
