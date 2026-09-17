/**
 * Pure helpers behind the Compose surface and its Publish drawer (plan §4).
 * No React, no fetch — everything here is unit-tested in composeModel.test.ts.
 *
 * Frontmatter keys written by the drawer are the ones the server already
 * indexes (`server/src/pages/taxonomy.ts`) and `blogMeta.ts` already reads:
 * topic, type, categories, groups, tags, description, authors, series,
 * series_order, published_at, cover, stale_after, status, verified.
 */
import { parse, type Frontmatter } from '@echozedlabs/codec';
import { stringify } from 'yaml';
import type { EditorMode } from '@echozedlabs/react';

export interface ContentTypeLike {
  key: string;
  label: string;
  template: string;
  defaultFrontmatter: Record<string, unknown>;
}

export function buildRawMarkdown(frontmatter: Frontmatter, body: string): string {
  const yaml = stringify(frontmatter).trim();
  return yaml.length > 0 ? `---\n${yaml}\n---\n${body}` : body;
}

export function splitMarkdown(markdown: string): { frontmatter: Frontmatter; body: string } {
  const parsed = parse(markdown);
  return { frontmatter: parsed.frontmatter as Frontmatter, body: parsed.body };
}

/** Resolve a `type` value (registry key or canonical label, any case) to a registry entry. */
export function findType<T extends ContentTypeLike>(type: unknown, contentTypes: T[]): T | undefined {
  if (typeof type !== 'string' || !type.trim()) return undefined;
  const needle = type.trim().toLowerCase();
  return contentTypes.find((t) => t.key.toLowerCase() === needle || t.label.toLowerCase() === needle);
}

export function isBlogPost(type: unknown, contentTypes: ContentTypeLike[]): boolean {
  return findType(type, contentTypes)?.key === 'blog-post';
}

/** Blog posts open in rich text; technical types open in hybrid (plan §4.1). */
export function defaultEditorMode(type: unknown, contentTypes: ContentTypeLike[]): EditorMode {
  return isBlogPost(type, contentTypes) ? 'wysiwyg' : 'hybrid';
}

/** The registry template fills an EMPTY body only; authored text is never replaced. */
export function applyTemplate(body: string, type: ContentTypeLike | undefined): { body: string; applied: boolean } {
  if (!type || body.trim().length > 0) return { body, applied: false };
  return { body: type.template, applied: true };
}

/**
 * What `/new` may carry in besides the type and topic. Browse hands off the
 * filters that were active when the author pressed "New item", so creating from
 * a filtered view or a search keeps that head start.
 */
export interface NewItemSeed {
  title?: string;
  tag?: string;
  category?: string;
  group?: string;
}

/** Frontmatter for a brand-new item created from `/new?type=&topic=`. */
export function initialFrontmatter(
  type: ContentTypeLike | undefined,
  topic: string | undefined,
  seed: NewItemSeed = {},
): Frontmatter {
  const title = seed.title?.trim();
  const tag = seed.tag?.trim();
  const category = seed.category?.trim();
  const group = seed.group?.trim();
  return {
    ...(type ? type.defaultFrontmatter : {}),
    ...(type ? { type: type.label } : {}),
    status: 'draft',
    ...(topic?.trim() ? { topic: topic.trim() } : {}),
    ...(title ? { title } : {}),
    ...(tag ? { tags: [tag] } : {}),
    ...(category ? { categories: [category] } : {}),
    ...(group ? { groups: [group] } : {}),
  } as Frontmatter;
}

/** Values the Publish drawer edits. Strings are trimmed on write; empty values remove the key. */
export interface DrawerValues {
  topic: string;
  type: string;
  category: string;
  tags: string[];
  groups: string[];
  description: string;
  authors: string[];
  series: string;
  seriesOrder: string;
  publishedAt: string;
  cover: string;
  status: 'draft' | 'published';
  staleAfter: string;
}

