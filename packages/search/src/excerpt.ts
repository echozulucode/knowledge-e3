/**
 * Search excerpts and highlight ranges (reader UX plan §5.5, SEARCH-003).
 *
 * Pure and dependency-free: the server builds a result row's snippet and its
 * `highlights` with these, and a client only wraps the returned ranges in
 * `<mark>` — it never re-runs any matching, so the two cannot disagree about
 * where a query matched.
 *
 * The order of operations is the point of this module: Markdown is reduced to
 * readable prose FIRST (`plainTextForExcerpt`) and cut SECOND (`excerpt`).
 * Cutting raw Markdown is what left `[[Getting...` fragments in result rows
 * (issue 114) — a window boundary landed inside a wiki link.
 *
 * ## Matching rules (lexical only — no stemming, no fuzzy, no synonyms)
 *
 * They follow the FTS5 `unicode61` tokenizer the product's index uses, so a
 * highlight lands on what the index actually matched:
 *
 *   - A token is a maximal run of letters, digits and combining marks
 *     (`\p{L}\p{N}\p{M}`); everything else — whitespace, punctuation, `-`,
 *     `_`, `.`, `/`, symbols, emoji — separates tokens. Combining marks stay
 *     inside their token so a decomposed accent (`e` + U+0301) never splits a
 *     word, and offsets never land between a base letter and its mark.
 *   - Tokens compare case-insensitively with diacritics folded (`Café` = `cafe`),
 *     which is `unicode61`'s default `remove_diacritics` behaviour.
 *   - A term matches whole tokens only (`orm` does not match `platform`). A term
 *     that tokenizes into several tokens (`cert-manager`, `pg_ctl`) matches that
 *     token SEQUENCE, exactly as FTS5 treats it.
 *   - A phrase matches its token sequence with anything non-token between the
 *     words (`"pg ctl promote"` matches `pg_ctl  promote`), never a fragment.
 *   - `prefixTerm` (the word still being typed) matches when its last token is a
 *     prefix of a text token; the WHOLE text token is highlighted, because a
 *     half-highlighted word reads as a rendering bug.
 *
 * Porter stemming is deliberately NOT mirrored: the index may match `renewing`
 * for `renew`, and the excerpt then finds no literal match and returns null, so
 * the caller falls back to the description. A missing highlight is honest; a
 * guessed one is not.
 */
import type { HighlightRange } from '@echozedlabs/knowledge-types';
import { MIN_PREFIX_TERM_LENGTH } from './query-parser.js';

/** What to match: the parsed query's free text (see `ParsedSearchQuery`). */
export interface ExcerptMatch {
  terms: string[];
  phrases: string[];
  prefixTerm?: string | null;
}

export interface ExcerptResult {
  /**
   * The excerpt, whitespace-collapsed and cut on word boundaries. It never
   * contains an ellipsis character: the client renders `…` from the two
   * `truncated*` flags, so `highlights` offsets stay exact and a client can
   * style the marker however it likes.
   */
  text: string;
  /** Sorted, merged, non-overlapping `[start, end)` ranges into `text`, in UTF-16 code units. */
  highlights: HighlightRange[];
  /** Readable text was cut from before `text`. */
  truncatedStart: boolean;
  /** Readable text was cut from after `text`. */
  truncatedEnd: boolean;
}

export interface ExcerptOptions {
  /** Target length of `text`. Word-boundary cuts make the result approximate. Default 180. */
  maxChars?: number;
}

export const DEFAULT_EXCERPT_CHARS = 180;

/**
 * How far a cut may move to avoid splitting a word before it gives up and cuts
 * at the nearest token boundary instead. Keeps a 400-character URL or base64
 * run from blowing the excerpt up to the whole run.
 */
