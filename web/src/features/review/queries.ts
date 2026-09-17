/**
 * Review-queue hooks (plan §8.2).
 *
 * The queue itself is served by the admin source routes (see
 * `features/sources/queries.ts`). What lives here is the author's side: someone
 * who is not an admin still needs a way back to an item of theirs sitting in a
 * change request, so we look for one on their own drafts — the only rows a
 * non-admin may list that can carry an open review.
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../api.js';
import { useMe } from '../../queries.js';
import { openReviewOf, shouldShowReviewNav } from './reviewModel.js';
import type { ReviewEntry, ReviewRef } from '../sources/types.js';

/** A draft as the list route returns it, with only the fields this gate reads. */
export interface DraftRow {
  id: string;
  slug?: string | null;
  title?: string | null;
  review?: ReviewRef | null;
  display_state?: string | null;
  frontmatter?: { review?: ReviewRef | null } | null;
}

const MY_REVIEWS = ['me', 'items-in-review'] as const;

async function fetchMyReviews(): Promise<ReviewEntry[]> {
  const res = await apiClient.get<{ items: DraftRow[] }>('/pages?status=draft&limit=50');
  const entries: ReviewEntry[] = [];
  for (const row of res.items ?? []) {
    const review = openReviewOf(row);
    if (review) entries.push({ page_id: row.id, slug: row.slug ?? null, title: row.title ?? null, review });
  }
  return entries;
}

/** The signed-in author's own items sitting in a change request. */
export function useMyItemsInReview(enabled: boolean) {
  return useQuery({
    queryKey: MY_REVIEWS,
    queryFn: fetchMyReviews,
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Whether the "Review" sidebar entry is shown for the current viewer. */
export function useReviewNavVisible(): boolean {
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const { data: mine } = useMyItemsInReview(Boolean(me) && !isAdmin);
  return shouldShowReviewNav(me?.role, (mine?.length ?? 0) > 0);
}
