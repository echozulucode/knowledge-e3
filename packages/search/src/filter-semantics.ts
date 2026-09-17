/**
 * What `author:`, `updated:` and `is:` MEAN, as pure predicates over an item.
 *
 * The parser decides what a reader may type; this module decides which items a
 * parsed value selects. `InMemorySearchProvider` filters with these functions
 * directly, and the server's `SearchService` expresses the same rules in SQL —
 * the conformance suite (`server/tests/search-provider-conformance.e2e.test.ts`)
 * is what holds the SQL to this definition. Read this file before writing that
 * SQL, not the other provider.
 */
import type { SearchDoc } from '@echozedlabs/knowledge-types';
import type { IsFilterValue, ParsedSearchQuery, UpdatedRange } from './query-parser.js';

/**
 * A search document that may carry its authors. `SearchDoc` does not declare
 * them yet; the frontmatter has both spellings in the wild, so both are read.
 */
export interface AuthoredSearchDoc extends SearchDoc {
  /** Frontmatter `authors`. */
  authors?: string[] | null;
  /** Frontmatter `author` (single). */
  author?: string | null;
}

/** The parsed `author:` / `updated:` / `is:` filters, resolved the way both providers apply them. */
export interface ResolvedItemFilters {
  /** Values OR: an item by any of these authors. */
  author: string[];
  /** Values OR: an item satisfying any of these. */
  is: IsFilterValue[];
  updated: UpdatedRange | null;
  not: { author: string[]; is: IsFilterValue[] };
}

export function resolveItemFilters(parsed: ParsedSearchQuery): ResolvedItemFilters {
  return {
    author: parsed.filters.author ?? [],
    // The parser has already folded `is:` values to canonical form and dropped
    // unknown ones with a warning, so the casts only restate that.
    is: (parsed.filters.is ?? []) as IsFilterValue[],
    updated: parsed.updated ?? null,
    not: {
      author: parsed.excludedFilters.author ?? [],
      is: (parsed.excludedFilters.is ?? []) as IsFilterValue[],
    },
  };
}

/** True when the item passes every resolved item filter: values OR within a key, keys AND, exclusions exclude. */
export function passesItemFilters(doc: SearchDoc, filters: ResolvedItemFilters): boolean {
  if (filters.author.length && !filters.author.some((name) => matchesAuthor(doc, name))) return false;
  if (filters.not.author.some((name) => matchesAuthor(doc, name))) return false;
  if (filters.is.length && !filters.is.some((value) => matchesIs(doc, value))) return false;
  if (filters.not.is.some((value) => matchesIs(doc, value))) return false;
  if (filters.updated && !withinUpdated(doc.updated_at, filters.updated)) return false;
  return true;
}

/**
 * An author name compared the way `author:` compares it: whitespace collapsed,
 * case folded, otherwise EXACT — `author:ada` does not find "Ada Lovelace", and
 * accents are not folded (a name is not a word to stem or approximate). The
 * server must fold case in JS or in a stored column: SQLite's `lower()` only
 * folds ASCII.
 */
export function normalizeAuthor(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every author an item names, from `authors` and `author`, normalized and de-duplicated. */
export function authorsOf(doc: SearchDoc): string[] {
  const { authors, author } = doc as AuthoredSearchDoc;
  const names = [...(Array.isArray(authors) ? authors : []), ...(typeof author === 'string' ? [author] : [])];
  return [...new Set(names.map(normalizeAuthor).filter(Boolean))];
}

export function matchesAuthor(doc: SearchDoc, name: string): boolean {
  const wanted = normalizeAuthor(name);
  return !!wanted && authorsOf(doc).includes(wanted);
}

/** `is:value` over the item's lifecycle signals (see `IS_FILTER_VALUES` for the table). */
export function matchesIs(doc: SearchDoc, value: IsFilterValue): boolean {
  const verified = doc.trust_tier === 'human-reviewed' || doc.trust_tier === 'machine-confirmed';
  switch (value) {
    case 'verified':
      return verified;
    case 'unverified':
      // No recorded tier is unverified: nobody has vouched for it.
      return !verified;
    case 'human-reviewed':
    case 'machine-confirmed':
      return doc.trust_tier === value;
    case 'needs-review':
      // The same staleness test the lifecycle policy demotes on.
      return doc.stale === true || doc.display_state === 'needs-review';
    case 'draft':
    case 'published':
      return doc.status === value;
  }
}

/** `updated_at` inside `[after, before)`, compared as instants. An unparseable timestamp matches no range. */
export function withinUpdated(updatedAt: string, range: UpdatedRange): boolean {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  if (range.after !== undefined && at < Date.parse(range.after)) return false;
  if (range.before !== undefined && at >= Date.parse(range.before)) return false;
  return true;
}
