/**
 * The URL is the state of `/search` (reader UX plan §5.5).
 *
 * A search that cannot be pasted into a ticket is not a search a team can use,
 * so every narrowing a reader applies lives in the query string and every one
 * of them is sent to `GET /search`. This module is the whole translation —
 * router params in, normalised filters out, and back again — kept pure so it is
 * testable without a browser.
 *
 * Scope note (§5.6): there is no default topic. Search covers everything the
 * reader may read until they choose to narrow it; a default scope would teach
 * them there are walls. A topic the reader DID choose (a topic landing's
 * "Search in" box, an article's "Search in" link, a Topic facet) is a scope: it
 * survives a new query and is shown as a removable "In <Topic>" chip.
 *
 * URL PARAMS ARE THE QUERY LANGUAGE'S KEYS. Every axis in the URL is spelled
 * exactly as its `key:` in a typed query (`SUPPORTED_SEARCH_FILTERS`), with the
 * same values, so `?tag=mqtt&type=Runbook` and `tag:mqtt type:Runbook` are one
 * search written two ways:
 *
 *   | URL        | query       | values                                        | repeat |
 *   |------------|-------------|-----------------------------------------------|--------|
 *   | `type`     | `type:`     | content type label                            | OR     |
 *   | `topic`    | `topic:`    | topic slug, id or name                        | OR     |
 *   | `tag`      | `tag:`      | exact tag                                     | OR     |
 *   | `category` | `category:` | primary category                              | OR     |
 *   | `group`    | `group:`    | tag group id, slug or name                    | OR     |
 *   | `is`       | `is:`       | `human-reviewed`, `machine-confirmed`,        | OR     |
 *   |            |             | `unverified` (what the Trust facet writes);   |        |
 *   |            |             | other `is:` values pass through as typed      |        |
 *   | `status`   | `status:`   | `draft` or `published`                        | single |
 *   | `sort`     | —           | `newest`, `oldest`, `az`, `verified`          | single |
 *
 * The trust facet is `is`, not a separate `trust` param (reader plan §5.5
 * sketched `trust`): one name per concept, and it is the one a reader can type.
 */

import { peekFromSearch } from '../reading-pane/readingPaneModel.js';

export type SearchSortMode = 'relevance' | 'newest' | 'oldest' | 'az' | 'verified';
export type SearchStatusFilter = 'draft' | 'published';

/** A repeatable axis: the same key may appear several times, and the values OR. */
export const FILTER_AXES = ['type', 'topic', 'tag', 'category', 'group', 'is'] as const;
export type FilterAxis = (typeof FILTER_AXES)[number];

/** Raw router search params — a repeated key arrives as an array. */
export type SearchPageParams = {
  q?: string;
  status?: string;
  sort?: string;
  /**
   * The item open in the reading pane beside the results (features/reading-pane).
   * Not a filter and never sent to `GET /search`: it rides along with whatever
   * search is on screen, so refining the results does not close what is being read.
   */
  peek?: string;
} & { [K in FilterAxis]?: string | string[] };

export interface SearchFilters {
  q: string;
  type: string[];
  topic: string[];
  tag: string[];
  category: string[];
  group: string[];
  /** Trust / lifecycle values, as `is:` takes them (lowercase keys). */
  is: string[];
  status?: SearchStatusFilter;
  sort: SearchSortMode;
}

export const SORT_OPTIONS: { value: SearchSortMode; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'az', label: 'A–Z' },
  // `last_verified_at` desc, unverified last (SortMode's contract).
  { value: 'verified', label: 'Recently verified' },
];

const SORT_VALUES = new Set<string>(SORT_OPTIONS.map((option) => option.value));

export const EMPTY_FILTERS: SearchFilters = { q: '', type: [], topic: [], tag: [], category: [], group: [], is: [], sort: 'relevance' };

export function filtersFromParams(params: SearchPageParams | undefined): SearchFilters {
  const source = params ?? {};
  const filters: SearchFilters = {
    ...EMPTY_FILTERS,
    q: typeof source.q === 'string' ? source.q : '',
    sort: typeof source.sort === 'string' && SORT_VALUES.has(source.sort) ? (source.sort as SearchSortMode) : 'relevance',
  };
  for (const axis of FILTER_AXES) filters[axis] = asList(source[axis]);
  // `is:` values are keys, not labels; one spelling keeps a chip and its URL in step.
  filters.is = filters.is.map((value) => value.toLowerCase());
  if (source.status === 'draft' || source.status === 'published') filters.status = source.status;
  return filters;
}

/**
 * Router search params for these filters: empty axes are dropped, single values stay scalar.
 *
 * `carry` is the current URL's params, for what is NOT a filter: pass it when
 * rewriting the search on the page it is on, so an open reading pane (`peek`)
 * survives a facet, a sort or a new query — once, never duplicated. Omit it for
 * a link to a different search, which starts with nothing open.
 */
export function paramsFromFilters(filters: SearchFilters, carry?: Pick<SearchPageParams, 'peek'>): SearchPageParams {
  const params: SearchPageParams = {};
  if (filters.q.trim()) params.q = filters.q.trim();
  for (const axis of FILTER_AXES) {
    const values = filters[axis];
    if (values.length === 1) params[axis] = values[0];
    else if (values.length > 1) params[axis] = values;
  }
  if (filters.status) params.status = filters.status;
  if (filters.sort !== 'relevance') params.sort = filters.sort;
  const peek = peekFromSearch(carry);
  if (peek) params.peek = peek;
  return params;
}