const MAX_WORD_EXTENSION = 30;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The best ≈`maxChars` window of `source` for a query, or null when nothing in
 * it matches (the caller then falls back to the item's description).
 *
 * `source` should already be plain text — pass Markdown through
 * `plainTextForExcerpt` first. The window chosen is the one containing the most
 * DISTINCT matched terms/phrases (a window with `docker` and `cache` beats one
 * with `docker` three times), the earliest such window on a tie.
 */
export function excerpt(source: string, match: ExcerptMatch, opts: ExcerptOptions = {}): ExcerptResult | null {
  const text = collapseWhitespace(source);
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_EXCERPT_CHARS));
  const tokens = tokenSpans(text);
  const matches = findMatches(tokens, buildNeedles(match));
  if (!matches.length) return null;

  if (text.length <= maxChars) {
    return { text, highlights: mergeRanges(matches), truncatedStart: false, truncatedEnd: false };
  }

  const { first, coreEnd } = bestWindow(matches, maxChars);
  const coreStart = first.start;

  // Place the window around the matched core, leaning a third of the spare room
  // before it and the rest after — a reader wants a little lead-in, and more of
  // what follows the match than what precedes it.
  const slack = Math.max(0, maxChars - (coreEnd - coreStart));
  let start = Math.max(0, coreStart - Math.floor(slack / 3));
  let end = Math.min(text.length, start + Math.max(maxChars, coreEnd - start));
  // Near the end of the text, spend the unused room on lead-in instead.
  if (end === text.length) start = Math.max(0, Math.min(start, end - maxChars));

  start = snapStart(text, tokens, start, coreStart);
  end = snapEnd(text, tokens, end, coreEnd);

  const truncatedStart = start > 0 && READABLE.test(text.slice(0, start));
  const truncatedEnd = end < text.length && READABLE.test(text.slice(end));
  // Trim the punctuation and space a cut leaves dangling (`, the` / `and;`), but
  // only at an edge that was actually cut: a sentence's own final period stays.
  if (truncatedStart) while (start < coreStart && EDGE_JUNK.test(text[start]!)) start += 1;
  if (truncatedEnd) while (end > coreEnd && EDGE_JUNK.test(text[end - 1]!)) end -= 1;

  const inside = matches
    .filter((m) => m.start >= start && m.end <= end)
    .map((m) => ({ start: m.start - start, end: m.end - start }));
  return { text: text.slice(start, end), highlights: mergeRanges(inside), truncatedStart, truncatedEnd };
}

/**
 * Every place `text` matches the query, under the same rules as `excerpt`, as
 * sorted, merged, non-overlapping ranges into `text` itself (no whitespace
 * collapsing — the offsets are into the string exactly as given). For titles.
 */
export function highlightRanges(text: string, match: ExcerptMatch): HighlightRange[] {
  return mergeRanges(findMatches(tokenSpans(text), buildNeedles(match)));
}

/**
 * Markdown reduced to readable prose, whitespace collapsed, ready to cut.
 *
 * Removes frontmatter, images and embeds, heading / list / blockquote / table
 * markers, emphasis, HTML tags and comments, footnote markers and link
 * reference definitions; keeps the visible text of links (`[text](url)` →
 * `text`, `[[target|label]]` → `label`, `[[target]]` → `target`) and the text of
 * inline and fenced code (collapsed, never re-interpreted as Markdown, so
 * `snake_case` and `a*b*c` inside code survive).
 */
