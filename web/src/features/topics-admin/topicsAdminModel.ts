/**
 * Pure helpers behind the Topics list, the New topic dialog and the topic edit
 * page (the admin UX review §4.5). No React, no network — every
 * rule the pages show as text (why Archive is disabled, what going Public
 * exposes, how much landing markdown is left) is decided here and unit-tested.
 *
 * Server rules mirrored, so the page says what the API will do:
 *   - archive: `SpacesService.archive` refuses the default topic and any topic
 *     with an item (drafts included — `counts.items`, not `counts.published`);
 *   - landing markdown: `UpdateTopicDto.landing_markdown`, `@MaxLength(20000)`;
 *   - start here: `@MaxLength(200)`, a slug;
 *   - visibility: public is the column default; private hides a topic from
 *     anonymous visitors only (it is not an ACL).
 */
import type { PresentationProfile } from '@echozedlabs/knowledge-types';
import { PRESENTATION_OPTIONS } from '../topic/slots.js';
import type { TopicVisibility } from '../../pages/topicCreateModel.js';

/** `DEFAULT_SPACE_ID` in server/src/taxonomy/spaces.service.ts. */
export const DEFAULT_TOPIC_ID = 'space_default';
/** `UpdateTopicDto.landing_markdown` on the server. */
export const LANDING_MARKDOWN_MAX = 20_000;

/** The fields of a `GET /topics` row these pages read. */
export interface TopicRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility?: TopicVisibility;
  presentation?: PresentationProfile;
  start_here?: string | null;
  landing_markdown?: string | null;
  counts?: { items: number; published: number; draft: number };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export function topicDisplayName(topic: Pick<TopicRow, 'name' | 'slug'>): string {
  return topic.name.trim() || topic.slug;
}

/** Absent on a topic the API answered before the field existed, which means the column default: public. */
export function topicVisibility(topic: Pick<TopicRow, 'visibility'>): TopicVisibility {
  return topic.visibility ?? 'public';
}

export function topicItemCount(topic: Pick<TopicRow, 'counts'>): number {
  return topic.counts?.items ?? 0;
}

// ------------------------------------------------------------ presentation

export interface PresentationChoice {
  value: PresentationProfile;
  label: string;
  description: string;
}

/**
 * One line per profile, in the words of what `TopicLanding` actually renders
 * for it (features/topic/TopicLanding.tsx), so the card promises the page the
 * visitor gets.
 */
export const PRESENTATION_CHOICES: readonly PresentationChoice[] = [
  { value: 'portal', label: 'Portal', description: 'A gateway: Get started, then sections under fixed headings such as Essential guidance and Examples.' },
  { value: 'blog', label: 'Blog', description: 'A feed of the topic’s posts, newest first, with an Atom feed.' },
  { value: 'docs', label: 'Docs', description: 'Sections as a side navigation, each with its items alongside.' },
  { value: 'wiki', label: 'Wiki', description: 'The description, item counts, a list of sections and a way into browse.' },
];

export function presentationLabel(value: PresentationProfile | undefined): string {
  return PRESENTATION_CHOICES.find((c) => c.value === value)?.label ?? PRESENTATION_CHOICES.find((c) => c.value === 'wiki')!.label;
}

/** Every profile the landing renders has a card (guards a profile added to `PRESENTATION_OPTIONS` without one). */
export function missingPresentationChoices(): PresentationProfile[] {
  return PRESENTATION_OPTIONS.filter((option) => !PRESENTATION_CHOICES.some((c) => c.value === option));
}

// ------------------------------------------------------------ list filters

export type TopicFilter = 'all' | 'private' | 'empty';

export const TOPIC_FILTERS: readonly { value: TopicFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'private', label: 'Private' },
  { value: 'empty', label: 'Empty' },
];

export interface TopicsSearch {
  q: string;
  filter: TopicFilter;
}

/** The router hands search values back JSON-parsed, so read everything as text. */
export function readTopicsSearch(search: Record<string, unknown> | undefined): TopicsSearch {
  const q = typeof search?.['q'] === 'string' ? (search['q'] as string) : typeof search?.['q'] === 'number' ? String(search['q']) : '';
  const filter = search?.['filter'];
  return { q, filter: TOPIC_FILTERS.some((f) => f.value === filter) ? (filter as TopicFilter) : 'all' };
}

