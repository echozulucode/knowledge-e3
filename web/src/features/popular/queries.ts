/**
 * "Popular" (home plan R3): the most-read published items in a window, site-wide
 * or for one topic, from `GET /popular`. Aggregate counts of distinct signed-in
 * readers; the list never identifies a reader.
 */
import { useQuery } from '@tanstack/react-query';
import type { PopularView } from '@echozedlabs/knowledge-types';
import { apiClient } from '../../api.js';

export interface PopularParams {
  /** Topic slug; omitted = site-wide. */
  topic?: string;
  limit?: number;
  /** Look-back window in days (server default 30). */
  days?: number;
}

export function popularPath({ topic, limit, days }: PopularParams): string {
  const q = new URLSearchParams();
  if (topic) q.set('topic', topic);
  if (limit) q.set('limit', String(limit));
  if (days) q.set('days', String(days));
  return `/popular${q.size ? `?${q.toString()}` : ''}`;
}

export function usePopular(params: PopularParams) {
  return useQuery({
    queryKey: ['popular', params.topic ?? '', params.limit ?? 0, params.days ?? 0],
    queryFn: () => apiClient.get<PopularView>(popularPath(params)),
    staleTime: 60_000,
  });
}
