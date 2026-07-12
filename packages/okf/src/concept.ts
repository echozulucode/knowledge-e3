import { parse } from '@echozedlabs/codec';
import { stringify as yamlStringify } from 'yaml';
import type { BuildOptions, ConceptResult, OkfFrontmatter, PageInput } from './types.js';
import { translateLinks, type LinkResolver } from './links.js';

const DEFAULT_CONCEPT_DIR = 'concepts';
const DEFAULT_TYPE = 'Knowledge Page';

/** Bundle-relative file path for a page slug. */
export function conceptPathForSlug(slug: string, conceptDir: string = DEFAULT_CONCEPT_DIR): string {
  return `${conceptDir}/${slug}.md`;
}

/**
 * Convert one Knowledge E3 page into an OKF concept document.
 *
 * The original frontmatter is preserved (OKF asks consumers to keep unknown keys),
 * then normalized to satisfy OKF: a non-empty `type`, plus recommended `title`,
 * `description`, `tags`, and `timestamp`. E3's identity and higher-order model
 * (status, space, categories, groups) ride along as `e3_*` extension keys so an
 * export can be re-imported losslessly, keyed on the immutable `e3_id`.
 */
export function pageToConcept(
  page: PageInput,
  resolve: LinkResolver,
  opts: BuildOptions = {},
): ConceptResult {
  const conceptDir = opts.conceptDir ?? DEFAULT_CONCEPT_DIR;
  const defaultType = opts.defaultType ?? DEFAULT_TYPE;
  const style = opts.linkStyle ?? 'dual';

  const parsed = parse(page.rawMarkdown);
  const original = (parsed.frontmatter ?? {}) as Record<string, unknown>;

  // `type` first so it leads the YAML block; then preserve all other original keys.
  const fm: OkfFrontmatter = { type: deriveType(original, defaultType) };
  for (const [key, value] of Object.entries(original)) {
    if (key !== 'type') fm[key] = value;
  }

  fm.title = page.title || firstString(original['title']) || slugToTitle(page.slug);
  const description = firstString(original['summary'], original['description']);
  if (description) fm.description = description;

  const tags = uniqueStrings([...(page.tags ?? []), ...asStringArray(original['tags'])]);
  if (tags.length > 0) fm.tags = tags;

  if (page.updatedAt) fm.timestamp = page.updatedAt;

  // E3 identity + higher-order model, preserved as producer-defined extension keys.
  fm.e3_id = page.id;
  fm.e3_slug = page.slug;
  if (page.status) fm.e3_status = page.status;
  if (page.space) fm.e3_space = page.space;
  if (page.categories && page.categories.length > 0) fm.e3_categories = page.categories;
  if (page.groups && page.groups.length > 0) fm.e3_groups = page.groups;
  if (page.ownerId) fm.e3_owner_id = page.ownerId;
  if (page.createdAt) fm.e3_created_at = page.createdAt;

  const body = translateLinks(page.rawMarkdown, resolve, style);
  const content = renderConcept(fm, body);

  return {
    conceptId: `${conceptDir}/${page.slug}`,
    path: conceptPathForSlug(page.slug, conceptDir),
    content,
    frontmatter: fm,
  };
}

/** Render a concept document: a YAML frontmatter block followed by the body. */
export function renderConcept(frontmatter: OkfFrontmatter, body: string): string {
  const yaml = yamlStringify(frontmatter).replace(/\n+$/, '');
  const trimmedBody = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

function deriveType(original: Record<string, unknown>, fallback: string): string {
  const t = original['type'];
  if (typeof t === 'string' && t.trim() !== '') return t;
  return fallback;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v !== ''))];
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
