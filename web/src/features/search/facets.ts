/**
 * How many options a facet group shows before "Show N more" (home plan R2.4's
 * restraint, applied to the filters). A topic list 20 entries long pushed Tag
 * and Category below the fold of a sidebar whose whole job is to be scanned;
 * six is what a reader takes in at a glance, and the counts are sorted so the
 * six are the ones most likely to be wanted.
 */
import type { SearchFacetValue } from './queries.js';

export const FACET_VISIBLE_LIMIT = 6;

/**
 * A facet option as the filters render it. `count` is null only for an active
 * filter the server's capped facet list did not include — it is still shown,
 * so it can be seen and removed, but with no number rather than a wrong one.
 */
export interface FacetOption {
  value: string;
  label: string;
  count: number | null;
  active: boolean;
}

export interface VisibleFacets {
  shown: FacetOption[];
  /** Options folded behind the toggle while collapsed; 0 when expanded or when nothing folds. */
  hiddenCount: number;
  /** Whether the group has anything to fold at all, i.e. whether a toggle is offered. */
  collapsible: boolean;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The options a facet group shows: the top `limit` by count, plus every ACTIVE
 * option wherever it ranks. A chosen filter never disappears behind "Show
 * more" — a filter you cannot see is one you cannot tell is on, or take off.
 *
 * Order is by count, highest first; a stable sort keeps the server's tie-break
 * (label) for equal counts. Active filters the server's list omitted (it caps
 * each facet) are appended, uncounted, so the same promise holds for them.
 */
export function visibleFacetValues(
  values: SearchFacetValue[],
  activeFilters: string[],
  { expanded, limit = FACET_VISIBLE_LIMIT }: { expanded: boolean; limit?: number },
): VisibleFacets {
  const isActive = (value: SearchFacetValue) => activeFilters.some((f) => same(f, value.label) || same(f, value.value));
  const ranked: FacetOption[] = [...values]
    .sort((a, b) => b.count - a.count)
    .map((value) => ({ value: value.value, label: value.label, count: value.count, active: isActive(value) }));
  const missing = activeFilters.filter((f) => !values.some((value) => same(f, value.label) || same(f, value.value)));
  const all = [...ranked, ...missing.map((f) => ({ value: f.toLowerCase(), label: f, count: null, active: true }))];

  const shownCollapsed = all.filter((option, index) => index < limit || option.active);
  const collapsible = shownCollapsed.length < all.length;
  if (expanded) return { shown: all, hiddenCount: 0, collapsible };
  return { shown: shownCollapsed, hiddenCount: all.length - shownCollapsed.length, collapsible };
}