/** The query string for `GET /search`, with every filter carried through. */
export function searchApiParams(filters: SearchFilters, page: { limit: number; offset?: number }): URLSearchParams {
  const params = new URLSearchParams();
  params.set('q', filters.q);
  for (const axis of FILTER_AXES) for (const value of filters[axis]) params.append(axis, value);
  if (filters.status) params.set('status', filters.status);
  const sort = effectiveSort(filters);
  if (sort !== 'relevance') params.set('sort', sort);
  params.set('limit', String(page.limit));
  if (page.offset) params.set('offset', String(page.offset));
  return params;
}

/** Add a value to an axis, or remove it when it is already applied (chips toggle). */
export function toggleFilterValue(filters: SearchFilters, axis: FilterAxis, value: string): SearchFilters {
  const current = filters[axis];
  const without = current.filter((existing) => !sameValue(existing, value));
  return { ...filters, [axis]: without.length === current.length ? [...current, value] : without };
}

export function isFilterActive(filters: SearchFilters, axis: FilterAxis, value: string): boolean {
  return filters[axis].some((existing) => sameValue(existing, value));
}

/** Clear one axis entirely — the "All types" / "All topics" chips. */
export function clearAxis(filters: SearchFilters, axis: FilterAxis): SearchFilters {
  return { ...filters, [axis]: [] };
}

/**
 * The sort actually in force. With no query there is nothing to rank against —
 * the server lists a filters-only search newest first — so the page says
 * "Newest" rather than claiming a relevance order it does not have. The URL
 * keeps the reader's choice; typing a query brings relevance back.
 */
export function effectiveSort(filters: Pick<SearchFilters, 'q' | 'sort'>): SearchSortMode {
  return filters.sort === 'relevance' && !filters.q.trim() ? 'newest' : filters.sort;
}

/** The Sort options that mean something for this search: no "Relevance" without a query. */
export function sortOptionsFor(filters: Pick<SearchFilters, 'q'>): { value: SearchSortMode; label: string }[] {
  return filters.q.trim() ? SORT_OPTIONS : SORT_OPTIONS.filter((option) => option.value !== 'relevance');
}

/**
 * The filters for a NEW query typed over an existing search. Facets chosen for
 * the old results usually match nothing in the new ones, so they go — but the
 * topic scope stays: it was chosen on purpose, it is on screen as a chip, and
 * dropping it would make "Search in Architecture" forget itself on the first
 * keystroke.
 */
export function filtersForNewQuery(filters: SearchFilters, q: string): SearchFilters {
  return { ...EMPTY_FILTERS, q, sort: filters.sort, topic: filters.topic };
}

/** Set or clear the single-valued status filter (the Status facet toggles). */
export function toggleStatus(filters: SearchFilters, status: string): SearchFilters {
  const next = status.trim().toLowerCase();
  if (next !== 'draft' && next !== 'published') return filters;
  return { ...filters, status: filters.status === next ? undefined : next };
}

/** Everything except the query: the "Clear filters" / "Search everything" escape. */
export function clearAllFilters(filters: SearchFilters): SearchFilters {
  return { ...EMPTY_FILTERS, q: filters.q, sort: filters.sort };
}

export function activeFilterCount(filters: SearchFilters): number {
  return FILTER_AXES.reduce((n, axis) => n + filters[axis].length, 0) + (filters.status ? 1 : 0);
}

export function hasActiveFilters(filters: SearchFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/**
 * What the result line says. `total` is the server's real count over the whole
 * match, so this never claims a page size is a corpus size.
 */
export function resultCountLabel(shown: number, total: number, query: string): string {
  const plural = total === 1 ? 'result' : 'results';
  const counted = shown >= total ? `${total} ${plural}` : `${shown} of ${total} ${plural}`;
  const trimmed = query.trim();
  return trimmed ? `${counted} for ‘${trimmed}’` : counted;
}

/**
 * The display name for an active topic filter, for the "In <Topic>" scope chip.
 * The URL may carry a slug (`architecture`, from a topic page), an id, or a
 * name (from a Topic facet chip); the topic facet carries names. Match either
 * spelling, and a slug against a slugified name; fall back to the value itself.
 */
export function topicScopeLabel(value: string, topics: { value: string; label: string }[]): string {
  const wanted = slugify(value);
  const match = topics.find((topic) => slugify(topic.label) === wanted || slugify(topic.value) === wanted);
  return match?.label ?? value;
}

/** Display text for an `is:` value on an active-filter chip. */
export function isValueLabel(value: string): string {
  switch (value.toLowerCase()) {
    case 'human-reviewed':
      return 'Human-reviewed';
    case 'machine-confirmed':
      return 'Machine-confirmed';
    case 'unverified':
      return 'Unverified';
    case 'verified':
      return 'Verified';
    default:
      return value;
  }
}

/** The server's facet slug rule (`slugifyFacet`), so a topic slug meets its name. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  const values = (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim()).filter(Boolean);
  return values.filter((entry, index) => values.findIndex((other) => sameValue(other, entry)) === index);
}

function sameValue(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