export function plainTextForExcerpt(markdown: string): string {
  if (!markdown) return '';
  // A byte-order mark would stop the frontmatter rule anchoring at the start.
  let text = (markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown).replace(/\r\n?/g, '\n');
  text = text.replace(FRONTMATTER, '');

  // Code and backslash escapes are parked behind private-use placeholders so no
  // later rule can reinterpret them, then restored at the end.
  const held: string[] = [];
  const hold = (value: string): string => {
    held.push(value);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };
  text = text.replace(FENCED_CODE, (_all, _fence: string, body: string) => `\n${hold(collapseWhitespace(body))}\n`);
  text = text.replace(INLINE_CODE, (_all, _ticks: string, body: string) => hold(collapseWhitespace(body)));
  text = text.replace(BACKSLASH_ESCAPE, (_all, char: string) => hold(char));

  text = text.split('\n').map(stripLineMarkers).join('\n');

  text = text
    .replace(HTML_COMMENT, ' ')
    .replace(WIKI_EMBED, ' ')
    .replace(IMAGE_INLINE, ' ')
    .replace(IMAGE_REFERENCE, ' ')
    .replace(WIKI_LINK, (_all, target: string, label: string | undefined) => (label?.trim() || target.replace(/#/g, ' ').trim()))
    .replace(FOOTNOTE_REF, '')
    .replace(LINK_INLINE, '$1')
    .replace(LINK_REFERENCE, '$1')
    .replace(AUTOLINK, '$1')
    .replace(HTML_TAG, ' ')
    .replace(STRONG_STARS, '$1')
    .replace(STRONG_UNDERSCORES, '$1')
    .replace(STRIKETHROUGH, '$1')
    .replace(EMPHASIS_STAR, '$1')
    .replace(EMPHASIS_UNDERSCORE, '$1');
  // Entities last among the rewrites, so `&lt;div&gt;` becomes visible text
  // rather than a tag the HTML rule would then delete.
  text = decodeEntities(text);

  text = text.replace(HELD, (_all, index: string) => held[Number(index)] ?? '');
  return collapseWhitespace(text);
}

// ---------------------------------------------------------------------------
// Tokens and matching
// ---------------------------------------------------------------------------

interface TokenSpan {
  start: number;
  end: number;
  /** Lowercased, diacritics folded. */
  norm: string;
}

interface Needle {
  /** Distinctness key: the normalized token sequence. */
  key: string;
  tokens: string[];
  /** The last token matches as a prefix (the word still being typed). */
  prefixLast: boolean;
}

interface MatchSpan {
  start: number;
  end: number;
  key: string;
}

const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
const MARKS = /\p{M}+/gu;

/** The one token normalization, shared by text and query so both sides fold alike. */
function normalizeToken(value: string): string {
  // Lowercase BEFORE decomposing: `İ`.toLowerCase() yields `i` + a combining
  // dot, which the mark strip then removes.
  return value.toLowerCase().normalize('NFD').replace(MARKS, '');
}

function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const norm = normalizeToken(m[0]);
    // A run of bare combining marks folds to nothing and cannot match anything.
    if (norm) spans.push({ start: m.index, end: m.index + m[0].length, norm });
  }
  return spans;
}

function queryTokens(value: string): string[] {
  return tokenSpans(value).map((t) => t.norm);
}

function buildNeedles(match: ExcerptMatch): Needle[] {
  const needles = new Map<string, Needle>();
  const prefixTokens = match.prefixTerm ? queryTokens(match.prefixTerm) : [];
  const prefixKey = prefixTokens.join(' ');
  const prefixUsable = prefixTokens.length > 0 && prefixTokens[prefixTokens.length - 1]!.length >= MIN_PREFIX_TERM_LENGTH;

  const add = (tokens: string[], prefixLast: boolean): void => {
    if (!tokens.length) return;
    const key = tokens.join(' ');
    const existing = needles.get(key);
    // A prefix needle subsumes the exact one with the same tokens.
    if (!existing || (prefixLast && !existing.prefixLast)) needles.set(key, { key, tokens, prefixLast });
  };

  for (const term of match.terms) {
    const tokens = queryTokens(term);
    add(tokens, prefixUsable && tokens.join(' ') === prefixKey);
  }
  // Phrases are never prefix-expanded.
  for (const phrase of match.phrases) add(queryTokens(phrase), false);
  // A prefix term the caller did not also list among the terms still matches.
  if (prefixUsable) add(prefixTokens, true);
  return [...needles.values()];
}

/** Every needle occurrence, sorted by start (then end). */
function findMatches(tokens: TokenSpan[], needles: Needle[]): MatchSpan[] {
  const found: MatchSpan[] = [];
  for (const needle of needles) {
    const n = needle.tokens.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let ok = true;
      for (let k = 0; k < n && ok; k += 1) {
        const token = tokens[i + k]!.norm;
        const want = needle.tokens[k]!;
        ok = k === n - 1 && needle.prefixLast ? token.startsWith(want) : token === want;
      }
      if (ok) found.push({ start: tokens[i]!.start, end: tokens[i + n - 1]!.end, key: needle.key });
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

function mergeRanges(spans: { start: number; end: number }[]): HighlightRange[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HighlightRange[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last[1]) last[1] = Math.max(last[1], span.end);
    else merged.push([span.start, span.end]);
  }
  return merged;
}

/**
 * The window of about `maxChars` that starts at a match and holds the most
 * distinct needles; the earliest on a tie. `coreEnd` is where the last match
 * inside it ends (at least the first match's own end, even when that single
 * match is longer than `maxChars`).
 */
function bestWindow(matches: MatchSpan[], maxChars: number): { first: MatchSpan; coreEnd: number } {
  let best = { first: matches[0]!, coreEnd: matches[0]!.end, distinct: 0 };
  for (let i = 0; i < matches.length; i += 1) {
    const first = matches[i]!;
    const limit = first.start + maxChars;
    const keys = new Set<string>([first.key]);
    let coreEnd = first.end;
    for (let j = i + 1; j < matches.length && matches[j]!.start < limit; j += 1) {
      if (matches[j]!.end > limit) continue;
      keys.add(matches[j]!.key);
      coreEnd = Math.max(coreEnd, matches[j]!.end);
    }
    // Strictly greater: an equal count keeps the earlier window.
    if (keys.size > best.distinct) best = { first, coreEnd, distinct: keys.size };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Word-boundary cuts
// ---------------------------------------------------------------------------

/** Anything a reader would miss if it were cut away. */
const READABLE = /[^\s\p{P}]/u;
/** What a cut may trim from its edge. */
const EDGE_JUNK = /[\s\p{P}]/u;

/**
 * Move a window start onto the beginning of a word, never past `limit` (the
 * first match). The text is whitespace-collapsed, so a word is a run between
 * single spaces.
 */
function snapStart(text: string, tokens: TokenSpan[], start: number, limit: number): number {
  if (start <= 0) return 0;
  if (text[start - 1] === ' ') return start;
  if (text[start] === ' ') return start + 1;
  // Mid-word: drop the partial word...
  const nextSpace = text.indexOf(' ', start);
  if (nextSpace !== -1 && nextSpace + 1 <= limit) return nextSpace + 1;
  // ...unless the match itself is inside that word (`(modbus)`, `foo/modbus`):
  // then take the whole word instead, if it is not absurdly long...
  const wordStart = text.lastIndexOf(' ', start - 1) + 1;
  if (start - wordStart <= MAX_WORD_EXTENSION) return wordStart;
  // ...and otherwise the nearest token start, which is always a safe cut: never
  // inside a surrogate pair, never before a combining mark.
  for (const token of tokens) if (token.start >= start && token.start <= limit) return token.start;
  return limit;
}

/** Move a window end onto the end of a word, never before `limit` (the last match's end). */
function snapEnd(text: string, tokens: TokenSpan[], end: number, limit: number): number {
  if (end >= text.length) return text.length;
  if (text[end] === ' ') return end;
  if (text[end - 1] === ' ') return end - 1;
  const prevSpace = text.lastIndexOf(' ', end - 1);
  if (prevSpace !== -1 && prevSpace >= limit) return prevSpace;
  const nextSpace = text.indexOf(' ', end);
  const wordEnd = nextSpace === -1 ? text.length : nextSpace;
  if (wordEnd - end <= MAX_WORD_EXTENSION) return wordEnd;
  let cut = limit;
  for (const token of tokens) if (token.end <= end && token.end >= limit) cut = Math.max(cut, token.end);
  return cut;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Markdown stripping rules
// ---------------------------------------------------------------------------

/** Private-use code points: they cannot collide with anything a reader wrote. */
const HOLD_OPEN = String.fromCharCode(0xe000);
const HOLD_CLOSE = String.fromCharCode(0xe001);
const HELD = new RegExp(`${HOLD_OPEN}([0-9]+)${HOLD_CLOSE}`, 'g');

const FRONTMATTER = /^(?:---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)|\+\+\+[ \t]*\n[\s\S]*?\n\+\+\+)[ \t]*(?:\n|$)/;
/** A fenced block, closed by the same fence or by the end of the document. */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const BACKSLASH_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~<>"'])/g;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const WIKI_EMBED = /!\[\[[^\]]*\]\]/g;
const IMAGE_INLINE = /!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g;
const IMAGE_REFERENCE = /!\[[^\]]*\]\[[^\]]*\]/g;
const WIKI_LINK = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
const FOOTNOTE_REF = /\[\^[^\]]+\]/g;
const LINK_INLINE = /\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g;
const LINK_REFERENCE = /\[([^\]]+)\]\[[^\]]*\]/g;
const AUTOLINK = /<((?:https?|mailto|ftp):[^>\s]+)>/g;
/** A real tag (`<div class="x">`, `</p>`, `<br/>`), not prose like `a < b > c`. */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;

