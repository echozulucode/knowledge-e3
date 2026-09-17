/**
 * Sections admin model (the admin UX review §4.1): everything the
 * Sections list and the Section edit page decide, as pure functions.
 *
 * The storage is one whole-list `PUT /sections`, but the admin edits ONE
 * section at a time. So every write here is "take the list as it is now, change
 * one entry, write the list back" — `upsertSection`, `removeSection`,
 * `applyGroupOrder` — and never "write the list this page loaded", which would
 * silently undo whatever another admin saved in between.
 *
 * Several rules here MIRROR the server or the reader pages rather than invent
 * anything; each says where its original lives, because the two must agree:
 *   - slugs: `slugifySection` in server/src/config/config.service.ts;
 *   - normalisation (trim, tags de-duped and sorted): `setSections`, same file;
 *   - the front-page lead: `pickUpdatesSection` in features/topic/slots.ts,
 *     after the server drops empty sections (`crossTopicSections`);
 *   - where Slot matters: `orderPortalSections` on portal topic landings AND on
 *     the front page (pages/Home.tsx renders the home topic's sections and the
 *     non-lead cross-topic ones through it).
 */
import type { PresentationProfile, SectionSlot } from '@echozedlabs/knowledge-types';
import { SLOT_HEADINGS } from '../features/topic/slots.js';

/** A stored Section, as `GET /sections` returns it. Structurally `Section` in queries.ts. */
export interface SectionDef {
  slug: string;
  name: string;
  description?: string;
  type?: string;
  space?: string;
  tags?: string[];
  slot?: SectionSlot;
  order?: number;
  limit?: number;
}

/** The fields of a topic this page needs (`GET /topics` carries them for an admin). */
export interface TopicRef {
  id: string;
  slug: string;
  name: string;
  presentation?: PresentationProfile;
  visibility?: 'public' | 'private';
}

/** Mirrors `SECTION_LIMIT_MAX` in server/src/config/config.service.ts. */
export const SECTION_LIMIT_MIN = 1;
export const SECTION_LIMIT_MAX = 50;
/** Mirrors `SECTION_DEFAULT_LIMIT` in server/src/query/knowledge-query.service.ts — what a section without a limit shows. */
export const SECTION_DEFAULT_LIMIT = 10;
/** Gap between orders written by a reorder, so a later hand edit can slot between two. */
export const ORDER_STEP = 10;

/** Placement key for sections that name no topic. Not a valid topic slug, so it cannot collide. */
export const FRONT_PAGE_KEY = '__front-page__';
export const FRONT_PAGE_LABEL = 'Front page';

export const ZERO_MATCHES_TITLE = 'Hidden on the site: matches no items';

/**
 * Mirrors `slugifySection` on the server exactly (no diacritic folding, unlike
 * `common/slug.ts`), so the slug shown before saving is the slug that is stored.
 */
export function slugifySection(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Trim, drop blanks, de-dupe, sort — `normalizeSectionTags` on the server. Case is kept: stored tags match verbatim. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  return Array.from(new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))).sort();
}

/** The section as the server would store it, so two versions compare by meaning rather than by whitespace. */
export function normalizeSection(s: SectionDef): SectionDef {
  const tags = normalizeTags(s.tags);
  return {
    slug: slugifySection(s.slug || s.name),
    name: s.name.trim(),
    ...(s.description?.trim() ? { description: s.description.trim() } : {}),
    ...(s.type?.trim() ? { type: s.type.trim() } : {}),
    ...(s.space?.trim() ? { space: s.space.trim() } : {}),
    ...(tags.length ? { tags } : {}),
    ...(s.slot !== undefined && s.slot !== 'none' ? { slot: s.slot } : {}),
    ...(s.order !== undefined ? { order: s.order } : {}),
    ...(s.limit !== undefined ? { limit: s.limit } : {}),
  };
}

export function sameSection(a: SectionDef | undefined, b: SectionDef | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(normalizeSection(a)) === JSON.stringify(normalizeSection(b));
}

/** The server's order: ascending `order`, unordered last, then name. */
export function byOrderThenName(a: SectionDef, b: SectionDef): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  return ao - bo || a.name.localeCompare(b.name);
}

/** A section's `space` may be a topic slug or id (the server resolves either). */
export function findTopic(space: string | undefined, topics: readonly TopicRef[]): TopicRef | undefined {
  if (!space) return undefined;
  return topics.find((t) => t.slug === space || t.id === space);
}

export function placementKey(section: Pick<SectionDef, 'space'>, topics: readonly TopicRef[]): string {
  if (!section.space?.trim()) return FRONT_PAGE_KEY;
  return findTopic(section.space, topics)?.slug ?? section.space;
}

