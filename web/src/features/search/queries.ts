/**
 * Grouped search (§3.5): the full `GET /search` envelope.
 *
 * Everything the server computes reaches the caller — `facets`, `warnings`,
 * `empty_state` and an honest `total` included. They used to be dropped here,
 * which is why a reader who mistyped a filter was told nothing and why a
 * 400-match query reported "100 results".
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SearchHit, SearchOverview } from '@echozedlabs/knowledge-types';
import { apiClient } from '../../api.js';
import type { SearchResult } from '../../queries.js';
import { hasActiveFilters, searchApiParams, type SearchFilters } from './searchParams.js';

/**
 * A hit as `GET /search` sends it. The fields past `SearchResult` are newer
 * than some servers, so every one is optional and read with `?.`:
 * `highlights` (match ranges, see highlight.ts) and `snippet_truncated`
 * (whether the snippet was cut from a longer body, at either end).
 */
export type SearchHitResult = SearchResult & Pick<SearchHit, 'highlights' | 'snippet_truncated'>;

export interface SearchGroup {
  key: string;
  /** Content-type label (or "Untyped"). */
  label: string;
  /** Ranked hits within the group, already capped server-side. */
  hits: SearchHitResult[];
  /** Hits in the group before the cap. */
  total: number;
}

export interface SearchFacetValue {
  /** Lowercased key, used for comparisons. */
  value: string;
  /** What to show, and what to put in the URL. */
  label: string;
  count: number;
  active?: boolean;
}

export interface SearchFacets {
  topics: SearchFacetValue[];
  statuses: SearchFacetValue[];
  tags: SearchFacetValue[];
  types: SearchFacetValue[];
  categories: SearchFacetValue[];
  trust_tiers: SearchFacetValue[];
}

export interface SearchEmptyState {
  title: string;
  guidance: string[];
  can_create_from_search: boolean;
}

export interface GroupedSearchResponse {
  results: SearchHitResult[];
  /** Every match, not the size of this page. */
  total: number;
  offset: number;
  limit: number;
  groups: SearchGroup[];
  facets: SearchFacets;
  /** Anything the parser could not honour, in the reader's words. */
  warnings: string[];
  empty_state?: SearchEmptyState;
}

export const EMPTY_FACETS: SearchFacets = { topics: [], statuses: [], tags: [], types: [], categories: [], trust_tiers: [] };

function normalize(res: Partial<GroupedSearchResponse>, limit: number, offset: number): GroupedSearchResponse {
  const results = res.results ?? [];
  return {
    results,
    total: res.total ?? results.length,
    offset: res.offset ?? offset,
    limit: res.limit ?? limit,
    groups: res.groups ?? [],
    facets: { ...EMPTY_FACETS, ...(res.facets ?? {}) },
    warnings: res.warnings ?? [],
    ...(res.empty_state ? { empty_state: res.empty_state } : {}),
  };
}

/** One page of results. Used by the ⌘K palette, which is a jump list and never pages. */
export function useGroupedSearch(query?: string, filters?: { limit?: number; includeDrafts?: boolean }) {
  const limit = filters?.limit ?? 25;
  return useQuery({
    queryKey: ['search', 'grouped', query, filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('q', query ?? '');
      if (filters?.includeDrafts) params.set('include_drafts', '1');
      params.set('limit', String(limit));
      const res = await apiClient.get<Partial<GroupedSearchResponse>>(`/search?${params.toString()}`);
      return normalize(res, limit, 0);
    },
    enabled: !!query && query.trim().length > 0,
  });
}

/**
 * The `/search` page's query: every filter in the URL goes to the server, and
 * "Load more" walks the ranked list by `offset` rather than pretending the
 * first page is the whole answer.
 *
 * The previous answer stays on screen while a refinement loads. Toggling a
 * facet used to blank the page to "Searching…", which collapsed the filter
 * sidebar under the pointer and unmounted the very option a keyboard user had
 * focused in the mobile filter dialog.
 */
export function useSearchResults(filters: SearchFilters, opts: { pageSize: number; includeDrafts?: boolean }) {
  // A filter alone is a search: `/search?topic=architecture` (the article's
  // "Search in" link) lists that topic's items, newest first.
  const enabled = filters.q.trim().length > 0 || hasActiveFilters(filters);
  return useInfiniteQuery({
    queryKey: ['search', 'page', filters, opts.pageSize, opts.includeDrafts ?? false],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = searchApiParams(filters, { limit: opts.pageSize, offset: pageParam as number });
      if (opts.includeDrafts) params.set('include_drafts', '1');
      const res = await apiClient.get<Partial<GroupedSearchResponse>>(`/search?${params.toString()}`);
      return normalize(res, opts.pageSize, pageParam as number);
    },
    getNextPageParam: (lastPage) => {
      const seen = lastPage.offset + lastPage.results.length;
      return lastPage.results.length > 0 && seen < lastPage.total ? seen : undefined;
    },
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * `GET /search/overview` — the library's shape before anything is typed
 * (reader plan R12): types, topics, categories and top tags with counts, plus
 * the recently verified and recently updated items. Counted server-side over
 * what this viewer may read.
 *
 * Every list is defaulted, so a partial or older payload renders what it has;
 * a 404 (a server without the route) or any failure is an error the page
 * hides the index on — the search box above still works.
 */
export function useSearchOverview(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['search', 'overview'],
    queryFn: async (): Promise<SearchOverview> => {
      const res = await apiClient.get<Partial<SearchOverview>>('/search/overview');
      return {
        total: typeof res.total === 'number' ? res.total : 0,
        types: res.types ?? [],
        topics: res.topics ?? [],
        categories: res.categories ?? [],
        tags: res.tags ?? [],
        recently_verified: res.recently_verified ?? [],
        recently_updated: res.recently_updated ?? [],
      };
    },
    enabled: opts.enabled ?? true,
    // The shape of the library changes on a publish, not between keystrokes.
    staleTime: 60_000,
    retry: false,
  });
}
