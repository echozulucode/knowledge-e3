/**
 * Pure helpers for the review queue (plan §8.2) and for the "Review" nav entry.
 */
import type { ReviewEntry, ReviewRef, SourceStatusView } from '../sources/types.js';

/** Anything that may carry a change request: an item view, a summary, a draft row. */
export interface ReviewCarrier {
  review?: ReviewRef | null;
  /** Present on lifecycle signals; listed so the carrier is not a weak type. */
  display_state?: string | null;
  frontmatter?: { review?: ReviewRef | null } | null;
}

/** The change request an item is sitting in, or `null` — closed and merged ones do not count. */
export function openReviewOf(row: ReviewCarrier | null | undefined): ReviewRef | null {
  const review = row?.review ?? row?.frontmatter?.review ?? null;
  return review?.state === 'open' ? review : null;
}

/**
 * The freshness state to render for an item: `in-review` wins over the derived
 * lifecycle state while the item's change request is open (plan §8.2).
 */
export function reviewDisplayState<T extends string>(
  displayState: T | null | undefined,
  review: ReviewRef | null | undefined,
): T | 'in-review' | undefined {
  if (review?.state === 'open') return 'in-review';
  return displayState ?? undefined;
}

/** One source's slice of the queue, as the page renders it. */
export interface ReviewGroup {
  sourceId: string;
  /** The source's remote (or local dir) — the subtitle under the group heading. */
  where: string;
  reviews: ReviewEntry[];
  isLoading: boolean;
  isError: boolean;
}

/** Only `review`-mode sources ever have change requests; the queue asks nobody else. */
export function reviewSourceIds(sources: SourceStatusView[]): string[] {
  return sources.filter((s) => s.mode === 'review').map((s) => s.id);
}

export interface RawReviewGroup {
  sourceId: string;
  reviews: ReviewEntry[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Group the queue by source, newest change request first inside each group and
 * open ones ahead of anything the host has since closed.
 */
export function groupReviewsBySource(raw: RawReviewGroup[], sources: SourceStatusView[]): ReviewGroup[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return raw.map((group) => {
    const source = byId.get(group.sourceId);
    return {
      sourceId: group.sourceId,
      where: source?.remote_url ?? source?.local_dir ?? '',
      reviews: [...group.reviews].sort(compareReviews),
      isLoading: group.isLoading,
      isError: group.isError,
    };
  });
}

function compareReviews(a: ReviewEntry, b: ReviewEntry): number {
  const openness = Number(b.review.state === 'open') - Number(a.review.state === 'open');
  if (openness !== 0) return openness;
  return String(b.review.opened_at ?? '').localeCompare(String(a.review.opened_at ?? ''));
}

/** Total change requests still open across every group. */
export function countOpenReviews(groups: { reviews: ReviewEntry[] }[]): number {
  return groups.reduce((n, g) => n + g.reviews.filter((r) => r.review.state === 'open').length, 0);
}

/**
 * Who gets the "Review" entry in the sidebar: admins (who can act on any
 * source's queue) and anyone whose own item is currently sitting in a change
 * request.
 */
export function shouldShowReviewNav(role: string | undefined, hasItemInReview: boolean): boolean {
  if (role === 'admin') return true;
  return Boolean(role) && hasItemInReview;
}