/**
 * The front page's lead: the lowest-ordered cross-topic section — but only
 * among those that resolve to something, because the server drops empty ones
 * before `pickUpdatesSection` sees them. `matchCounts` is that input; an
 * unknown count (still loading) is treated as non-empty so the chip does not
 * flicker between rows while counts arrive.
 */
export function leadSlug(sections: readonly SectionDef[], matchCounts?: Readonly<Record<string, number | undefined>>): string | undefined {
  return [...sections]
    .filter((s) => !s.space?.trim())
    .sort(byOrderThenName)
    .find((s) => matchCounts?.[s.slug] !== 0)?.slug;
}

/**
 * Whether Slot changes anything for a section with this topic. True on the
 * front page (cross-topic and home-topic sections render below the fold under
 * slot headings, pages/Home.tsx) and on a portal topic's landing; a wiki, blog
 * or docs landing orders by `order` alone and ignores it.
 */
export function slotApplies(space: string | undefined, topics: readonly TopicRef[], homeTopicSlug: string | undefined): boolean {
  if (!space?.trim()) return true;
  const topic = findTopic(space, topics);
  if (!topic) return false;
  return topic.presentation === 'portal' || topic.slug === homeTopicSlug;
}

export interface PlacementGroup {
  key: string;
  label: string;
  kind: 'front-page' | 'topic';
  topic?: TopicRef;
  /** Already in display order. */
  sections: SectionDef[];
}