/** Only what is set goes in the URL: `/admin/topics` for the default view. */
export function writeTopicsSearch(next: TopicsSearch): Record<string, string> {
  const out: Record<string, string> = {};
  if (next.q.trim()) out['q'] = next.q.trim();
  if (next.filter !== 'all') out['filter'] = next.filter;
  return out;
}

export function matchesTopicFilter(topic: TopicRow, filter: TopicFilter): boolean {
  if (filter === 'private') return topicVisibility(topic) === 'private';
  if (filter === 'empty') return topicItemCount(topic) === 0;
  return true;
}

/** Name, slug or description contains the query (case-insensitive), within the chosen filter; sorted by name. */
export function filterTopics<T extends TopicRow>(topics: readonly T[], search: TopicsSearch): T[] {
  const q = search.q.trim().toLowerCase();
  return topics
    .filter((topic) => matchesTopicFilter(topic, search.filter))
    .filter((topic) => !q || [topic.name, topic.slug, topic.description ?? ''].some((field) => field.toLowerCase().includes(q)))
    .sort((a, b) => topicDisplayName(a).localeCompare(topicDisplayName(b), undefined, { sensitivity: 'base' }));
}

/** How many topics each chip would show, ignoring the search box — the chip counts describe the catalog. */
export function topicFilterCounts(topics: readonly TopicRow[]): Record<TopicFilter, number> {
  return {
    all: topics.length,
    private: topics.filter((t) => matchesTopicFilter(t, 'private')).length,
    empty: topics.filter((t) => matchesTopicFilter(t, 'empty')).length,
  };
}

// ------------------------------------------------------------------ archive

/**
 * Why Archive is unavailable, as the text the menu and the danger zone show —
 * or null when it is allowed. The server enforces both rules; saying so up
 * front turns a 409 into a sentence.
 */
export function archiveBlockedReason(topic: Pick<TopicRow, 'id' | 'counts'>): string | null {
  if (topic.id === DEFAULT_TOPIC_ID) return 'The default topic cannot be archived';
  const items = topicItemCount(topic);
  if (items > 0) return `Has ${plural(items, 'item')}`;
  return null;
}

export function archiveConsequences(topic: Pick<TopicRow, 'slug' | 'name'>): string[] {
  return [
    `/topics/${topic.slug} stops working, and links to it break.`,
    `${topicDisplayName({ name: topic.name, slug: topic.slug })} leaves the topic list, search filters and pickers.`,
    'Archiving cannot be undone from Admin.',
  ];
}

// --------------------------------------------------------------- visibility

export interface VisibilityConfirmation {
  title: string;
  body: string;
  consequences: string[];
}

/**
 * The question asked before an existing private topic becomes public. The count
 * is the topic's PUBLISHED items: drafts never reach an anonymous visitor
 * whatever the topic's visibility, so counting them would overstate the
 * exposure. When the whole instance requires sign-in, nothing becomes readable
 * yet — the dialog says so rather than implying an exposure that is not there.
 */
export function makePublicConfirmation(topic: Pick<TopicRow, 'name' | 'slug' | 'counts'>, readMode: 'public' | 'authenticated' | undefined): VisibilityConfirmation {
  const name = topicDisplayName(topic);
  const published = topic.counts?.published ?? 0;
  const consequences = [
    published === 0
      ? 'No published items become readable yet; items published here later will be.'
      : `${plural(published, 'published item')} ${published === 1 ? 'becomes' : 'become'} readable by anonymous visitors.`,
    `${name} appears in the topic list, search and /topics/${topic.slug} for visitors who are not signed in.`,
    'Drafts stay visible to signed-in users only.',
  ];
  if (readMode === 'authenticated') {
    consequences.push('Reading this site currently requires signing in, so nothing is exposed until anonymous reading is turned on.');
  }
  return {
    title: `Make ${name} public?`,
    body: 'This takes effect when you save the topic.',
    consequences,
  };
}

// ---------------------------------------------------------- landing markdown

export interface MarkdownLength {
  count: number;
  max: number;
  over: boolean;
  /** "1,234 / 20,000 characters" */
  label: string;
  /** Null within the limit. */
  error: string | null;
}

/**
 * Characters as the server counts them: class-validator's `MaxLength` measures
 * `String.length` (UTF-16 code units), so an emoji counts two here as there.
 */
