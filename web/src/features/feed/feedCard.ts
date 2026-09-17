/**
 * Pure mapping from a feed entry to what a card shows, so the card stays a
 * dumb renderer and the mapping is unit-testable.
 */
import type { DisplayState, FeedEntry } from '@echozedlabs/knowledge-types';
import { itemPreview } from '@echozedlabs/ui';
import { formatDate } from '../blog/blogMeta.js';
import { openReviewOf, reviewDisplayState } from '../review/reviewModel.js';

export interface FeedCard {
  slug: string;
  title: string;
  /**
   * The item's own line about itself, from the shared `itemPreview` rule
   * (plan R1.4) rather than a fourth description-only read. The feed payload
   * carries only `description` today (`toSummary` in the server's
   * knowledge-query service), so in practice the rule resolves to the same
   * string — but it resolves it the same WAY as every other surface, and gains
   * the summary/body fallbacks the moment the payload carries them.
   */
  preview: string | null;
  cover: string | null;
  type: string | null;
  /** "By Ada, Grace · Mar 3, 2026 · 4 min read" parts, present only when known. */
  byline: string[];
  series: string | null;
  seriesOrder: number | null;
  /**
   * The freshness state the card's badge shows. `in-review` while the item's
   * change request is open (plan §8.2) — the same rule the read page applies.
   */
  displayState: DisplayState | undefined;
  /** Change-request URL when `displayState` is `in-review`, so the badge can link to it. */
  reviewUrl: string | null;
}

export function toFeedCard(entry: FeedEntry): FeedCard {
  const openReview = openReviewOf(entry);
  const byline: string[] = [];
  if (entry.authors?.length) byline.push(`By ${entry.authors.join(', ')}`);
  const date = formatDate(entry.published_at ?? entry.updated_at);
  if (date) byline.push(date);
  if (entry.reading_time_minutes) byline.push(`${entry.reading_time_minutes} min read`);
  return {
    slug: entry.slug,
    title: entry.title,
    preview: itemPreview(entry),
    cover: entry.cover?.trim() || null,
    type: entry.type,
    byline,
    series: entry.series?.trim() || null,
    seriesOrder: entry.series_order ?? null,
    displayState: reviewDisplayState(entry.display_state, openReview),
    reviewUrl: openReview?.url ?? null,
  };
}
