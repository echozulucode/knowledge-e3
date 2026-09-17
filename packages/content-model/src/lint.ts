/**
 * Lint rules (plan §6.2). Pure: parse the raw document, apply each rule, return
 * diagnostics. Warnings never block; the caller decides what an `error` means.
 * Never throws — unparseable input yields a single `frontmatter.invalid` error.
 *
 * "Published" for the description/blog rules is `ctx.published` when given, else
 * frontmatter `e3_status` then `status` equal to `published` (case-insensitive),
 * the same precedence the OKF importer uses.
 */
import { parse, extractWikiLinks } from '@echozedlabs/codec';
import type { Diagnostic, LintContext } from '@echozedlabs/knowledge-types';
import { findContentType } from './registry.js';
import { reviewHorizonDays } from './lifecycle.js';

export type LintOptions = LintContext & { published?: boolean };

export function lint(raw: string, ctx: LintOptions = {}): Diagnostic[] {
  let parsed: ReturnType<typeof parse>;
  try {
    if (typeof raw !== 'string') throw new Error('document is not a string');
    parsed = parse(raw);
  } catch (err) {
    return [{ code: 'frontmatter.invalid', severity: 'error', message: `Could not parse document: ${(err as Error).message}` }];
  }
  const fm = parsed.frontmatter;
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    return [{ code: 'frontmatter.invalid', severity: 'error', message: 'Frontmatter must be a YAML mapping', path: 'frontmatter' }];
  }

  const out: Diagnostic[] = [];
  const published = ctx.published ?? isPublished(fm);

  // type
  const type = nonEmptyString(fm['type']);
  const def = type ? findContentType(type) : undefined;
  if (!type) {
    out.push({ code: 'type.missing', severity: 'error', message: 'Frontmatter `type` is required', path: 'type' });
  } else if (!def) {
    out.push({ code: 'type.unknown', severity: 'warning', message: `Unknown content type "${type}" (accepted, but not in the registry)`, path: 'type' });
  }

  // primary category
  const catKey = fm['e3_categories'] !== undefined ? 'e3_categories' : 'categories';
  const categories = stringList(fm[catKey]);
  if (categories.length === 0) {
    out.push({ code: 'category.missing', severity: 'error', message: 'Exactly one primary category is required', path: catKey });
  } else if (categories.length > 1) {
    out.push({ code: 'category.multiple', severity: 'warning', message: `Expected one primary category, found ${categories.length}`, path: catKey });
  }
  if (ctx.known?.categories) {
    const known = new Set(ctx.known.categories.map(lower));
    for (const c of categories) {
      if (!known.has(lower(c))) {
        out.push({ code: 'category.unknown', severity: 'error', message: `Unknown category "${c}"`, path: catKey });
      }
    }
  }

  // description when published
  if (published && !nonEmptyString(fm['description'])) {
    out.push({ code: 'description.missing', severity: 'error', message: '`description` is required to publish', path: 'description' });
  }

  // tags
  if (ctx.known?.tags) {
    const known = new Set(ctx.known.tags.map(lower));
    for (const t of stringList(fm['tags'])) {
      if (!known.has(lower(t))) {
        out.push({ code: 'tag.unknown', severity: 'warning', message: `Tag "${t}" is new (not in the known tag list)`, path: 'tags' });
      }
    }
  }

  // groups: an archived one is still linked (not restored), so say so — a
  // warning, because a group gates nothing (unlike an archived category).
  if (ctx.known?.archivedGroups?.length) {
    const archived = new Set(ctx.known.archivedGroups.map(slugifyTitle));
    const seen = new Set<string>();
    for (const g of stringList(fm['groups'])) {
      const slug = slugifyTitle(g);
      if (!slug || seen.has(slug) || !archived.has(slug)) continue;
      seen.add(slug);
      out.push({ code: 'group.archived', severity: 'warning', message: `Group "${g}" is archived`, path: 'groups' });
    }
  }

  // stale_after, defaulted per type
  const horizon = def ? reviewHorizonDays(def.key) : null;
  if (horizon !== null && !nonEmptyString(fm['stale_after']) && !(fm['stale_after'] instanceof Date)) {
    const at = new Date(ctx.now ?? new Date());
    at.setUTCDate(at.getUTCDate() + horizon);
    const staleAfter = at.toISOString().slice(0, 10);
    out.push({
      code: 'stale_after.missing',
      severity: 'info',
      message: `No \`stale_after\`; the default review horizon for ${def!.label} is ${horizon} days`,
      path: 'stale_after',
      fix: { description: `Set stale_after to ${staleAfter}`, frontmatter: { stale_after: staleAfter } },
    });
  }

  // blog post publication requirements
  if (def?.key === 'blog-post' && published) {
    if (!nonEmptyString(fm['published_at']) && !(fm['published_at'] instanceof Date)) {
      out.push({ code: 'blog.published_at.missing', severity: 'error', message: 'A published Blog Post needs `published_at`', path: 'published_at' });
    }
    if (stringList(fm['authors']).length === 0 && !nonEmptyString(fm['author'])) {
      out.push({ code: 'blog.author.missing', severity: 'error', message: 'A published Blog Post needs at least one author', path: 'authors' });
    }
  }

  // wiki-link targets
  if (ctx.resolvableSlugs) {
    const seen = new Set<string>();
    for (const link of extractWikiLinks(parsed)) {
      const target = link.target;
      if (seen.has(target)) continue;
      seen.add(target);
      if (!ctx.resolvableSlugs.has(target) && !ctx.resolvableSlugs.has(slugifyTitle(target))) {
        out.push({ code: 'link.unresolved', severity: 'warning', message: `Wiki link [[${target}]] does not resolve`, path: 'body' });
      }
    }
  }

  return out;
}

function isPublished(fm: Record<string, unknown>): boolean {
  for (const key of ['e3_status', 'status']) {
    const value = nonEmptyString(fm[key]);
    if (value) return lower(value) === 'published';
  }
  return false;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map(nonEmptyString).filter((s): s is string => s !== undefined);
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

/** Same derivation as the server's `slugify`, so a `[[Title]]` target can be checked against item slugs. */
function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}
