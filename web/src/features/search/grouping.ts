/**
 * Small pure helpers behind the grouped result surfaces (palette, /search, browse):
 * the lifecycle label a hit earns, and the visual order groups flatten into
 * for keyboard navigation.
 */
import type { DisplayState, ReviewRef } from '@echozedlabs/knowledge-types';

/**
 * The one lifecycle chip a search hit earns — the states worth a word on an
 * index surface: In review, Draft, Superseded, Archived, Needs review. Plain
 * `published` earns nothing (home plan R2.4): the absence of a warning is the
 * signal, and a "Published" chip on every row trained readers to skip the row
 * of chips altogether.
 *
 * A hit carries `stale` (past `stale_after`) and its `status` rather than a
 * full `display_state`, plus the change request its edits are staged on (plan
 * §8.2) — an open one wins, exactly as it does on the read page. A draft says
 * so before it says it is stale: whether an item is live at all is the bigger
 * fact. `display_state` is honoured when a payload carries one (the search API
 * does not today), so Superseded and Archived need no second rule here.
 */
export function displayStateForHit(hit: {
  stale?: boolean;
  review?: ReviewRef | null;
  status?: string | null;
  display_state?: DisplayState | null;
}): DisplayState | null {
  if (hit.review?.state === 'open') return 'in-review';
  if (hit.status === 'draft') return 'draft';
  if (hit.display_state && hit.display_state !== 'published') return hit.display_state;
  return hit.stale ? 'needs-review' : null;
}

/** The change-request URL to link the "In review" badge to, or null. */
export function reviewUrlForHit(hit: { review?: ReviewRef | null }): string | null {
  return hit.review?.state === 'open' ? hit.review.url : null;
}

export interface FlattenedGroups<T> {
  /** Every hit in visual order: group by group, ranked order within a group. */
  flat: T[];
  /** Flat index of each group's first hit, so a renderer can map rows back. */
  starts: number[];
}

/** Flatten grouped hits into the order the Up/Down keys walk them. */
export function flattenGroups<T>(groups: { hits: T[] }[]): FlattenedGroups<T> {
  const flat: T[] = [];
  const starts: number[] = [];
  for (const group of groups) {
    starts.push(flat.length);
    flat.push(...group.hits);
  }
  return { flat, starts };
}

export interface TypeGroup<T> {
  key: string;
  label: string;
  hits: T[];
  total: number;
}

const UNTYPED_LABEL = 'Untyped';

/**
 * Client-side counterpart of the server's grouping for an already-ranked and
 * facet-filtered list: groups keep first-seen order (which, for a relevance-
 * ordered list, is best-hit order) and hits keep their order within a group.
 */
export function groupByType<T extends { type?: string | null }>(items: T[], capPerGroup = Infinity): TypeGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const label = item.type?.trim() || UNTYPED_LABEL;
    const bucket = buckets.get(label);
    if (bucket) bucket.push(item);
    else buckets.set(label, [item]);
  }
  return [...buckets.entries()].map(([label, bucket]) => ({
    key: label,
    label,
    hits: bucket.slice(0, capPerGroup),
    total: bucket.length,
  }));
}
