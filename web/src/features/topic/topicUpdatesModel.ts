/**
 * Pure helpers for a topic page's "what is happening here" band (home plan R3):
 * the Updates block — this topic's items carrying the site's Updates tags, or
 * its newest items when nothing is tagged — and the "Popular in <topic>" list.
 *
 * Kept pure so the request shape, the threshold and the wording are unit-tested
 * rather than eyeballed in a browser.
 */
import type { FeedEntry, PopularEntry, SectionView } from '@echozedlabs/knowledge-types';

/** Rows the Updates block shows; the "View all" link carries the rest. */
export const TOPIC_UPDATES_LIMIT = 5;

/** Rows the Popular list asks for. */
export const TOPIC_POPULAR_LIMIT = 5;

/**
 * The fewest ranked items before "Popular in <topic>" appears at all. Below
 * three, "popular" is noise: a list of one is just "the thing somebody opened",
 * and two readers splitting between two items ranks nothing — the order is a
 * coin toss dressed as a signal. Three is the smallest list whose first place
 * says something about the others.
 */
export const POPULAR_MIN_ITEMS = 3;

/**
 * What the Updates block asks the feed for. `tags` set = the tagged Updates
 * list; absent = the "Recently updated" fallback.
 */
export interface TopicFeedRequest {
  topic: string;
  tags?: string[];
  /** The Updates Section's own type filter, when its curator set one. */
  type?: string;
  limit?: number;
}

/**
 * `GET /feed` for a topic's Updates block. Without a type the request says
 * `all_types=1`: a Section names no type unless its curator chose one, and the
 * feed's default (Blog Post, Release Note) would leave a topic of Concepts or
 * How-tos with an empty block — the one thing the fallback exists to prevent.
 */
export function topicFeedPath({ topic, tags, type, limit = TOPIC_UPDATES_LIMIT }: TopicFeedRequest): string {
  const q = new URLSearchParams();
  q.set('topic', topic);
  if (tags?.length) q.set('tags', tags.join(','));
  if (type?.trim()) q.set('types', type.trim());
  else q.set('all_types', '1');
  q.set('limit', String(limit));
  return `/feed?${q.toString()}`;
}

/**
 * The site's cross-topic Updates Section's tag rule, or null when there is none
 * to mirror. The Section is the one Home leads with (`pickUpdatesSection`); one
 * that filters by type alone is not a tag-driven Updates feed, and borrowing
 * only its type would show a topic's every Blog Post under "Updates".
 */
export function updatesRule(lead: SectionView | undefined): { name: string; tags: string[]; type?: string } | null {
  const tags = (lead?.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (!lead || tags.length === 0) return null;
  return { name: lead.name, tags, ...(lead.type?.trim() ? { type: lead.type.trim() } : {}) };
}

/**
 * `Sep 8` inside the current year, `Sep 8, 2025` outside it; empty when the
 * value does not parse, so a bad date costs the line one part, not "Invalid Date".
 */
export function shortDate(iso: string | null | undefined, now: Date = new Date(), locale?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * `Sep 8 · 4 min read` — date, then reading time, each only when known. No
 * topic label: the reader is already on the topic, and naming it on every row
 * would be the one fact identical on all of them.
 */
export function topicUpdateMeta(entry: FeedEntry, now: Date = new Date(), locale?: string): string[] {
  const parts: string[] = [];
  const date = shortDate(entry.published_at ?? entry.updated_at, now, locale);
  if (date) parts.push(date);
  if (entry.reading_time_minutes && entry.reading_time_minutes > 0) parts.push(`${entry.reading_time_minutes} min read`);
  return parts;
}

/** `1 reader`, `12 readers`. */
export function readersLabel(views: number): string {
  return `${views} ${views === 1 ? 'reader' : 'readers'}`;
}

/** The Popular list's rows, or nothing when there are too few to rank (see `POPULAR_MIN_ITEMS`). */
export function popularToShow(items: PopularEntry[] | undefined): PopularEntry[] {
  const ranked = (items ?? []).filter((i) => i.views > 0);
  return ranked.length >= POPULAR_MIN_ITEMS ? ranked : [];
}

/**
 * Where "View all …" goes: `/search` narrowed to this topic (and the Updates
 * tags, when the block is the tagged list), newest first. Search already takes
 * every one of those filters in its URL, so this is a link, not a new page.
 */
export function viewAllSearch(topic: string, tags?: string[]): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = { topic, sort: 'newest' };
  if (tags?.length) params['tag'] = tags.length === 1 ? tags[0]! : tags;
  return params;
}
