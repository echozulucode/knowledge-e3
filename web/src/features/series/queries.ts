/**
 * The series read (home plan R2.11): the parts in reading order plus the Series
 * item that names the series, from `GET /feed/series/:slug`.
 *
 * Same endpoint and query key as the feed feature's `useSeries`, so the series
 * page and an article in the series share one cached response; this hook is
 * typed with the whole response (`series_item` included).
 */
import { useQuery } from '@tanstack/react-query';
import type { SeriesView } from '@echozedlabs/knowledge-types';
import { apiClient } from '../../api.js';

export function useSeriesView(slug: string | null | undefined) {
  return useQuery({
    queryKey: ['series', slug ?? ''],
    queryFn: () => apiClient.get<SeriesView>(`/feed/series/${encodeURIComponent(slug ?? '')}`),
    enabled: !!slug,
    staleTime: 30_000,
  });
}
