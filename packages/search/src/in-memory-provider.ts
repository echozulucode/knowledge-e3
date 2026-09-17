/**
 * In-memory `SearchProvider` (ADR-0002).
 *
 * The reference implementation behind the seam: good enough for tests, the
 * eval harness, and small corpora. Scoring is a transparent weighted term
 * match over title / tags / description / body with a small exact-phrase
 * bonus.
 *
 * It implements the SAME query language as the server's `SearchService`
 * (reader UX plan §5.2): every term and phrase must be present (implicit AND),
 * filter values OR within a key and AND across keys, `-key:value` and `-term`
 * exclude, an explicit query field wins over the parsed `key:value`, and the
 * trailing term matches as a prefix while the reader is still typing.
 * `author:`, `updated:` and `is:` apply the predicates in `filter-semantics.ts`,
 * which is where their meaning is defined for both providers. The two
 * are held to that by `server/tests/search-provider-conformance.e2e.test.ts`;
 * they had drifted before it existed.
 */
import type { PublicationStatus, SearchDoc, SearchHit, SearchProvider, SearchQuery, SortMode, Viewer } from '@echozedlabs/knowledge-types';
import { parseSearchQuery, type ParsedSearchQuery } from './query-parser.js';
import { passesItemFilters, resolveItemFilters, type ResolvedItemFilters } from './filter-semantics.js';
import { IDENTIFIER_MATCH_MULTIPLIER, isIdentifierLike } from './ranker.js';

