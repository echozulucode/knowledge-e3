/**
 * Parsed search query model.
 *
 * This parser intentionally keeps user intent separate from SQL/FTS syntax:
 * free-text terms, exact phrases, excluded terms, and structured filters are all
 * isolated so downstream builders can remain strict and safe.
 *
 * Two rules keep the query language honest (reader UX plan §5.2):
 *
 *   1. Every operator this parser ACCEPTS must reach the results. A key that is
 *      parsed into `filters` is one both providers implement; repeated keys OR
 *      their values (`tag:a tag:b`), and different keys AND with each other.
 *   2. Anything this parser cannot honour is reported in `warnings` — never
 *      dropped in silence. The surfaces render them (§5.5).
 */

type ParsedFilterKey =
  | 'tag'
  | 'category'
  | 'group'
  | 'topic'
  | 'space'
  | 'folder'
  | 'status'
  | 'author'
  | 'type'
  | 'created'
  | 'modified'
  | 'updated'
  | 'is';

const KNOWN_FILTER_KEYS = new Set<ParsedFilterKey>([
  'tag',
  'category',
  'group',
  'topic',
  'space',
  'folder',
  'status',
  'author',
  'type',
  'created',
  'modified',
  'updated',
  'is',
]);

/**
 * The keys that reach the results, with the shape of each. This table is the
 * single source of truth for what the parser accepts, what `SearchService` and
 * `InMemorySearchProvider` implement, and what the UI's "Search tips" list
 * shows — so the three cannot drift apart.
 */
export interface SearchFilterSpec {
  key: SupportedFilterKey;
  /** One-line description for search help. */
  description: string;
  /** Example a reader can copy. */
  example: string;
  /** Repeating the key ORs its values. */
  multi: boolean;
  /** `-key:value` excludes. */
  negatable: boolean;
  /** Key that this one is an alias of, if any. */
  aliasOf?: SupportedFilterKey;
  /** The closed set of values the key accepts, when it has one (`is:`); anything else is warned about. */
  values?: readonly string[];
}

export type SupportedFilterKey =
  | 'tag'
  | 'category'
  | 'group'
  | 'topic'
  | 'space'
  | 'type'
  | 'status'
  | 'author'
  | 'updated'
  | 'is';

/**
 * The values `is:` accepts, over the indexed lifecycle signals:
 *
 *   - `verified` — trust tier `human-reviewed` or `machine-confirmed`
 *   - `unverified` — anything else, including no recorded tier
 *   - `human-reviewed`, `machine-confirmed` — that tier exactly
 *   - `needs-review` — stale: past `stale_after` (`stale` / display state `needs-review`)
 *   - `draft`, `published` — publication status, still under the visibility guard
 *
 * `is:draft` overlaps `status:draft` on purpose — `is:` is the reader's word,
 * `status:` the API's. They are independent filters and both must hold, so
 * `status:published is:draft` matches nothing rather than one silently winning.
 */
export const IS_FILTER_VALUES = [
  'verified',
  'unverified',
  'human-reviewed',
  'machine-confirmed',
  'needs-review',
  'draft',
  'published',
] as const;

export type IsFilterValue = (typeof IS_FILTER_VALUES)[number];

/** Other spellings a reader types, folded to the canonical value by the parser. */
const IS_FILTER_ALIASES: Record<string, IsFilterValue> = {
  // The reader plan's own word for it (§5.2).
  stale: 'needs-review',
};

/**
 * `updated:` resolved to a half-open interval of ISO 8601 UTC instants:
 * `after` inclusive, `before` exclusive; either may be absent. Compare them to
 * `updated_at` as instants, not as strings — `…T10:00:00Z` and
 * `…T10:00:00.000Z` are the same moment but do not sort as the same text.
 */
export interface UpdatedRange {
  after?: string;
  before?: string;
}

export interface ParseSearchQueryOptions {
  /** The clock relative `updated:` values count back from. Default: the current time. */
  now?: Date;
}

