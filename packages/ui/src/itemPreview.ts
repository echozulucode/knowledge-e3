/**
 * itemPreview — the ONE rule for "what does this item say about itself"
 * (reader UX plan R1.4).
 *
 * Four rules existed before this one, and they disagreed: `Home.frontmatterSummary`
 * read `summary` only, `Sections.previewOf` and `PageView.summaryText` read
 * `summary` then `description`, and `feedCard` read `description` only. The same
 * item therefore showed a real description in one list and scraped body text in
 * the next — the single most visible way the product reads as several products.
 *
 * Precedence is `description` → `summary` → the first paragraph of the body:
 *
 * - `description` is what Compose's Publish drawer writes. It is the most
 *   recent, most deliberate editorial statement about the item, so it wins.
 * - `summary` is what OKF imports and pre-Publish-drawer items carry, so an
 *   older item still has a real preview rather than falling through to prose.
 * - The body's opening paragraph is the last resort, cut at a sentence boundary
 *   so a card never ends mid-clause with an ellipsis.
 *
 * Pure and dependency-free so every surface — and every unit test — can agree.
 */

/** Everything a preview can be read from. Every field is optional. */
export interface ItemPreviewSource {
  /** Frontmatter/publish-drawer `description`. */
  description?: string | null;
  /** Frontmatter `summary` (OKF imports, older items). */
  summary?: string | null;
  /** Item body markdown, frontmatter already stripped. */
  body?: string | null;
}

/** Longest preview we will cut from body prose, in characters. */
const BODY_LIMIT = 220;

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Strip the markdown that would read as noise in a one-line preview: fenced
 * code, headings, images, list markers and inline emphasis/link punctuation.
 * This is a preview, not a renderer — it only has to produce readable prose.
 */
function bodyLead(body: string): string | null {
  const withoutBlocks = body
    .replace(/^---\n[\s\S]*?\n---\n/, '') // stray frontmatter, if any survived
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '') // callouts and quotes
    .replace(/^\s*(#{1,6})\s+.*$/gm, '') // headings
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // images

  // The first block of consecutive non-empty lines is the lead paragraph.
  const paragraph = withoutBlocks
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0);
  if (!paragraph) return null;

  const text = paragraph
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '') // list markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their label
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= BODY_LIMIT) return text;

  // Cut at the last sentence end inside the limit; fall back to the last word
  // boundary so a preview never splits a word.
  const window = text.slice(0, BODY_LIMIT);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd > BODY_LIMIT / 3) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(' ');
  return `${(wordEnd > 0 ? window.slice(0, wordEnd) : window).replace(/[,;:]$/, '')}…`;
}

/** The item's own description of itself, or `null` when it has nothing to say. */
export function itemPreview(source: ItemPreviewSource | null | undefined): string | null {
  if (!source) return null;
  const stated = firstNonEmpty(source.description, source.summary);
  if (stated) return stated;
  return source.body ? bodyLead(source.body) : null;
}
