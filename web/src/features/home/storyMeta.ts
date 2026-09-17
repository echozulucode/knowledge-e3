/**
 * The one metadata line a story carries on the home page's Updates feed (home
 * plan R2.4, R2.11) — pure, so the grammar is unit-tested rather than eyeballed.
 *
 * The line replaced a row of chips (content type, freshness, trust) that sat on
 * every card and competed with the title. What survives is the facts a reader
 * uses to decide whether to open a story, in the order they read them:
 *
 *   lead story:  `Architecture · Ada Lovelace · Sep 8 · 4 min read`
 *   list rows:   `Architecture · Blog Post · Sep 8 · 4 min read`
 *
 * The lead names its author because it is the story the page is inviting you to
 * read — the Hashnode pattern Eric asked for — while a row is one of several and
 * its kind is the more useful fact. A lead with no author falls back to its kind
 * rather than to nothing, so the two lines keep the same shape.
 *
 * The topic leads both lines because the feed is cross-topic (Eric, after using
 * it: show which topic each story is in). It is returned separately by
 * `storyTopic` rather than folded into `storyMetaParts`, because the page
 * renders it as a link and every other part as text.
 */
import type { FeedEntry } from '@echozedlabs/knowledge-types';

/**
 * `Sep 8` inside the current year, `Sep 8, 2025` outside it. A feed is read
 * against "now", and a year on every line is noise until it is the thing that
 * tells a stale story from a fresh one. Empty on an unparseable value, so a
 * missing date costs the line one part rather than rendering "Invalid Date".
 */
export function shortDate(iso: string | null | undefined, now: Date = new Date(), locale?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface StoryMetaOptions {
  /** The lead story names its author; a row names its content type. */
  lead?: boolean;
  now?: Date;
  locale?: string;
}

/** The text parts of a story's metadata line, present only when known. */
export function storyMetaParts(entry: FeedEntry, { lead = false, now, locale }: StoryMetaOptions = {}): string[] {
  const parts: string[] = [];
  const authors = (entry.authors ?? []).map((a) => a.trim()).filter(Boolean);
  const kind = entry.type?.trim() || '';
  const first = lead && authors.length ? authors.join(', ') : kind;
  if (first) parts.push(first);
  const date = shortDate(entry.published_at ?? entry.updated_at, now, locale);
  if (date) parts.push(date);
  if (entry.reading_time_minutes && entry.reading_time_minutes > 0) parts.push(`${entry.reading_time_minutes} min read`);
  return parts;
}

/** The topic a story is labelled with: its display name, and the slug to link it by when known. */
export interface StoryTopic {
  name: string;
  slug: string | null;
}

/**
 * The story's topic label, or null when the payload names none. Only the
 * display name is ever shown — a raw slug on a front page reads as a bug — so
 * an entry with a slug and no name gets no label rather than `default`.
 */
export function storyTopic(entry: Pick<FeedEntry, 'topic' | 'topic_name'>): StoryTopic | null {
  const name = entry.topic_name?.trim();
  if (!name) return null;
  return { name, slug: entry.topic?.trim() || null };
}