export const SUPPORTED_SEARCH_FILTERS: SearchFilterSpec[] = [
  { key: 'tag', description: 'Exact tag', example: 'tag:mqtt', multi: true, negatable: true },
  { key: 'category', description: 'Primary category (curated)', example: 'category:operations', multi: true, negatable: true },
  { key: 'group', description: 'Tag group, by id, slug or name', example: 'group:platform-eng', multi: true, negatable: true },
  { key: 'topic', description: 'Topic, by id, slug or name', example: 'topic:"Platform Service"', multi: true, negatable: true },
  { key: 'space', description: 'Alias of topic:', example: 'space:platform', multi: true, negatable: true, aliasOf: 'topic' },
  { key: 'type', description: 'Content type, e.g. Runbook or FAQ', example: 'type:Runbook', multi: true, negatable: true },
  { key: 'status', description: 'draft or published, subject to what you may see', example: 'status:draft', multi: false, negatable: false },
  {
    key: 'author',
    description: 'Author (frontmatter author or authors), exact name, any case',
    example: 'author:"Ada Lovelace"',
    multi: true,
    negatable: true,
  },
  {
    key: 'updated',
    description: 'Last updated: >2026-01-01, <=2025-06, 2026, or within 7d, 4w, 6m, 1y',
    example: 'updated:>2026-01-01',
    multi: false,
    negatable: false,
  },
  {
    key: 'is',
    description: 'verified, unverified, human-reviewed, machine-confirmed, needs-review, draft or published',
    example: 'is:verified',
    multi: true,
    negatable: true,
    values: IS_FILTER_VALUES,
  },
];

const SUPPORTED_FILTER_KEYS = new Set<SupportedFilterKey>(SUPPORTED_SEARCH_FILTERS.map((f) => f.key));

/** Keys that only ever take one value; a second one is reported, not silently dropped. */
const SINGLE_VALUE_KEYS = new Set<SupportedFilterKey>(
  SUPPORTED_SEARCH_FILTERS.filter((f) => !f.multi).map((f) => f.key),
);

/** Keys that cannot be negated; `-status:draft` is reported rather than ignored. */
const NON_NEGATABLE_KEYS = new Set<SupportedFilterKey>(
  SUPPORTED_SEARCH_FILTERS.filter((f) => !f.negatable).map((f) => f.key),
);

/** The shortest trailing token that becomes an FTS prefix term (`modb` → `modb*`). */
export const MIN_PREFIX_TERM_LENGTH = 2;

export type ParsedFilters = {
  [K in ParsedFilterKey]?: string[];
};

export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  phrases: string[];
  excludedTerms: string[];
  /** `-"exact phrase"` — excluded as a phrase, not as its separate words. */
  excludedPhrases: string[];
  filters: ParsedFilters;
  /** `-tag:legacy` — values to exclude, same keys as `filters`. */
  excludedFilters: ParsedFilters;
  /**
   * The trailing bare term, when the reader is mid-word: the last thing typed
   * was an ordinary term of at least `MIN_PREFIX_TERM_LENGTH` characters, so a
   * provider may match it as a prefix ("modb" finds "modbus"). Null for a
   * query ending in a phrase, a filter, or a one-character token — a quoted
   * phrase is never prefix-expanded.
   */
  prefixTerm: string | null;
  /**
   * `updated:` as an interval, present only when the value parsed; the raw
   * value stays in `filters.updated`. An unparseable value leaves both absent
   * and adds a warning.
   */
  updated?: UpdatedRange;
  warnings: string[];
}

