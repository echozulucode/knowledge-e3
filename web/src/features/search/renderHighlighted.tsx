/**
 * `renderHighlighted(text, ranges)` — a search hit's title or snippet with the
 * server's match ranges wrapped in `<mark>` (normalisation rules: highlight.ts).
 *
 * Plain `<mark>`, no extra ARIA: screen readers either ignore it or say
 * "highlight" once, which is quieter than any label we could add, and the text
 * reads as one run either way. The colour is `--kp-mark-bg` behind inherited
 * text (SearchResultRow.css), so the match never changes the text's contrast.
 */
import type { ReactNode } from 'react';
import { highlightSegments } from './highlight.js';

export function renderHighlighted(text: string | null | undefined, ranges: unknown): ReactNode {
  if (!text) return text ?? null;
  const segments = highlightSegments(text, ranges);
  if (segments.length === 1 && !segments[0]!.marked) return text;
  // Index keys are right: the segments are a positional cut of one fixed string.
  return segments.map((segment, index) => (segment.marked ? <mark key={index} className="kp-mark">{segment.text}</mark> : segment.text));
}