const STRONG_STARS = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
const STRONG_UNDERSCORES = /(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu;
const STRIKETHROUGH = /~~(?=\S)(.+?)(?<=\S)~~/g;
const EMPHASIS_STAR = /(?<![\p{L}\p{N}*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\p{L}\p{N}*])/gu;
/** Never intraword, so `modbus_rtu_frame` keeps its underscores. */
const EMPHASIS_UNDERSCORE = /(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu;

/** Block-level markers, one line at a time. */
function stripLineMarkers(line: string): string {
  if (/^\s{0,3}(?:[-*_][ \t]*){3,}$/.test(line)) return ''; // thematic break / setext `---`
  if (/^\s{0,3}=+[ \t]*$/.test(line)) return ''; // setext `===`
  if (/^\s{0,3}\[(?!\^)[^\]]+\]:\s+\S/.test(line)) return ''; // link reference definition (not a footnote)
  if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')) return ''; // table rule
  let out = line
    .replace(/^\s{0,3}(?:>[ \t]?)+/, '') // blockquote
    .replace(/^\[![A-Za-z-]+\][+-]?[ \t]*/, '') // callout `> [!note]`
    .replace(/^\s{0,3}#{1,6}(?:[ \t]+|$)/, '') // ATX heading
    .replace(/[ \t]+#+[ \t]*$/, '') // closing heading hashes
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '') // list marker
    .replace(/^\[[ xX]\][ \t]+/, '') // task checkbox
    .replace(/^\[\^[^\]]+\]:[ \t]*/, ''); // footnote definition
  if (/^\s*\|/.test(out) || (out.match(/\|/g)?.length ?? 0) >= 2) out = out.replace(/\s*\|\s*/g, ' ');
  return out;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}