export function parseSearchQuery(raw: string, opts: ParseSearchQueryOptions = {}): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    raw,
    terms: [],
    phrases: [],
    excludedTerms: [],
    excludedPhrases: [],
    filters: {},
    excludedFilters: {},
    prefixTerm: null,
    warnings: [],
  };
  const now = opts.now ?? new Date();

  let i = 0;
  while (i < raw.length) {
    i = skipWhitespace(raw, i);
    if (i >= raw.length) break;

    let isExcluded = false;
    if (raw[i] === '-') {
      isExcluded = true;
      i += 1;
      i = skipWhitespace(raw, i);
      if (i >= raw.length) break;
    }

    if (raw[i] === '"') {
      const closeIndex = findNextQuote(raw, i + 1);
      if (closeIndex === -1) {
        // Keep query useful text if quoting is malformed.
        parsed.warnings.push('Unclosed quote in search query.');
        const unmatched = raw.slice(i + 1);
        const legacyTerms = unmatched.trim().split(/\s+/).filter(Boolean);
        for (const legacyTerm of legacyTerms) {
          // Unclosed-quote text is not treated as an exact phrase because it was
          // not intentionally delimited.
          if (isExcluded) {
            parsed.excludedTerms.push(legacyTerm);
          } else {
            parsed.terms.push(legacyTerm);
          }
        }
        break;
      }

      const phrase = raw.slice(i + 1, closeIndex).trim();
      if (phrase.length) {
        addToken(parsed, phrase, isExcluded, { phraseMode: true, now });
      }
      i = closeIndex + 1;
      continue;
    }

    const { token, nextIndex } = readBareToken(raw, i);
    addToken(parsed, token, isExcluded, { phraseMode: false, now });
    i = nextIndex;
  }

  parsed.prefixTerm = trailingPrefixTerm(parsed);
  return parsed;
}

/**
 * The trailing term a provider may match as a prefix. It is the last term in
 * the query only when the query genuinely ENDS in that bare term: a query
 * ending in `tag:x` or a quoted phrase expands nothing, because the reader has
 * finished that word.
 */
function trailingPrefixTerm(parsed: ParsedSearchQuery): string | null {
  const trimmed = parsed.raw.trimEnd();
  const lastTerm = parsed.terms[parsed.terms.length - 1];
  if (!lastTerm || lastTerm.length < MIN_PREFIX_TERM_LENGTH) return null;
  // The raw query must end with exactly that term (a filter or a closing quote
  // at the end means the last thing typed was not this term).
  if (!trimmed.endsWith(lastTerm)) return null;
  const before = trimmed.slice(0, trimmed.length - lastTerm.length);
  if (before && !isWhitespace(before[before.length - 1])) return null;
  return lastTerm;
}

function addToken(
  parsed: ParsedSearchQuery,
  token: string,
  isExcluded: boolean,
  opts: { phraseMode: boolean; now: Date },
): void {
  if (!token) return;

  if (opts.phraseMode) {
    if (isExcluded) {
      // An excluded phrase excludes the phrase, not each of its words: `-"build
      // cache"` still returns a page about caches that never says "build cache".
      parsed.excludedPhrases.push(token);
      return;
    }

    // Exact phrase.
    parsed.phrases.push(token);
    return;
  }

  const filter = parseFilter(token);
  if (filter) {
    if (!isSupportedFilterKey(filter.key)) {
      parsed.warnings.push(`Unsupported structured filter ignored: ${filter.key}:${filter.value}`);
      return;
    }

    if (isExcluded) {
      if (NON_NEGATABLE_KEYS.has(filter.key)) {
        parsed.warnings.push(`Excluded filters are not supported for this key: -${filter.key}:${filter.value}`);
        return;
      }
      const value = validatedValue(parsed, filter.key, filter.value, opts.now);
      if (value !== null) addFilterValue(parsed.excludedFilters, filter.key, value);
      return;
    }

    const existing = parsed.filters[filter.key];
    if (SINGLE_VALUE_KEYS.has(filter.key) && existing?.length) {
      parsed.warnings.push(`Only one ${filter.key}: filter is applied; ignored ${filter.key}:${filter.value}`);
      return;
    }
    const value = validatedValue(parsed, filter.key, filter.value, opts.now);
    if (value !== null) addFilterValue(parsed.filters, filter.key, value);
    return;
  }

  const malformedFilter = parseMalformedFilter(token);
  if (malformedFilter) {
    parsed.warnings.push(`Malformed structured filter ignored: ${malformedFilter}:`);
    return;
  }

  if (isExcluded) {
    parsed.excludedTerms.push(token);
  } else {
    parsed.terms.push(token);
  }
}

