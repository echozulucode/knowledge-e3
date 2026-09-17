/**
 * The pure half of `/search` with nothing typed (reader plan R12, UX plan §5.7):
 * turning `GET /search/overview` into the links and lines the index renders.
 *
 * A reader who does not know the right word should be one click from the
 * vocabulary — every content type, topic, category and the most-used tags, each
 * with its count, each a ready-made `/search` URL. Kept apart from the
 * component so the URL and metadata rules are tested rather than eyeballed.
 */
import type { ItemSummary, SearchFacetValue } from '@echozedlabs/knowledge-types';
import { shortDate } from '../home/storyMeta.js';

/** A topic as the index lists it: search within it, and (when resolvable) open its page. */
export interface OverviewTopic {
  label: string;
  count: number;
  /** What goes in `/search?topic=` — the slug when known, else the name the facet sent. */
  searchValue: string;
  /** The topic page's slug, or null when the overview's value cannot be matched to a topic. */
  slug: string | null;
}

/** The topic directory, as far as this module needs it (`useTopics`). */
export interface KnownTopic {
  id: string;
  slug: string;
  name: string;
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The overview's topic facet joined to the topic directory. The facet's
 * `value` is a lowercased key and `label` the display name; which key (slug or
 * name) is the server's choice, so both are tried. A topic the directory does
 * not know still gets its search link — only the page link needs a slug, and a
 * guessed slug is a link to a 404.
 */
export function overviewTopics(facet: SearchFacetValue[], known: KnownTopic[] = []): OverviewTopic[] {
  return facet.map((entry) => {
    const match = known.find((topic) => same(topic.slug, entry.value) || same(topic.id, entry.value) || same(topic.name, entry.label) || same(topic.name, entry.value));
    return { label: entry.label, count: entry.count, searchValue: match?.slug ?? entry.label, slug: match?.slug ?? null };
  });
}

/**
 * The quiet line under a recently verified / updated item: `Topic · Verified Sep 8`.
 * The date is the one the list is ordered by, so the line explains the order.
 * A verified item with no verification date falls back to its update date,
 * labelled as such rather than passed off as a verification.
 */
export function overviewItemMeta(
  item: Pick<ItemSummary, 'topic' | 'topic_name' | 'updated_at' | 'last_verified_at'>,
  list: 'verified' | 'updated',
  { now, locale }: { now?: Date; locale?: string } = {},
): string[] {
  const parts: string[] = [];
  const topic = item.topic_name?.trim() || item.topic?.trim();
  if (topic) parts.push(topic);
  const verified = list === 'verified' ? shortDate(item.last_verified_at, now, locale) : '';
  if (verified) parts.push(`Verified ${verified}`);
  else {
    const updated = shortDate(item.updated_at, now, locale);
    if (updated) parts.push(`Updated ${updated}`);
  }
  return parts;
}

/** Facet values with something to show: labelled, counted, highest count first. */
export function overviewChips(values: SearchFacetValue[]): SearchFacetValue[] {
  return values.filter((value) => value.label.trim() && value.count > 0).sort((a, b) => b.count - a.count);
}
