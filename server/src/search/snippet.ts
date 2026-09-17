/**
 * Snippet helpers the search results and the related/backlink rows share. The
 * matching itself is `packages/search`'s excerpt module; this only covers the
 * case it deliberately does not — a row with nothing to highlight.
 */
import type { ExcerptResult } from '@echozedlabs/search';

/**
 * The opening of a text, cut on a word boundary at about `maxChars`, for a row
 * with nothing to highlight. (`excerpt` only builds windows around a match.)
 */
export function leadOf(text: string, maxChars: number): ExcerptResult {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return { text: collapsed, highlights: [], truncatedStart: false, truncatedEnd: false };
  const space = collapsed.lastIndexOf(' ', maxChars);
  // Back off to the previous word unless that would throw away most of the room
  // (one enormous token, such as a URL): then cut inside it.
  let end = space > maxChars * 0.6 ? space : maxChars;
  // Never between the halves of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(collapsed[end - 1] ?? '')) end -= 1;
  const cut = collapsed.slice(0, end).replace(/[\s,;:\-–—]+$/u, '');
  return { text: cut, highlights: [], truncatedStart: false, truncatedEnd: true };
}

