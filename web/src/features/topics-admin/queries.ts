/**
 * Data access for the topic edit page that the shared hooks do not cover.
 * Feature-local (like features/sources/queries.ts) so `web/src/queries.ts`
 * keeps its shape.
 */
import { apiClient } from '../../api.js';

/** An item the Start here picker offers. */
export interface StartHereOption {
  slug: string;
  title: string;
}

const START_HERE_OPTIONS = 25;

/**
 * This topic's PUBLISHED items whose title or slug contains `query`, by title —
 * what the landing's "Get started" button can sensibly point at. `GET /pages`
 * already does the matching (`q` is a title/slug substring) and the topic
 * scoping (`space`), so the picker asks it rather than loading every item.
 */
export async function loadStartHereOptions(topicSlug: string, query: string): Promise<StartHereOption[]> {
  const params = new URLSearchParams({ space: topicSlug, status: 'published', sort: 'title', limit: String(START_HERE_OPTIONS) });
  if (query.trim()) params.set('q', query.trim());
  const res = await apiClient.get<{ items: { slug: string; title: string }[] }>(`/pages?${params.toString()}`);
  return res.items.map((item) => ({ slug: item.slug, title: item.title }));
}