/**
 * The value to record for a supported key, or null when it cannot be honoured
 * (a warning says so, and the filter is ignored rather than guessed at). Keys
 * with a closed or structured value set are checked here; the rest pass through.
 */
function validatedValue(parsed: ParsedSearchQuery, key: SupportedFilterKey, value: string, now: Date): string | null {
  if (key === 'is') {
    const canonical = canonicalIsValue(value);
    if (!canonical) {
      parsed.warnings.push(`Unknown is: value ignored: is:${value} (use ${IS_FILTER_VALUES.join(', ')})`);
    }
    return canonical;
  }
  if (key === 'updated') {
    const range = parseUpdatedFilter(value, now);
    if (!range) {
      parsed.warnings.push(
        `Unrecognised updated: value ignored: updated:${value} (use a date such as >2026-01-01, <=2025-06 or 2026, or a window such as 30d, 4w, 6m, 1y)`,
      );
      return null;
    }
    parsed.updated = range;
    return value;
  }
  return value;
}

/** `is:` value in canonical form (lowercase, aliases folded), or null when it is not one. */
export function canonicalIsValue(value: string): IsFilterValue | null {
  const lower = value.trim().toLowerCase();
  if ((IS_FILTER_VALUES as readonly string[]).includes(lower)) return lower as IsFilterValue;
  return IS_FILTER_ALIASES[lower] ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_UPDATED = /^(\d{1,4})([dwmy])$/;
const DATE_UPDATED = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * An `updated:` value as an interval of UTC instants, or null when it is not a
 * value this language accepts.
 *
 * A calendar value names a whole period — `2026-03-14` is that day, `2026-03`
 * that month, `2026` that year — and the comparator picks an edge of it:
 *
 *   | value          | after (inclusive)  | before (exclusive) |
 *   |----------------|--------------------|--------------------|
 *   | `2026-03`      | 2026-03-01         | 2026-04-01         |
 *   | `>2026-03`     | 2026-04-01         | —                  |
 *   | `>=2026-03`    | 2026-03-01         | —                  |
 *   | `<2026-03`     | —                  | 2026-03-01         |
 *   | `<=2026-03`    | —                  | 2026-04-01         |
 *
 * so `>2026-03-14` means "after that day", not "after its first instant". A
 * relative value (`7d`, `4w`, `6m`, `1y`) means "updated within" and sets only
 * `after`, counted back from `now`; months and years step the calendar and clamp
 * to the month's last day (`6m` before 31 August is 28 or 29 February). Dates
 * are UTC: the index stores UTC instants, and a reader's time zone is not part
 * of a query string.
 */
export function parseUpdatedFilter(value: string, now: Date = new Date()): UpdatedRange | null {
  const trimmed = value.trim().toLowerCase();

  const relative = RELATIVE_UPDATED.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    if (amount <= 0 || Number.isNaN(now.getTime())) return null;
    const unit = relative[2];
    const after =
      unit === 'd' ? new Date(now.getTime() - amount * DAY_MS)
      : unit === 'w' ? new Date(now.getTime() - amount * 7 * DAY_MS)
      : shiftUtcMonths(now, -(unit === 'm' ? amount : amount * 12));
    return Number.isNaN(after.getTime()) ? null : { after: after.toISOString() };
  }

  const comparator = /^(>=|<=|>|<)?(.*)$/.exec(trimmed)!;
  const op = comparator[1] ?? '';
  const period = calendarPeriod(comparator[2]!);
  if (!period) return null;
  switch (op) {
    case '>':
      return { after: period.end };
    case '>=':
      return { after: period.start };
    case '<':
      return { before: period.start };
    case '<=':
      return { before: period.end };
    default:
      return { after: period.start, before: period.end };
  }
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as `[start, end)` ISO instants, or null when not a real date. */
function calendarPeriod(value: string): { start: string; end: string } | null {
  const m = DATE_UPDATED.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? null : Number(m[2]);
  const day = m[3] === undefined ? null : Number(m[3]);
  if (month !== null && (month < 1 || month > 12)) return null;
  if (month !== null && day !== null && (day < 1 || day > daysInUtcMonth(year, month - 1))) return null;

  const start =
    month === null ? utc(year, 0, 1) : day === null ? utc(year, month - 1, 1) : utc(year, month - 1, day);
  const end =
    month === null ? utc(year + 1, 0, 1) : day === null ? utc(year, month, 1) : utc(year, month - 1, day + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function utc(year: number, monthIndex: number, day: number): Date {
  const date = new Date(Date.UTC(year, monthIndex, day));
  // Date.UTC maps years 0–99 to 1900–1999; set the year explicitly so `0099` stays 99.
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return utc(year, monthIndex + 1, 0).getUTCDate();
}

function shiftUtcMonths(from: Date, months: number): Date {
  const total = from.getUTCFullYear() * 12 + from.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(from.getUTCDate(), daysInUtcMonth(year, monthIndex));
  const shifted = new Date(from.getTime());
  shifted.setUTCFullYear(year, monthIndex, day);
  return shifted;
}

function addFilterValue(target: ParsedFilters, key: ParsedFilterKey, value: string): void {
  const values = target[key] ?? [];
  // Repeating a value is a typo, not an intent to narrow twice.
  if (!values.some((existing) => existing.toLowerCase() === value.toLowerCase())) values.push(value);
  target[key] = values;
}

function parseFilter(token: string): { key: ParsedFilterKey; value: string } | null {
  const idx = token.indexOf(':');
  if (idx <= 0) return null;

  const key = token.slice(0, idx).toLowerCase();
  if (!KNOWN_FILTER_KEYS.has(key as ParsedFilterKey)) return null;

  const value = stripSurroundingQuotes(token.slice(idx + 1).trim());
  if (!value) return null;

  return { key: key as ParsedFilterKey, value };
}

function isSupportedFilterKey(key: ParsedFilterKey): key is SupportedFilterKey {
  return SUPPORTED_FILTER_KEYS.has(key as SupportedFilterKey);
}

function parseMalformedFilter(token: string): ParsedFilterKey | null {
  if (!token.endsWith(':')) return null;
  const key = token.slice(0, -1).toLowerCase();
  if (!KNOWN_FILTER_KEYS.has(key as ParsedFilterKey)) return null;
  return key as ParsedFilterKey;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;

  const startsDouble = value.startsWith('"') && value.endsWith('"');
  const startsSingle = value.startsWith("'") && value.endsWith("'");
  if (startsDouble || startsSingle) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function readBareToken(raw: string, start: number): { token: string; nextIndex: number } {
  let end = start;
  while (end < raw.length && !isWhitespace(raw[end])) {
    if (raw[end] === ':' && raw[end + 1] === '"') {
      const closeIndex = findNextQuote(raw, end + 2);
      if (closeIndex !== -1) {
        return { token: raw.slice(start, closeIndex + 1), nextIndex: closeIndex + 1 };
      }
    }
    end += 1;
  }
  return { token: raw.slice(start, end), nextIndex: end };
}

function findNextQuote(raw: string, start: number): number {
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '"') return i;
  }
  return -1;
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function skipWhitespace(raw: string, start: number): number {
  let i = start;
  while (i < raw.length && isWhitespace(raw[i])) i += 1;
  return i;
}

/** The free text of a parsed query — phrases requoted, terms as typed. */
export function freeTextOf(parsed: ParsedSearchQuery): string | undefined {
  const parts = [...parsed.phrases.map((phrase) => `"${phrase}"`), ...parsed.terms];
  return parts.length ? parts.join(' ') : undefined;
}

/** True when the query asks for something textual (as opposed to filters only). */
export function hasTextSignal(parsed: ParsedSearchQuery): boolean {
  return parsed.terms.length > 0 || parsed.phrases.length > 0;
}
