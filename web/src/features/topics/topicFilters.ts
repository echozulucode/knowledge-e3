import type { Page, Topic } from '../../queries.js';

export const UNASSIGNED_TOPIC_VALUE = '__unassigned';

export type TopicLookup = Map<string, Topic>;

export interface ActiveTopicFilter {
  kind: 'all' | 'topic' | 'unassigned';
  label: string;
  value?: string;
}

export interface TopicDirectoryRow {
  id: string;
  value: string;
  slug: string;
  label: string;
  description: string | null;
  count: number;
  updatedAt?: string;
  kind: 'topic' | 'unassigned';
}

export function displayFromSlug(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function slugifyFilterValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeFilterValue(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizedFilterCandidates(...values: Array<string | undefined | null>): string[] {
  return values
    .flatMap((value) => {
      const raw = value?.trim();
      if (!raw) return [];
      if (raw === UNASSIGNED_TOPIC_VALUE) return [UNASSIGNED_TOPIC_VALUE];
      return [raw, displayFromSlug(raw), slugifyFilterValue(raw)];
    })
    .map(normalizeFilterValue)
    .filter(Boolean);
}

export function matchesFilter(value: string | undefined | null, candidates: string[]): boolean {
  if (candidates.length === 0) return true;
  if (!value?.trim()) return false;
  const normalized = normalizeFilterValue(value);
  const slugified = slugifyFilterValue(value);
  return candidates.includes(normalized) || candidates.includes(slugified);
}

export function frontmatterString(page: Page, key: string): string | undefined {
  const value = page.frontmatter?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function buildTopicLookup(topics: Topic[]): TopicLookup {
  const lookup = new Map<string, Topic>();
  for (const topic of topics) {
    lookup.set(topic.id, topic);
    lookup.set(topic.slug, topic);
    lookup.set(slugifyFilterValue(topic.name), topic);
  }
  return lookup;
}

export function displayTopic(topic: Topic): string {
  return topic.name.trim() || displayFromSlug(topic.slug);
}

export function topicForPage(page: Page, topicLookup?: TopicLookup): string | undefined {
  if (page.space_id?.trim()) {
    const apiTopic = topicLookup?.get(page.space_id.trim());
    if (apiTopic) return displayTopic(apiTopic);
  }
  const frontmatterTopic = frontmatterString(page, 'topic') ?? frontmatterString(page, 'space');
  if (frontmatterTopic?.trim()) return frontmatterTopic.trim();
  if (page.space_id === 'space_default') return 'Default space';
  if (page.space_id?.trim()) return displayFromSlug(page.space_id.replace(/^space_/, ''));
  return undefined;
}

export function isUnassignedTopicCandidates(candidates: string[]): boolean {
  return candidates.includes(UNASSIGNED_TOPIC_VALUE);
}

export function topicMatchesFilter(page: Page, candidates: string[], topicLookup?: TopicLookup): boolean {
  if (candidates.length === 0) return true;
  if (isUnassignedTopicCandidates(candidates)) return !topicForPage(page, topicLookup);
  // A space's slug, id, and display name can all diverge (e.g. slug "game-dev"
  // vs name "Game Development"). Match a candidate against *any* identifier for
  // the page's space so a filter chosen by slug still hits pages resolved by name.
  const ids: string[] = [];
  const sid = page.space_id?.trim();
  if (sid) {
    ids.push(sid, sid.replace(/^space_/, ''));
    const t = topicLookup?.get(sid);
    if (t) ids.push(t.slug, t.name, slugifyFilterValue(t.name));
  }
  const fmTopic = frontmatterString(page, 'topic') ?? frontmatterString(page, 'space');
  if (fmTopic) ids.push(fmTopic);
  const display = topicForPage(page, topicLookup);
  if (display) ids.push(display);
  return ids.some((value) => matchesFilter(value, candidates));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

export function buildTopicOptions({ topics }: { pages: Page[]; topics: Topic[] }): string[] {
  const apiTopics = topics.map(displayTopic);
  return uniqueSorted(apiTopics);
}

export function describeActiveTopicFilter(search: { topic?: string; space?: string }, topicLookup?: TopicLookup): ActiveTopicFilter {
  const rawValue = search.topic?.trim() || search.space?.trim();
  if (!rawValue) return { kind: 'all', label: 'All spaces', value: undefined };
  if (rawValue === UNASSIGNED_TOPIC_VALUE) return { kind: 'unassigned', label: 'Unassigned', value: UNASSIGNED_TOPIC_VALUE };
  const topic = topicLookup?.get(rawValue) ?? topicLookup?.get(slugifyFilterValue(rawValue));
  return { kind: 'topic', label: topic ? displayTopic(topic) : displayFromSlug(rawValue), value: rawValue };
}

export function buildTopicDirectory({ pages, topics }: { pages: Page[]; topics: Topic[] }): TopicDirectoryRow[] {
  const topicLookup = buildTopicLookup(topics);
  const rows: TopicDirectoryRow[] = topics
    .map((topic): TopicDirectoryRow => {
      const label = displayTopic(topic);
      const candidates = normalizedFilterCandidates(topic.slug, topic.id, label);
      const count = pages.filter((page) => topicMatchesFilter(page, candidates, topicLookup)).length;
      return {
        id: topic.id,
        value: topic.slug,
        slug: topic.slug,
        label,
        description: topic.description,
        count,
        updatedAt: topic.updated_at,
        kind: 'topic' as const,
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const unassignedCount = pages.filter((page) => !topicForPage(page, topicLookup)).length;
  if (unassignedCount > 0) {
    rows.push({
      id: UNASSIGNED_TOPIC_VALUE,
      value: UNASSIGNED_TOPIC_VALUE,
      slug: UNASSIGNED_TOPIC_VALUE,
      label: 'Unassigned',
      description: 'Items without a space yet',
      count: unassignedCount,
      kind: 'unassigned',
    });
  }

  return rows;
}
