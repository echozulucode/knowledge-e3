/**
 * Feed-feature hooks (plan §3.3): the chronological feed (paged by cursor) and
 * a series in reading order. Every route is a public read; the server decides
 * what the viewer may see.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { FeedEntry } from '@echozedlabs/knowledge-types';
import { apiClient } from '../../api.js';

/** A feed entry plus `featured` (true while `featured_until` is in the future). */
export type HomepageFeedEntry = FeedEntry & { featured: boolean };

export interface FeedParams {
  topic?: string;
  types?: string[];
  series?: string;
  author?: string;
  homepage?: boolean;
  featured?: boolean;
  limit?: number;
}

export function feedPath(params: FeedParams, cursor?: string): string {
  const q = new URLSearchParams();
  if (params.topic) q.set('topic', params.topic);
  if (params.types?.length) q.set('types', params.types.join(','));
  if (params.series) q.set('series', params.series);
  if (params.author) q.set('author', params.author);
  if (params.homepage) q.set('homepage', '1');
  if (params.featured) q.set('featured', '1');
  if (params.limit) q.set('limit', String(params.limit));
  if (cursor) q.set('cursor', cursor);
  return `/feed${q.size ? '?' + q.toString() : ''}`;
}

interface FeedPage {
  items: HomepageFeedEntry[];
  next_cursor?: string | null;
}

/** Cursor-paged feed; `Load more` fetches the next page. */
export function useFeed(params: FeedParams) {
  return useInfiniteQuery({
    queryKey: ['feed', params],
    queryFn: ({ pageParam }) => apiClient.get<FeedPage>(feedPath(params, pageParam || undefined)),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor || undefined,
    staleTime: 30_000,
  });
}

/** One page of the feed (Home's What's new / featured blocks). */
export function useFeedPage(params: FeedParams, enabled = true) {
  return useQuery({
    queryKey: ['feed-page', params],
    queryFn: async () => (await apiClient.get<FeedPage>(feedPath(params))).items,
    enabled,
    staleTime: 30_000,
  });
}

export function useSeries(slug: string) {
  return useQuery({
    queryKey: ['series', slug],
    queryFn: () => apiClient.get<{ series: string; items: HomepageFeedEntry[] }>(`/feed/series/${encodeURIComponent(slug)}`),
    enabled: !!slug,
    staleTime: 30_000,
  });
}
