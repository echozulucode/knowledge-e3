/**
 * Parsed search query model.
 *
 * This parser intentionally keeps user intent separate from SQL/FTS syntax:
 * free-text terms, exact phrases, excluded terms, and structured filters are all
 * isolated so downstream builders can remain strict and safe.
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
  | 'modified';

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
]);

export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  phrases: string[];
  excludedTerms: string[];
  filters: {
    tag?: string[];
    category?: string[];
    group?: string[];
    topic?: string[];
    space?: string[];
    folder?: string[];
    status?: string[];
    author?: string[];
    type?: string[];
    created?: string[];
    modified?: string[];
  };
  warnings: string[];
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    raw,
    terms: [],
    phrases: [],
    excludedTerms: [],
    filters: {},
    warnings: [],
  };

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
        addToken(parsed, phrase, isExcluded, { phraseMode: true });
      }
      i = closeIndex + 1;
      continue;
    }

    const { token, nextIndex } = readBareToken(raw, i);
    addToken(parsed, token, isExcluded, { phraseMode: false });
    i = nextIndex;
  }

  return parsed;
}

function addToken(
  parsed: ParsedSearchQuery,
  token: string,
  isExcluded: boolean,
  opts: { phraseMode: boolean },
): void {
  if (!token) return;

  if (opts.phraseMode) {
    if (isExcluded) {
      // Excluded phrase support is kept simple: split to individual terms to avoid
      // unsupported boolean complexity while still preserving intent.
      for (const term of token.split(/\s+/).filter(Boolean)) {
        parsed.excludedTerms.push(term);
      }
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
      parsed.excludedTerms.push(`${filter.key}:${filter.value}`);
      parsed.warnings.push(`Excluded filters are not supported yet: ${filter.key}:${filter.value}`);
      return;
    }

    const target = parsed.filters[filter.key] ?? [];
    target.push(filter.value);
    parsed.filters[filter.key] = target;
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

function parseFilter(token: string): { key: ParsedFilterKey; value: string } | null {
  const idx = token.indexOf(':');
  if (idx <= 0) return null;

  const key = token.slice(0, idx).toLowerCase();
  if (!KNOWN_FILTER_KEYS.has(key as ParsedFilterKey)) return null;

  const value = stripSurroundingQuotes(token.slice(idx + 1).trim());
  if (!value) return null;

  return { key: key as ParsedFilterKey, value };
}

function isSupportedFilterKey(key: ParsedFilterKey): key is 'tag' | 'category' | 'group' | 'topic' | 'space' | 'status' {
  return key === 'tag' || key === 'category' || key === 'group' || key === 'topic' || key === 'space' || key === 'status';
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

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function skipWhitespace(raw: string, start: number): number {
  let i = start;
  while (i < raw.length && isWhitespace(raw[i])) i += 1;
  return i;
}