const FIELD_WEIGHTS = { title: 3, tags: 2, description: 1.5, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const FIELD_ORDER: Field[] = ['title', 'tags', 'description', 'body'];

const PHRASE_BONUS = 1;
/** A prefix hit on the word still being typed is worth less than the finished word. */
const PREFIX_FACTOR = 0.5;
const ALL_TERMS_BONUS = 2;
const MIN_TOKEN_LENGTH = 2;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 100;

interface IndexedDoc {
  doc: SearchDoc;
  /** Lowercased text per field. */
  text: Record<Field, string>;
  tokens: Record<Field, Set<string>>;
  /** Ordered tokens of the title, and of each tag separately, for whole-identifier matching. */
  sequences: { title: string[]; tags: string[][] };
}

/**
 * Filters as both providers resolve them (reader UX plan §5.2): values within a
 * key OR, keys AND, and `-key:value` excludes. An explicit query field wins
 * over the parsed `key:value` for the same key.
 */
export interface ResolvedFilters {
  space: string[];
  tag: string[];
  category: string[];
  group: string[];
  type: string[];
  not: { space: string[]; tag: string[]; category: string[]; group: string[]; type: string[] };
  status?: PublicationStatus;
  since?: string;
}

type TaxonomyKey = 'space' | 'tag' | 'category' | 'group' | 'type';

/**
 * The filters a query resolves to, shared by `InMemorySearchProvider` and the
 * server's `SearchService` so the two cannot drift (the conformance suite in
 * `server/tests/search-provider-conformance.e2e.test.ts` proves it).
 */
export function resolveFilters(
  parsed: ParsedSearchQuery,
  explicit: { space?: string | string[]; tag?: string | string[]; category?: string | string[]; group?: string | string[]; type?: string | string[] } = {},
): Pick<ResolvedFilters, TaxonomyKey | 'not'> {
  const pick = (key: TaxonomyKey, parsedValues: string[] | undefined, aliasValues?: string[]): string[] => {
    const given = asList(explicit[key]);
    if (given.length) return given;
    return unique([...(parsedValues ?? []), ...(aliasValues ?? [])]);
  };
  return {
    // `topic:` and `space:` are the same axis; values from either OR together.
    space: pick('space', parsed.filters.space, parsed.filters.topic),
    tag: pick('tag', parsed.filters.tag),
    category: pick('category', parsed.filters.category),
    group: pick('group', parsed.filters.group),
    type: pick('type', parsed.filters.type),
    not: {
      space: unique([...(parsed.excludedFilters.space ?? []), ...(parsed.excludedFilters.topic ?? [])]),
      tag: parsed.excludedFilters.tag ?? [],
      category: parsed.excludedFilters.category ?? [],
      group: parsed.excludedFilters.group ?? [],
      type: parsed.excludedFilters.type ?? [],
    },
  };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const values = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
  return unique(values);
}

export interface InMemorySearchProviderOptions {
  /** The clock relative `updated:` windows count back from. Default: the current time. */
  now?: () => Date;
}

export class InMemorySearchProvider implements SearchProvider {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly now: () => Date;

  constructor(opts: InMemorySearchProviderOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async index(doc: SearchDoc): Promise<void> {
    const text: Record<Field, string> = {
      title: doc.title.toLowerCase(),
      tags: (doc.tags ?? []).join(' ').toLowerCase(),
      description: (doc.description ?? '').toLowerCase(),
      body: doc.body_text.toLowerCase(),
    };
    this.docs.set(doc.id, {
      doc,
      text,
      tokens: {
        title: new Set(tokenize(text.title)),
        tags: new Set(tokenize(text.tags)),
        description: new Set(tokenize(text.description)),
        body: new Set(tokenize(text.body)),
      },
      sequences: { title: tokenize(text.title), tags: (doc.tags ?? []).map(tokenize) },
    });
  }

  async remove(id: string): Promise<void> {
    this.docs.delete(id);
  }

  async query(q: SearchQuery, viewer: Viewer): Promise<SearchHit[]> {
    const parsed = parseSearchQuery(q.q ?? '', { now: this.now() });
    const terms = unique(parsed.terms.flatMap(tokenize));
    const phrases = parsed.phrases.map(normalizeText).filter(Boolean);
    const excluded = unique(parsed.excludedTerms.flatMap(tokenize));
    const excludedPhrases = parsed.excludedPhrases.map(normalizeText).filter(Boolean);
    // The trailing term matches as a prefix while the reader is still typing
    // ("modb" finds "modbus"); a quoted phrase never expands.
    // FTS5 expands the LAST token of the trailing term, so a term like
    // `iso-262` matches `iso` exactly and `262` as a prefix; mirror that here.
    const prefix = parsed.prefixTerm ? (tokenize(parsed.prefixTerm).pop() ?? null) : null;
    // Classified as typed (`MQTT`, `modbus_rtu`), matched as whole token sequences.
    const identifiers = [...parsed.terms, ...parsed.phrases].filter(isIdentifierLike).map(tokenize).filter((t) => t.length > 0);
    const itemFilters = resolveItemFilters(parsed);

    const filters: ResolvedFilters = {
      ...resolveFilters(parsed, q),
      status: q.status ?? parseStatus(parsed.filters.status?.[0]),
      since: q.since,
    };
    const canSeeDrafts = q.include_drafts === true || viewer.role === 'admin';
    const hasSearchSignal = terms.length > 0 || phrases.length > 0;

    const hits: SearchHit[] = [];
    for (const entry of this.docs.values()) {
      if (!passesFilters(entry.doc, filters, canSeeDrafts, itemFilters)) continue;
      if (excluded.some((term) => FIELD_ORDER.some((field) => entry.tokens[field].has(term)))) continue;
      if (excludedPhrases.some((phrase) => FIELD_ORDER.some((field) => includesPhrase(entry.text[field], phrase)))) continue;

      const { score, matched } = scoreEntry(entry, terms, phrases, prefix, identifiers);
      // Every term and every phrase must appear somewhere — the same implicit
      // AND FTS5 applies, so `postgres failover` does not return everything
      // about Postgres. The two providers have to agree on this or a query
      // means different things in the product and in the eval.
      if (hasSearchSignal && !matchesEveryPart(entry, terms, phrases, prefix)) continue;
      if (hasSearchSignal && matched.length === 0) continue;

      const { body_text: _body, ...summary } = entry.doc;
      hits.push({ ...summary, score, matched_fields: matched, snippet: snippetFor(entry, terms, phrases) });
    }

    sortHits(hits, q.sort ?? 'relevance');
    const offset = Math.max(0, Math.floor(q.offset ?? 0));
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return hits.slice(offset, offset + limit);
  }
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

/** True when the document carries every term (exact, or prefix while typing) and every phrase. */
function matchesEveryPart(entry: IndexedDoc, terms: string[], phrases: string[], prefix: string | null): boolean {
  const hasTerm = (term: string): boolean =>
    FIELD_ORDER.some((field) => entry.tokens[field].has(term) || (term === prefix && hasPrefix(entry.tokens[field], term)));
  const hasPhrase = (phrase: string): boolean => FIELD_ORDER.some((field) => includesPhrase(entry.text[field], phrase));
  return terms.every(hasTerm) && phrases.every(hasPhrase);
}

/**
 * A quoted phrase matches whole words, never a fragment of one: `"kube"` does
 * not match `kubernetes`, exactly as an FTS5 phrase does not. (Requesting a
 * prefix is what `kube` without the quotes is for.)
 */
const PHRASE_PATTERNS = new Map<string, RegExp>();
function includesPhrase(text: string, phrase: string): boolean {
  if (!text || !phrase) return false;
  let pattern = PHRASE_PATTERNS.get(phrase);
  if (!pattern) {
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, 'u');
    PHRASE_PATTERNS.set(phrase, pattern);
  }
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when any indexed token of the field starts with `prefix`. */
function hasPrefix(tokens: Set<string>, prefix: string): boolean {
  for (const token of tokens) if (token.startsWith(prefix)) return true;
  return false;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseStatus(value: string | undefined): PublicationStatus | undefined {
  return value === 'draft' || value === 'published' ? value : undefined;
}

function passesFilters(doc: SearchDoc, filters: ResolvedFilters, canSeeDrafts: boolean, itemFilters: ResolvedItemFilters): boolean {
  // Visibility first: `is:draft` narrows what the viewer may see, it never widens it.
  if (doc.status === 'draft' && !canSeeDrafts) return false;
  if (filters.status && doc.status !== filters.status) return false;
  if (filters.since && doc.updated_at < filters.since) return false;
  if (!passesItemFilters(doc, itemFilters)) return false;
  // Values within a key OR; keys AND; `-key:value` excludes.
  for (const key of ['space', 'tag', 'category', 'group', 'type'] as const) {
    const wanted = filters[key];
    if (wanted.length && !wanted.some((value) => matchesAxis(doc, key, value))) return false;
    const unwanted = filters.not[key];
    if (unwanted.length && unwanted.some((value) => matchesAxis(doc, key, value))) return false;
  }
  return true;
}

/** One taxonomy axis of a document, matched case-insensitively. */
function matchesAxis(doc: SearchDoc, key: TaxonomyKey, value: string): boolean {
  switch (key) {
    case 'space':
      return equalsIgnoreCase(doc.space_id, value) || equalsIgnoreCase(doc.topic, value);
    case 'tag':
      return includesIgnoreCase(doc.tags, value);
    case 'category':
      return includesIgnoreCase(doc.categories, value);
    case 'group':
      return includesIgnoreCase(doc.groups, value);
    case 'type':
      return equalsIgnoreCase(doc.type, value);
  }
}

function equalsIgnoreCase(value: string | null | undefined, expected: string): boolean {
  return !!value && value.toLowerCase() === expected.toLowerCase();
}

function includesIgnoreCase(values: string[] | undefined, expected: string): boolean {
  return (values ?? []).some((value) => equalsIgnoreCase(value, expected));
}

function scoreEntry(
  entry: IndexedDoc,
  terms: string[],
  phrases: string[],
  prefix: string | null,
  identifiers: string[][],
): { score: number; matched: Field[] } {
  let score = 0;
  const matched: Field[] = [];

  for (const field of FIELD_ORDER) {
    let fieldScore = 0;
    for (const term of terms) {
      if (entry.tokens[field].has(term)) fieldScore += FIELD_WEIGHTS[field];
      // A prefix hit on the term still being typed counts, but below the exact
      // token, so finishing the word always improves the ranking.
      else if (term === prefix && hasPrefix(entry.tokens[field], term)) fieldScore += FIELD_WEIGHTS[field] * PREFIX_FACTOR;
    }
    for (const phrase of phrases) {
      if (includesPhrase(entry.text[field], phrase)) fieldScore += FIELD_WEIGHTS[field] + PHRASE_BONUS;
    }
    // The same identifier/acronym boost the server's ranker applies (reader UX
    // plan §5.3): `MQTT` as a whole token of the title or of a tag says the item
    // is ABOUT it, so those two fields' weight is multiplied; prose is not.
    if (fieldScore > 0 && identifiers.length && hasIdentifier(entry, field, identifiers)) {
      fieldScore *= IDENTIFIER_MATCH_MULTIPLIER;
    }
    if (fieldScore > 0) {
      score += fieldScore;
      matched.push(field);
    }
  }

  if (terms.length > 1) {
    // The whole query appearing verbatim in the title is the strongest exact-match signal.
    if (entry.text.title.includes(terms.join(' '))) score += PHRASE_BONUS;
    if (terms.every((term) => FIELD_ORDER.some((field) => entry.tokens[field].has(term) || (term === prefix && hasPrefix(entry.tokens[field], term))))) {
      score += ALL_TERMS_BONUS;
    }
  }

  return { score, matched };
}

function hasIdentifier(entry: IndexedDoc, field: Field, identifiers: string[][]): boolean {
  if (field === 'title') return identifiers.some((sequence) => containsSequence(entry.sequences.title, sequence));
  if (field === 'tags') return identifiers.some((sequence) => entry.sequences.tags.some((tag) => containsSequence(tag, sequence)));
  return false;
}

function containsSequence(tokens: string[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= tokens.length; i += 1) {
    if (sequence.every((token, k) => tokens[i + k] === token)) return true;
  }
  return false;
}

function snippetFor(entry: IndexedDoc, terms: string[], phrases: string[]): string | undefined {
  const lower = entry.text.body;
  if (!lower) return entry.doc.description ?? undefined;

  // Lowercasing can change string length for some scripts; only reuse indices when it did not.
  const source = entry.doc.body_text.length === lower.length ? entry.doc.body_text : lower;

  let at = -1;
  for (const needle of [...phrases, ...terms]) {
    const index = lower.indexOf(needle);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }

  // No body match: fall back to the opening of the body.
  const anchor = at === -1 ? 0 : at;
  const start = Math.max(0, anchor - SNIPPET_BEFORE);
  const end = Math.min(source.length, anchor + SNIPPET_AFTER);
  const text = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${end < source.length ? '…' : ''}`;
}

function sortHits(hits: SearchHit[], sort: SortMode): void {
  const newestFirst = (a: SearchHit, b: SearchHit): number => compareStrings(b.updated_at, a.updated_at);
  const byTitle = (a: SearchHit, b: SearchHit): number => a.title.localeCompare(b.title);

  switch (sort) {
    case 'newest':
      hits.sort(newestFirst);
      break;
    case 'oldest':
      hits.sort((a, b) => newestFirst(b, a));
      break;
    case 'az':
      hits.sort(byTitle);
      break;
    case 'verified':
      // Most recently verified first; never-verified items after every verified
      // one, newest first among themselves. Keyed on `last_verified_at` alone,
      // which is the column the server orders by.
      hits.sort((a, b) => compareVerifiedAt(a, b) || newestFirst(a, b) || byTitle(a, b));
      break;
    default:
      hits.sort((a, b) => b.score - a.score || newestFirst(a, b) || byTitle(a, b));
  }
}

function compareVerifiedAt(a: SearchHit, b: SearchHit): number {
  const at = (hit: SearchHit): number => (hit.last_verified_at ? Date.parse(hit.last_verified_at) : Number.NaN);
  const [left, right] = [at(a), at(b)];
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.isNaN(left) === Number.isNaN(right) ? 0 : Number.isNaN(left) ? 1 : -1;
  return right - left;
}

/** ISO timestamps order correctly as plain strings, so no Date parsing is needed. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