function str(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/** Read the drawer's values out of frontmatter (the inverse of `withDrawerValues`). */
export function drawerValuesFrom(frontmatter: Frontmatter): DrawerValues {
  const fm = frontmatter as Record<string, unknown>;
  const authors = list(fm['authors']);
  return {
    topic: str(fm['topic'] ?? fm['space']).trim(),
    type: str(fm['type']).trim(),
    category: list(fm['categories'])[0] ?? '',
    tags: list(fm['tags']),
    groups: list(fm['groups']),
    description: str(fm['description']),
    authors: authors.length ? authors : list(fm['author']),
    series: str(fm['series']).trim(),
    seriesOrder: str(fm['series_order']).trim(),
    publishedAt: str(fm['published_at']).slice(0, 10),
    cover: str(fm['cover']).trim(),
    status: fm['status'] === 'published' ? 'published' : 'draft',
    staleAfter: str(fm['stale_after']).slice(0, 10),
  };
}

/** Write the drawer's values into frontmatter, dropping keys whose value is empty. */
export function withDrawerValues(frontmatter: Frontmatter, values: DrawerValues): Frontmatter {
  const next = { ...frontmatter } as Record<string, unknown>;
  const set = (key: string, value: unknown, present: boolean) => {
    if (present) next[key] = value;
    else delete next[key];
  };
  delete next['space'];
  const topic = values.topic.trim();
  set('topic', topic, topic.length > 0);
  const type = values.type.trim();
  set('type', type, type.length > 0);
  const category = values.category.trim();
  set('categories', [category], category.length > 0);
  set('tags', values.tags, values.tags.length > 0);
  set('groups', values.groups, values.groups.length > 0);
  const description = values.description.trim();
  set('description', description, description.length > 0);
  set('authors', values.authors, values.authors.length > 0);
  const series = values.series.trim();
  set('series', series, series.length > 0);
  const seriesOrder = Number.parseInt(values.seriesOrder, 10);
  set('series_order', seriesOrder, Number.isFinite(seriesOrder));
  const publishedAt = values.publishedAt.trim();
  set('published_at', publishedAt, publishedAt.length > 0);
  const cover = values.cover.trim();
  set('cover', cover, cover.length > 0);
  const staleAfter = values.staleAfter.trim();
  set('stale_after', staleAfter, staleAfter.length > 0);
  next['status'] = values.status;
  return next as Frontmatter;
}

/** Append an OKF `verified` event for the reviewing human (spec §5.3). */
export function appendVerified(frontmatter: Frontmatter, username: string, at: string): Frontmatter {
  const existing = (frontmatter as Record<string, unknown>)['verified'];
  const events = Array.isArray(existing) ? existing : existing ? [existing] : [];
  return { ...frontmatter, verified: [...events, { by: `human:${username}`, at }] } as Frontmatter;
}

export type PublishField = 'title' | 'type' | 'category' | 'description' | 'publishedAt' | 'authors';

/**
 * Inline validation that gates the Publish action (plan §4.2). Evaluated as if
 * the item were published, so `description` is always required here.
 *
 * `curatedCategories` is the accepted primary-category vocabulary — slugs and
 * display names, as the server's `lintContext` feeds them to the lint. Primary
 * categories are curated, not emergent (Eric, 2026-09-11), so a value outside
 * that list is refused by the publish gate (`category.unknown`, an error); this
 * check is the local mirror so the author is told before the request instead of
 * by a 422. Omitted or empty means "vocabulary not loaded yet" — then only the
 * presence of a category is checked, because a not-yet-fetched catalog must
 * never be mistaken for an empty one.
 */
export function validateForPublish(
  values: { title: string } & Pick<DrawerValues, 'type' | 'category' | 'description' | 'publishedAt' | 'authors'>,
  contentTypes: ContentTypeLike[],
  curatedCategories: string[] = [],
): Partial<Record<PublishField, string>> {
  const errors: Partial<Record<PublishField, string>> = {};
  if (!values.title.trim()) errors.title = 'Title is required.';
  if (!values.type.trim()) errors.type = 'Choose a content type.';
  if (!values.category.trim()) errors.category = 'Choose exactly one primary category.';
  else if (curatedCategories.length > 0 && !curatedCategories.some((known) => known.trim().toLowerCase() === values.category.trim().toLowerCase())) {
    errors.category = `“${values.category.trim()}” is not one of the curated primary categories. Choose one from the list.`;
  }
  if (!values.description.trim()) errors.description = 'A description is required to publish.';
  if (isBlogPost(values.type, contentTypes)) {
    if (!values.publishedAt.trim()) errors.publishedAt = 'A Blog Post needs a published date.';
    if (values.authors.length === 0) errors.authors = 'A Blog Post needs at least one author.';
  }
  return errors;
}

/** The `stale_after.missing` lint fix, when a write response carries diagnostics. */
export function staleAfterFixFrom(diagnostics: unknown): string | undefined {
  if (!Array.isArray(diagnostics)) return undefined;
  for (const d of diagnostics) {
    if (d && typeof d === 'object' && (d as { code?: unknown }).code === 'stale_after.missing') {
      const fix = (d as { fix?: { frontmatter?: { stale_after?: unknown } } }).fix;
      const value = fix?.frontmatter?.stale_after;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Split a comma-separated entry into trimmed, de-duplicated tokens. */
export function tokens(input: string): string[] {
  return Array.from(new Set(input.split(',').map((t) => t.trim()).filter(Boolean)));
}
