import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import type { Frontmatter, ParsedPage } from './types.js';

const FRONTMATTER_FENCE = /^---\r?\n/;

/**
 * Parse a Markdown document into structured form, preserving raw bytes.
 *
 * Design choices:
 *  - We use `gray-matter` for frontmatter parsing (per v0.1-spec.md §3.1).
 *  - We use unified/remark + remark-gfm to build the body AST.
 *  - The original `raw` input is preserved verbatim. This is the foundation of
 *    the byte-stable round-trip: `serialize(parse(raw)) === raw` by construction.
 *  - Edits are performed surgically on `raw` body text using AST-derived byte offsets,
 *    not by re-serialising the AST (see `wikilinks.ts`).
 */
export function parse(raw: string): ParsedPage {
  const { rawFrontmatter, body, hasFrontmatter, frontmatter, trailing } =
    splitFrontmatter(raw);

  // Build the body AST with positions for surgical edits.
  const processor = unified().use(remarkParse).use(remarkGfm);
  const ast = processor.parse(body) as Root;

  return {
    raw,
    frontmatter,
    body,
    ast,
    hasFrontmatter,
    rawFrontmatter,
    trailing,
  };
}

/**
 * Serialise a ParsedPage back to a Markdown string.
 *
 * The default path is the no-op: return raw. This is the byte-stability guarantee.
 *
 * For pages where the body has been edited surgically (e.g. wiki-link rewrite),
 * the caller must use `serializeWithBody` so we can rebuild the document from
 * the original frontmatter block + the new body text.
 */
export function serialize(parsed: ParsedPage): string {
  return parsed.raw;
}

/**
 * Rebuild a document from its original frontmatter block and an edited body.
 * Used by surgical-edit paths (e.g. `rewriteWikiLinks`).
 *
 * The frontmatter block is preserved verbatim — we never re-serialise YAML on this path.
 * Trailing whitespace / final-newline behaviour from the original is preserved.
 */
export function serializeWithBody(parsed: ParsedPage, newBody: string): string {
  return `${parsed.rawFrontmatter}${newBody}${parsed.trailing}`;
}

/**
 * Round-trip a Markdown string through parse + serialize.
 *
 * This is the kill-criterion entry point from v0.1-spec.md §12: the corpus must
 * round-trip byte-identical on no-op transforms.
 */
export function roundTrip(raw: string): string {
  return serialize(parse(raw));
}

interface FrontmatterSplit {
  rawFrontmatter: string;
  body: string;
  hasFrontmatter: boolean;
  frontmatter: Frontmatter;
  trailing: string;
}

/**
 * Split a raw input into (frontmatter, body, trailing) preserving byte boundaries.
 *
 * Uses gray-matter to parse the frontmatter object, but locates the delimiter blocks
 * ourselves so we can keep the original frontmatter bytes for round-trip stability.
 *
 * Recovery: if the input opens with `---` but the YAML is invalid, we treat the
 * document as having no frontmatter and surface an empty frontmatter object.
 * The raw bytes are preserved on the round-trip path regardless.
 */
/** Keys that must never be copied off untrusted YAML onto a JS object. */
const FORBIDDEN_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copy frontmatter onto a null-prototype object, dropping prototype-polluting
 * keys (`__proto__`/`constructor`/`prototype`). gray-matter/js-yaml can surface
 * these as own properties from a hostile document; stripping them here keeps
 * every downstream consumer (which spreads/indexes frontmatter) safe.
 */
function sanitizeFrontmatter(data: Record<string, unknown>): Frontmatter {
  const clean = Object.create(null) as Frontmatter;
  for (const [key, value] of Object.entries(data)) {
    if (FORBIDDEN_FRONTMATTER_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function noFrontmatter(raw: string): FrontmatterSplit {
  return {
    rawFrontmatter: '',
    body: raw,
    hasFrontmatter: false,
    frontmatter: sanitizeFrontmatter({}),
    trailing: '',
  };
}

function splitFrontmatter(raw: string): FrontmatterSplit {
  // Tolerate a leading UTF-8 BOM: detect the frontmatter fence after it, but
  // keep the BOM byte attached to rawFrontmatter so the round-trip stays
  // byte-stable. Without this, a BOM'd document parsed as having no frontmatter.
  const bom = raw.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const text = bom ? raw.slice(bom.length) : raw;

  if (!FRONTMATTER_FENCE.test(text)) {
    return noFrontmatter(raw);
  }

  // Find the closing fence. It must be a `---` on its own line.
  // Use a regex anchored to a line-start that comes after the opening fence.
  // We search starting from after the first newline.
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) {
    return noFrontmatter(raw);
  }

  const afterOpen = firstNewline + 1;
  const closing = findClosingFence(text, afterOpen);
  if (closing === -1) {
    // Opening fence with no close — treat as no frontmatter.
    return noFrontmatter(raw);
  }

  const rawFrontmatterNoBom = text.slice(0, closing.endIdx);
  const body = text.slice(closing.endIdx);

  let frontmatter: Frontmatter = sanitizeFrontmatter({});
  try {
    const parsed = matter(rawFrontmatterNoBom + body);
    frontmatter = sanitizeFrontmatter((parsed.data ?? {}) as Record<string, unknown>);
  } catch {
    // Invalid YAML — recovery path. Empty frontmatter; raw bytes preserved.
    frontmatter = sanitizeFrontmatter({});
  }

  return {
    // Re-attach the BOM so serializeWithBody (rawFrontmatter + body) round-trips.
    rawFrontmatter: bom + rawFrontmatterNoBom,
    body,
    hasFrontmatter: true,
    frontmatter,
    trailing: '',
  };
}

interface ClosingFenceLocation {
  /** Byte index of the start of the closing `---` line. */
  startIdx: number;
  /** Byte index just past the trailing newline of the closing fence. */
  endIdx: number;
}

function findClosingFence(raw: string, fromIdx: number): ClosingFenceLocation | -1 {
  // Scan line by line from fromIdx.
  let cursor = fromIdx;
  while (cursor < raw.length) {
    const lineEnd = raw.indexOf('\n', cursor);
    const lineRawEnd = lineEnd === -1 ? raw.length : lineEnd;
    const line = raw.slice(cursor, lineRawEnd).replace(/\r$/, '');
    if (line === '---') {
      const endIdx = lineEnd === -1 ? raw.length : lineEnd + 1;
      return { startIdx: cursor, endIdx };
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }
  return -1;
}
