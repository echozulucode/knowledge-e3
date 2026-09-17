/**
 * Topic-feature hooks (plan §3.1): the landing page (profile + landing markdown
 * + Sections resolved to items) and the presentation fields on a topic. Kept
 * out of web/src/queries.ts so the shared hook file stays untouched.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedEntry, Page, PresentationProfile, SectionView, TopicView } from '@echozedlabs/knowledge-types';
import { apiClient, type ApiError } from '../../api.js';
import type { Topic } from '../../queries.js';
import { topicFeedPath, type TopicFeedRequest } from './topicUpdatesModel.js';

/** The presentation fields `GET /topics` carries beyond the shared `Topic` type. */
export interface TopicPresentationFields {
  presentation?: PresentationProfile;
  landing_markdown?: string | null;
  start_here?: string | null;
  visibility?: 'public' | 'private';
}

export type TopicListEntry = Topic & TopicPresentationFields;

/**
 * Site-wide presentation (plan §12 decision 5). `home_topic` is null when the
 * operator has not named one, which leaves `pickHomeTopic` on its own guess.
 */
export function useSiteConfig() {
  return useQuery({
    queryKey: ['site-config'],
    queryFn: async () => {
      const res = await apiClient.get<{ home_topic: string | null }>('/site');
      return res;
    },
    staleTime: Infinity,
  });
}

export function useTopicLanding(slug: string) {
  return useQuery({
    queryKey: ['topic-landing', slug],
    queryFn: async () => {
      const res = await apiClient.get<{ topic: TopicView }>(`/topics/${encodeURIComponent(slug)}/landing`);
      return res.topic;
    },
    enabled: !!slug,
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 404 && count < 2,
    staleTime: 30_000,
  });
}

/**
 * Sections that name no topic: they draw from every topic and belong to the
 * front page alone, so they arrive on their own route rather than folded into a
 * topic's landing. Resolved server-side for the caller, which is what keeps a
 * private topic's items off the page for an anonymous visitor.
 */
export function useCrossTopicSections() {
  return useQuery({
    queryKey: ['sections', 'cross-topic'],
    queryFn: async () => {
      const res = await apiClient.get<{ sections: SectionView[] }>('/sections/cross-topic');
      return res.sections;
    },
    staleTime: 30_000,
  });
}

/**
 * One page of a topic's feed for its Updates block: the tagged list, or the
 * "Recently updated" fallback when `tags` is absent. `enabled` lets the page
 * ask for the fallback only once it knows the tagged list came back empty.
 */
export function useTopicFeed(req: TopicFeedRequest, enabled = true) {
  return useQuery({
    queryKey: ['topic-feed', req.topic, req.tags ?? [], req.type ?? '', req.limit ?? 0],
    queryFn: async () => (await apiClient.get<Page<FeedEntry>>(topicFeedPath(req))).items,
    enabled: enabled && !!req.topic,
    staleTime: 30_000,
  });
}

export function useUpdateTopicPresentation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & TopicPresentationFields & { name?: string; description?: string }) => {
      const { id, ...body } = input;
      const res = await apiClient.put<{ topic: TopicListEntry }>(`/topics/${encodeURIComponent(id)}`, body);
      return res.topic;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      queryClient.invalidateQueries({ queryKey: ['topic-landing'] });
    },
  });
}
