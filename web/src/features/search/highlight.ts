/**
 * Where a search matched, as plain segments (reader UX plan §5.5, SEARCH-003).
 *
 * The server sends `highlights` as half-open `[start, end)` ranges in UTF-16
 * code units into the `title` and `snippet` it returned — ranges, never HTML,
 * so nothing it sends can become markup. The client does no matching of its
 * own: re-running a match in the browser would drift from the index (stemming,
 * prefix terms, phrases) and highlight words the ranker never used.
 *
 * The contract says the ranges arrive sorted, merged and in bounds. This module
 * does not take that on trust — a highlight is decoration, and decoration must
 * never be the reason a title fails to render — so it normalises what it gets:
 *
 *  - clamped to the string, empty ranges dropped;
 *  - sorted and merged, so overlapping or touching ranges become one `<mark>`;
 *  - widened by one unit wherever a boundary would split a surrogate pair, so
 *    an emoji or astral character is marked whole rather than torn in two;
 *  - anything malformed (not an array of finite number pairs) → the text is
 *    returned as one plain segment. A payload that is wrong in one place is not
 *    trusted in the others.
 *
 * Pure, so the rules are unit-tested; `renderHighlighted` (highlight.tsx) turns
 * the segments into React nodes.
 */
import type { HighlightRange } from '@echozedlabs/knowledge-types';

export interface HighlightSegment {
  text: string;
  marked: boolean;
}

export function normalizeHighlightRanges(text: string, ranges: unknown): HighlightRange[] | null {
  if (ranges === undefined || ranges === null) return [];
  if (!Array.isArray(ranges)) return null;
  const length = text.length;
  const clamped: HighlightRange[] = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length < 2) return null;
    const [rawStart, rawEnd] = range as unknown[];
    if (typeof rawStart !== 'number' || typeof rawEnd !== 'number' || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
    let start = Math.max(0, Math.min(length, Math.floor(rawStart)));
    let end = Math.max(0, Math.min(length, Math.ceil(rawEnd)));
    // Never cut a surrogate pair: a start on a low surrogate moves back onto its
    // high surrogate, an end just after a high surrogate moves past its low one.
    if (start > 0 && start < length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1;
    if (end > 0 && end < length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end += 1;
    if (end > start) clamped.push([start, end]);
  }
  clamped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: HighlightRange[] = [];
  for (const [start, end] of clamped) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The text cut into plain and marked runs; always covers the whole string, in order. */
export function highlightSegments(text: string, ranges: unknown): HighlightSegment[] {
  if (!text) return [];
  const normalized = normalizeHighlightRanges(text, ranges);
  if (!normalized || normalized.length === 0) return [{ text, marked: false }];
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of normalized) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), marked: false });
    segments.push({ text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), marked: false });
  return segments;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