function topicGroupLabel(key: string, topic: TopicRef | undefined, homeTopicSlug: string | undefined): string {
  if (!topic) return `Topic: ${key} (not found)`;
  const notes = [topic.presentation, topic.slug === homeTopicSlug ? 'home topic' : undefined, topic.visibility === 'private' ? 'private' : undefined].filter(Boolean);
  return `Topic: ${topic.name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/** Front page first, then one group per topic by name — the order a curator reads the site in. */
export function groupSections(sections: readonly SectionDef[], topics: readonly TopicRef[], homeTopicSlug?: string): PlacementGroup[] {
  const byKey = new Map<string, SectionDef[]>();
  for (const s of sections) {
    const key = placementKey(s, topics);
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  const groups: PlacementGroup[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort(byOrderThenName);
    if (key === FRONT_PAGE_KEY) {
      groups.push({ key, label: `${FRONT_PAGE_LABEL} (cross-topic)`, kind: 'front-page', sections: sorted });
    } else {
      const topic = findTopic(key, topics);
      groups.push({ key, label: topicGroupLabel(key, topic, homeTopicSlug), kind: 'topic', ...(topic ? { topic } : {}), sections: sorted });
    }
  }
  return groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'front-page' ? -1 : 1;
    return (a.topic?.name ?? a.key).localeCompare(b.topic?.name ?? b.key);
  });
}

export interface SectionFilter {
  query?: string;
  /** `all`, `FRONT_PAGE_KEY`, or a topic slug. */
  placement?: string;
}

export function filterSections(sections: readonly SectionDef[], topics: readonly TopicRef[], filter: SectionFilter): SectionDef[] {
  const needle = filter.query?.trim().toLowerCase() ?? '';
  const placement = filter.placement && filter.placement !== 'all' ? filter.placement : undefined;
  return sections.filter((s) => {
    if (placement && placementKey(s, topics) !== placement) return false;
    if (!needle) return true;
    const topicName = findTopic(s.space, topics)?.name ?? s.space ?? '';
    return [s.name, s.slug, s.type ?? '', s.description ?? '', topicName, ...(s.tags ?? [])].some((v) => v.toLowerCase().includes(needle));
  });
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function placementName(space: string | undefined, topics: readonly TopicRef[]): string {
  if (!space?.trim()) return FRONT_PAGE_LABEL;
  return findTopic(space, topics)?.name ?? space;
}

/** The slugs of a placement group, in display order. */
export function groupSlugs(sections: readonly SectionDef[], key: string, topics: readonly TopicRef[]): string[] {
  return sections.filter((s) => placementKey(s, topics) === key).sort(byOrderThenName).map((s) => s.slug);
}

/** "2nd of 3 on Front page" — where a section sits among its placement group. Undefined when it is not in the list. */
export function positionLabel(slug: string, sections: readonly SectionDef[], topics: readonly TopicRef[]): { index: number; count: number; label: string } | undefined {
  const section = sections.find((s) => s.slug === slug);
  if (!section) return undefined;
  const slugs = groupSlugs(sections, placementKey(section, topics), topics);
  const index = slugs.indexOf(slug);
  return { index, count: slugs.length, label: `${ordinal(index + 1)} of ${slugs.length} on ${placementName(section.space, topics)}` };
}

/**
 * Write the group's order as 10, 20, 30 in the given sequence. Sections outside
 * `orderedSlugs` keep theirs: groups never share a page, so their orders never
 * compete.
 */
export function applyGroupOrder(sections: readonly SectionDef[], orderedSlugs: readonly string[]): SectionDef[] {
  const position = new Map(orderedSlugs.map((slug, i) => [slug, (i + 1) * ORDER_STEP]));
  return sections.map((s) => (position.has(s.slug) ? { ...s, order: position.get(s.slug)! } : s));
}

/**
 * Undo of a reorder: put back the `order` each of `slugs` had in `before`
 * (exact values, which need not have been 10/20/30), leaving every other
 * section — including ones edited meanwhile — as it is now.
 */
export function restoreOrders(sections: readonly SectionDef[], before: readonly SectionDef[], slugs: readonly string[]): SectionDef[] {
  const previous = new Map(before.map((s) => [s.slug, s.order]));
  return sections.map((s) => {
    if (!slugs.includes(s.slug) || !previous.has(s.slug)) return s;
    const { order: _order, ...rest } = s;
    const order = previous.get(s.slug);
    return order === undefined ? rest : { ...rest, order };
  });
}

/** Move one slug within an ordered list; out-of-range moves return the list unchanged. */
export function moveSlug(slugs: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= slugs.length || to < 0 || to >= slugs.length || from === to) return [...slugs];
  const next = [...slugs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Move a section up (-1) or down (+1) within its placement group, rewriting that group's order. */
export function moveInGroup(sections: readonly SectionDef[], slug: string, delta: -1 | 1, topics: readonly TopicRef[]): SectionDef[] {
  const section = sections.find((s) => s.slug === slug);
  if (!section) return [...sections];
  const slugs = groupSlugs(sections, placementKey(section, topics), topics);
  const from = slugs.indexOf(slug);
  return applyGroupOrder(sections, moveSlug(slugs, from, from + delta));
}

/**
 * The order a NEW section takes: after the last one in its group. Without it
 * a new section is unordered, sorts last — and a new cross-topic section on an
 * instance whose sections have no orders could quietly become the lead.
 */
export function nextOrderInGroup(sections: readonly SectionDef[], space: string | undefined, topics: readonly TopicRef[]): number {
  const key = placementKey({ space }, topics);
  const orders = sections.filter((s) => placementKey(s, topics) === key).map((s) => s.order ?? 0);
  return (orders.length ? Math.max(...orders) : 0) + ORDER_STEP;
}

/** Replace the entry named `originalSlug` in place, or append when there is none (a create). */
export function upsertSection(sections: readonly SectionDef[], originalSlug: string | null, next: SectionDef): SectionDef[] {
  const at = originalSlug ? sections.findIndex((s) => s.slug === originalSlug) : -1;
  if (at === -1) return [...sections, next];
  return sections.map((s, i) => (i === at ? next : s));
}

export function removeSection(sections: readonly SectionDef[], slug: string): SectionDef[] {
  return sections.filter((s) => s.slug !== slug);
}

/** Undo of a delete: put it back unless someone has since created that slug. */
export function restoreSection(sections: readonly SectionDef[], removed: SectionDef): SectionDef[] {
  return sections.some((s) => s.slug === removed.slug) ? [...sections] : [...sections, removed];
}

export function uniqueSlug(base: string, taken: readonly string[]): string {
  const root = slugifySection(base) || 'section';
  if (!taken.includes(root)) return root;
  for (let n = 2; ; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Form state for the edit page. Strings for the inputs; `sectionFromDraft` makes the stored shape. */
export interface SectionDraft {
  name: string;
  slug: string;
  description: string;
  type: string;
  space: string;
  tags: string[];
  slot: SectionSlot;
  /** '' while the stepper is cleared mid-edit. */
  limit: number | '';
}

export function draftFromSection(section: SectionDef | undefined): SectionDraft {
  return {
    name: section?.name ?? '',
    slug: section?.slug ?? '',
    description: section?.description ?? '',
    type: section?.type ?? '',
    space: section?.space ?? '',
    tags: [...(section?.tags ?? [])],
    slot: section?.slot ?? 'none',
    limit: section?.limit ?? SECTION_DEFAULT_LIMIT,
  };
}

/** "Duplicate" prefill: same filters, a copy's name and a slug nobody has. */
export function duplicateDraft(section: SectionDef, sections: readonly SectionDef[]): SectionDraft {
  const name = `${section.name} (copy)`;
  return { ...draftFromSection(section), name, slug: uniqueSlug(`${section.slug}-copy`, sections.map((s) => s.slug)) };
}

/** The stored shape. `order` comes from the caller: kept on edit, `nextOrderInGroup` on create or a topic change. */
export function sectionFromDraft(draft: SectionDraft, order: number | undefined): SectionDef {
  return normalizeSection({
    slug: draft.slug || slugifySection(draft.name),
    name: draft.name,
    description: draft.description,
    type: draft.type,
    space: draft.space,
    tags: draft.tags,
    slot: draft.slot,
    ...(order !== undefined ? { order } : {}),
    ...(draft.limit !== '' ? { limit: draft.limit } : {}),
  });
}

export interface SectionProblems {
  name?: string;
  slug?: string;
  limit?: string;
}

/**
 * Blocking problems only. Zero matches is deliberately NOT here: a tag nobody
 * has used yet is the normal first state of a section (the server drops it
 * from the site until something matches), so it warns and never blocks.
 */
export function validateSection(draft: SectionDraft, sections: readonly SectionDef[], originalSlug: string | null): SectionProblems {
  const problems: SectionProblems = {};
  if (!draft.name.trim()) problems.name = 'Enter a name.';
  const slug = draft.slug || slugifySection(draft.name);
  if (!slug) {
    if (!problems.name) problems.slug = 'The URL needs at least one letter or number.';
  } else if (slugifySection(slug) !== slug) {
    problems.slug = 'Use lowercase letters, numbers and single hyphens only.';
  } else if (slug !== originalSlug && sections.some((s) => s.slug === slug)) {
    problems.slug = `Another section already uses /sections/${slug}.`;
  }
  if (draft.limit === '' || !Number.isInteger(draft.limit) || draft.limit < SECTION_LIMIT_MIN || draft.limit > SECTION_LIMIT_MAX) {
    problems.limit = `Enter a whole number from ${SECTION_LIMIT_MIN} to ${SECTION_LIMIT_MAX}.`;
  }
  return problems;
}

export function hasProblems(problems: SectionProblems): boolean {
  return Object.values(problems).some(Boolean);
}

/**
 * The registry label for a stored `type`, matched the way the server's
 * `findContentType` matches (label in any case, or the slugified key), so a
 * section saved as `faq` shows — and is picked — as `FAQ`. Undefined for a type
 * the registry does not know; OKF types are permissive and such a section still
 * matches items typed exactly that.
 */
export function findContentTypeLabel(type: string | undefined, types: readonly { key: string; label: string }[] | undefined): string | undefined {
  const trimmed = type?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const key = slugifySection(trimmed);
  return types?.find((t) => t.label.toLowerCase() === lower || t.key === key)?.label;
}

/** Visible label for a Slot choice. */
export function slotOptionLabel(slot: SectionSlot): string {
  if (slot === 'none') return 'None — listed under its own name';
  if (slot === 'start-here') return 'Start here — the Get started button';
  return SLOT_HEADINGS[slot];
}

/** The `/pages` filters that reproduce what the site resolves for a section (published only). */
export function matchFilters(section: Pick<SectionDef, 'type' | 'space' | 'tags'>): { status: 'published'; type?: string; space?: string; tags?: string[] } {
  const tags = normalizeTags(section.tags);
  return {
    status: 'published',
    ...(section.type?.trim() ? { type: section.type.trim() } : {}),
    ...(section.space?.trim() ? { space: section.space.trim() } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

/** Where the section shows, in the words the preview uses. */
export function appearsOn(section: Pick<SectionDef, 'slug' | 'space' | 'slot'>, topics: readonly TopicRef[], homeTopicSlug: string | undefined, isLead: boolean): string[] {
  const heading = section.slot && section.slot !== 'none' && section.slot !== 'start-here' ? SLOT_HEADINGS[section.slot] : undefined;
  if (!section.space?.trim()) {
    return [isLead ? `${FRONT_PAGE_LABEL} (lead)` : `${FRONT_PAGE_LABEL} (below the fold${heading ? `, under “${heading}”` : ''})`];
  }
  const topic = findTopic(section.space, topics);
  if (!topic) return [`Nowhere yet: topic “${section.space}” was not found`];
  const out = [`${topic.name} landing`];
  if (topic.slug === homeTopicSlug) out.push(`${FRONT_PAGE_LABEL} (below the fold${heading ? `, under “${heading}”` : ''})`);
  return out;
}

/** What deleting this section changes, for the confirmation. */
export function deleteConsequences(section: SectionDef, topics: readonly TopicRef[], homeTopicSlug: string | undefined, isLead: boolean): string[] {
  const out = [`/sections/${section.slug} stops working, and links to it break.`];
  if (isLead) out.push(`${section.name} is the front-page lead; the next front-page section takes its place.`);
  for (const where of appearsOn(section, topics, homeTopicSlug, isLead)) {
    if (!where.startsWith('Nowhere')) out.push(`It is removed from ${where.replace(/ \(.*\)$/, '')}.`);
  }
  return Array.from(new Set(out));
}

/**
 * Run at most `max` async jobs at once. The list asks for a match count per
 * section; with 50 sections, 50 simultaneous `/pages` requests would compete
 * with the page's own reads, so they queue here instead.
 */
export function createLimiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const start = waiting.shift();
    if (start) start();
  };
  return <T>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        active += 1;
        job()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}