export function markdownLength(text: string, max = LANDING_MARKDOWN_MAX): MarkdownLength {
  const count = text.length;
  const over = count > max;
  return {
    count,
    max,
    over,
    label: `${count.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} characters`,
    error: over ? `${(count - max).toLocaleString('en-US')} ${count - max === 1 ? 'character' : 'characters'} over the limit. Shorten the landing text to save.` : null,
  };
}

// -------------------------------------------------------------------- draft

export interface TopicDraft {
  name: string;
  description: string;
  visibility: TopicVisibility;
  presentation: PresentationProfile;
  start_here: string;
  landing_markdown: string;
}

export function draftFromTopic(topic: TopicRow): TopicDraft {
  return {
    name: topicDisplayName(topic),
    description: topic.description ?? '',
    visibility: topicVisibility(topic),
    presentation: topic.presentation ?? 'wiki',
    start_here: topic.start_here ?? '',
    landing_markdown: topic.landing_markdown ?? '',
  };
}

export function isDraftDirty(initial: TopicDraft | null, draft: TopicDraft | null): boolean {
  if (!initial || !draft) return false;
  return (Object.keys(initial) as (keyof TopicDraft)[]).some((key) => initial[key] !== draft[key]);
}

export interface TopicDraftProblems {
  name?: string;
  landing_markdown?: string;
}

export function validateTopicDraft(draft: TopicDraft): TopicDraftProblems {
  const problems: TopicDraftProblems = {};
  if (!draft.name.trim()) problems.name = 'Enter a name.';
  const length = markdownLength(draft.landing_markdown);
  if (length.error) problems.landing_markdown = length.error;
  return problems;
}

/**
 * The one `PUT /topics/:id` body for a save. Every field is sent — including
 * an empty description or start here, which CLEARS it; the old rename dialog
 * sent `undefined` for an empty description, which the server reads as "leave
 * unchanged", so a description could never be removed.
 */
export function updateBodyFromDraft(draft: TopicDraft): TopicDraft {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    visibility: draft.visibility,
    presentation: draft.presentation,
    start_here: draft.start_here.trim(),
    landing_markdown: draft.landing_markdown,
  };
}

// ----------------------------------------------------------------- sections

/** The fields of a stored Section these pages read. */
export interface SectionRef {
  slug: string;
  name: string;
  space?: string;
  order?: number;
}

/** Sections whose topic is this one (stored by slug or, in older lists, by id), in landing order. */
export function sectionsOnLanding<T extends SectionRef>(sections: readonly T[], topic: Pick<TopicRow, 'id' | 'slug'>): T[] {
  return sections
    .filter((s) => s.space === topic.slug || s.space === topic.id)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
}

// --------------------------------------------------------------- start here

/** The fields of the start-here item the page can check it against. */
export interface StartHereItem {
  status: 'draft' | 'published';
  space_id?: string;
}

/**
 * A warning (never blocking) when the chosen item would not serve as this
 * landing's "Get started": missing, unpublished, or in another topic. Null
 * while the item is still loading or when all is well.
 */
export function startHereProblem(
  slug: string,
  lookup: { item: StartHereItem | undefined; missing: boolean },
  topic: Pick<TopicRow, 'id'>,
): string | null {
  if (!slug.trim()) return null;
  if (lookup.missing) return `No item uses the slug “${slug}”. The Get started button would lead nowhere.`;
  if (!lookup.item) return null;
  if (lookup.item.status !== 'published') return 'This item is a draft: visitors who are not signed in cannot open it.';
  if (lookup.item.space_id && lookup.item.space_id !== topic.id) return 'This item belongs to another topic.';
  return null;
}

// ------------------------------------------------------------- repository

/** The fields of a registered source this page reads. */
export interface TopicSourceRef {
  id: string;
  space_id: string | null;
}

/** The source registry row bound to this topic (`topic:<slug>`), if it has a dedicated repository. */
export function sourceForTopic<T extends TopicSourceRef>(sources: readonly T[] | undefined, topic: Pick<TopicRow, 'id' | 'slug'>): T | undefined {
  return sources?.find((s) => s.space_id === topic.id) ?? sources?.find((s) => s.id === `topic:${topic.slug}`);
}

// -------------------------------------------------------------------- create

/** The toast after a create, naming the repository binding when there was one. */
export function createdMessage(name: string, repoUrl: string, pull: boolean): string {
  if (!repoUrl.trim()) return `Topic created: ${name}`;
  return `Topic created: ${name} (bound to a dedicated repository${pull ? ', pulling its content' : ''})`;
}
