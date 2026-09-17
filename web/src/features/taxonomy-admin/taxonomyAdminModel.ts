/**
 * Pure helpers for Admin → Tags & groups and Admin → Primary categories
 * (the admin UX review §4.6): the URL view, slug preview, the
 * tag toolbar's sort and filter, the usage bar's scale, and the rules that
 * decide which row actions a category offers. Kept out of the components so
 * they are unit-tested without a router or a DOM.
 */
import type { TaxonomyCategory, TaxonomyGroup, TaxonomyTag } from '../../queries.js';

// ---------------------------------------------------------------- words

/** "1 item" / "1,204 items". */
export function pluralize(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export const itemsLabel = (count: number): string => pluralize(count, 'item', 'items');

/** The error text a failed request carries, or the fallback. */
export function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim();
    if (message) return message;
  }
  return fallback;
}

// ---------------------------------------------------------------- slugs

/** Matches the server DTOs (`@MaxLength(100)` on category and group slugs). */
export const TAXONOMY_SLUG_MAX = 100;

/**
 * The slug the server will store for this input. Mirrors `slugify` in
 * server/src/common/slug.ts (diacritics folded, anything else collapsed to one
 * hyphen) because `createCategory`/`createGroup` run whatever the dialog sends
 * through it again — previewing anything else would promise a slug the term
 * does not get. Empty in, empty out: the server's `'untitled'` fallback is not
 * something the dialog should suggest.
 */
export function slugifyTaxonomy(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TAXONOMY_SLUG_MAX);
}

/** The slug a create request ends up with: the typed slug when there is one, else the name's. */
export function effectiveSlug(name: string, slug: string): string {
  return slugifyTaxonomy(slug.trim() || name);
}

// ---------------------------------------------------------------- URL view

export type TagGroupView = 'tags' | 'groups';
export type CategoryView = 'active' | 'archived';

/** `?view=groups` opens Groups; anything else (absent, malformed) is Tags. */
export function readTagGroupView(search: Record<string, unknown> | undefined): TagGroupView {
  return search?.['view'] === 'groups' ? 'groups' : 'tags';
}

/** `?view=archived` shows archived categories; anything else is the active catalog. */
export function readCategoryView(search: Record<string, unknown> | undefined): CategoryView {
  return search?.['view'] === 'archived' ? 'archived' : 'active';
}

/** The query string for a view: the default is absent, so the plain address stays plain. */
export function viewSearch<V extends string>(view: V, defaultView: V): Record<string, string> {
  return view === defaultView ? {} : { view };
}

// ---------------------------------------------------------------- tags

export type TagSort = 'usage' | 'name';

export interface TagFilters {
  sort: TagSort;
  /** "Used by only 1 item": the long tail worth tidying first. */
  singleUseOnly: boolean;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * The tag rows to show. Search already ran on the server (`useTags(q)`); this
 * applies the single-use filter and the sort. Usage sorts most-used first and
 * breaks ties by name, so equal counts do not shuffle between renders.
 */
export function arrangeTags(tags: readonly TaxonomyTag[], filters: TagFilters): TaxonomyTag[] {
  const kept = filters.singleUseOnly ? tags.filter((tag) => tag.count === 1) : [...tags];
  return kept.sort((a, b) => (filters.sort === 'usage' ? b.count - a.count || byName(a, b) : byName(a, b)));
}

/**
 * The slug is worth showing only when it says something the name does not.
 * Tags are stored by their text (name and slug are the same string today), so
 * this is usually false; a case- or punctuation-only difference is not news.
 */
export function slugDiffersFromName(entry: { name: string; slug: string }): boolean {
  return slugifyTaxonomy(entry.name) !== entry.slug && entry.name.trim() !== entry.slug;
}

/** The largest count, the usage bar's 100%. Zero for an empty list. */
export function maxCount(entries: readonly { count: number }[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.count), 0);
}

/**
 * Width of a usage bar as a percentage of the most-used entry. A used entry
 * never renders narrower than a sliver (2%), so "1 item" next to "900 items"
 * is still visibly a bar rather than nothing; an unused one is empty.
 */
export function usagePercent(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const percent = (count / max) * 100;
  return Math.min(100, Math.max(2, Math.round(percent * 10) / 10));
}

// ---------------------------------------------------------------- groups

/** "All topics" for a global group, else the topic's NAME (slug when the topic is not in the list). */
export function availableInLabel(group: TaxonomyGroup, topicNames: ReadonlyMap<string, string>): string {
  if (group.scope.type === 'global' || !group.scope.space_id) return 'All topics';
  return topicNames.get(group.scope.space_id) ?? group.scope.space_slug ?? group.scope.space_id;
}

export interface GroupDraft {
  name: string;
  slug: string;
  /** Topic id; '' means All topics. */
  topicId: string;
  description: string;
}

export function groupDraftFrom(group?: TaxonomyGroup): GroupDraft {
  return {
    name: group?.name ?? '',
    slug: '',
    topicId: group && group.scope.type === 'space' ? group.scope.space_id ?? '' : '',
    description: group?.description ?? '',
  };
}

export function groupDraftDirty(draft: GroupDraft, initial: GroupDraft): boolean {
  return draft.name !== initial.name || draft.slug !== initial.slug || draft.topicId !== initial.topicId || draft.description !== initial.description;
}

/** The body for `PUT /taxonomy/groups/:id` (edit) — scope always stated, blank description cleared. */
export function groupUpdateBody(draft: GroupDraft): { name: string; description: string | null; scope: 'global' | 'space'; space_id?: string } {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    ...(draft.topicId ? { scope: 'space' as const, space_id: draft.topicId } : { scope: 'global' as const }),
  };
}

/** The body for `POST /taxonomy/groups` (create). */
export function groupCreateBody(draft: GroupDraft): { name: string; slug?: string; description?: string; scope: 'global' | 'space'; space_id?: string } {
  return {
    name: draft.name.trim(),
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.topicId ? { scope: 'space' as const, space_id: draft.topicId } : { scope: 'global' as const }),
  };
}

// ---------------------------------------------------------------- categories

/** The catalog search box only earns its place past this many rows. */
export const CATEGORY_SEARCH_THRESHOLD = 15;

/** Case-insensitive match on name or slug. */
export function filterByText<T extends { name: string; slug: string }>(entries: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.slug.toLowerCase().includes(needle));
}

export function sortByName<T extends { name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort(byName);
}

/**
 * Why a category's Rename or Archive is unavailable, as the text the menu shows
 * (§3.3: disabled controls explain why in text), or undefined when allowed.
 *
 * `curated` is false for a term items carry that nobody has added to the
 * catalog: the list shows it (the admin has to see it to curate it), but there
 * is no catalog row to rename or archive until it is added.
 */
export function categoryActionRules(category: TaxonomyCategory, curated: boolean): { renameReason?: string; archiveReason?: string } {
  if (!curated) {
    const reason = 'Not in the catalog yet';
    return { renameReason: reason, archiveReason: reason };
  }
  return category.count > 0 ? { archiveReason: `In use by ${itemsLabel(category.count)}` } : {};
}
