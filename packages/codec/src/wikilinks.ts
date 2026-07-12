import type { Code, Image, ImageReference, InlineCode, Link, Root, RootContent } from 'mdast';
import type { ItemLinkOccurrence, ParsedPage, RewriteResult, WikiLinkOccurrence } from './types.js';
import { parse, serializeWithBody } from './codec.js';

/**
 * Wiki-link scanner.
 *
 * Strategy (v0.1-spec.md §6.4 "implementation rule"):
 *  - Walk the AST to find byte ranges where wiki-link tokens MUST NOT be detected:
 *    code blocks, inline code, image references / alt text. These are "no-go zones".
 *  - Then regex-scan the body for `[[Title]]` tokens, dropping any match that
 *    overlaps a no-go zone.
 *  - Position offsets are returned in body coordinates (not raw-document coordinates),
 *    since wiki-link tokens never appear inside frontmatter.
 *
 * The regex deliberately disallows nested `[` and `]` to keep matching unambiguous,
 * and disallows pipe characters (Obsidian alias syntax `[[Page|alias]]` is deferred
 * past v0.1).
 */
const WIKILINK_RE = /\[\[([^\[\]\n|]+?)\]\]/g;

interface NoGoRange {
  start: number;
  end: number;
}

export function extractWikiLinks(parsed: ParsedPage): WikiLinkOccurrence[] {
  const noGo = collectNoGoRanges(parsed.ast);
  return scanBody(parsed.body, noGo);
}

/**
 * Unified item-link extraction for the storage/index path.
 *
 * Includes wiki-links plus ordinary Markdown links. Markdown links come from
 * the mdast Link nodes, so inline code and fenced code are naturally ignored;
 * wiki-links keep the same no-go-zone scanner as the rename flow.
 */
export function extractItemLinks(parsed: ParsedPage): ItemLinkOccurrence[] {
  const links: ItemLinkOccurrence[] = [
    ...extractWikiLinks(parsed).map((link) => ({
      type: 'wiki' as const,
      target: link.target,
      text: link.target,
      start: link.start,
      end: link.end,
      raw: link.raw,
    })),
    ...extractMarkdownLinks(parsed),
  ];
  return links.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * AST-aware atomic rewrite of all wiki-link tokens whose target equals `oldTitle`,
 * replacing with `newTitle`. Operates on the raw body bytes via offset splicing —
 * code blocks, image alt text, and incidental prose containing the title are left
 * untouched (per v0.1-spec.md §6.4).
 */
export function rewriteWikiLinks(
  parsed: ParsedPage,
  oldTitle: string,
  newTitle: string,
): RewriteResult {
  const occurrences = extractWikiLinks(parsed).filter((o) => o.target === oldTitle);
  if (occurrences.length === 0) {
    return { body: parsed.body, count: 0, rewrites: [] };
  }

  // Splice from the back so earlier offsets stay valid.
  let body = parsed.body;
  const replacement = `[[${newTitle}]]`;
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i]!;
    body = body.slice(0, occ.start) + replacement + body.slice(occ.end);
  }

  return { body, count: occurrences.length, rewrites: occurrences };
}

/**
 * Convenience: rewrite wiki-links in a raw page document and return the new raw text.
 * Wraps the parse/extract/splice/serializeWithBody flow.
 */
export function rewriteWikiLinksInDocument(
  raw: string,
  oldTitle: string,
  newTitle: string,
): { raw: string; count: number } {
  const parsed = parse(raw);
  const result = rewriteWikiLinks(parsed, oldTitle, newTitle);
  if (result.count === 0) return { raw, count: 0 };
  return { raw: serializeWithBody(parsed, result.body), count: result.count };
}

function collectNoGoRanges(ast: Root): NoGoRange[] {
  const ranges: NoGoRange[] = [];
  walk(ast, (node) => {
    if (
      node.type === 'code' ||
      node.type === 'inlineCode' ||
      node.type === 'image' ||
      node.type === 'imageReference' ||
      node.type === 'html'
    ) {
      const pos = node.position;
      if (pos && typeof pos.start.offset === 'number' && typeof pos.end.offset === 'number') {
        ranges.push({ start: pos.start.offset, end: pos.end.offset });
      }
    }
  });
  // Sort by start for binary-search-style overlap checks.
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function isInNoGo(idx: number, ranges: NoGoRange[]): boolean {
  // Linear scan; corpus pages are small. Optimise later if needed.
  for (const r of ranges) {
    if (idx < r.start) return false;
    if (idx >= r.start && idx < r.end) return true;
  }
  return false;
}

function scanBody(body: string, noGo: NoGoRange[]): WikiLinkOccurrence[] {
  const out: WikiLinkOccurrence[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isInNoGo(start, noGo)) continue;
    out.push({
      target: m[1]!.trim(),
      start,
      end,
      raw: m[0],
    });
  }
  return out;
}

type Visitor = (node: RootContent | Root | InlineCode | Code | Image | ImageReference | Link) => void;

function extractMarkdownLinks(parsed: ParsedPage): ItemLinkOccurrence[] {
  const links: ItemLinkOccurrence[] = [];
  walk(parsed.ast, (node) => {
    if (node.type !== 'link') return;
    const link = node as Link;
    const pos = link.position;
    if (!link.url || !pos || typeof pos.start.offset !== 'number' || typeof pos.end.offset !== 'number') {
      return;
    }
    links.push({
      type: 'markdown',
      target: link.url,
      text: plainText(link),
      start: pos.start.offset,
      end: pos.end.offset,
      raw: parsed.body.slice(pos.start.offset, pos.end.offset),
    });
  });
  return links;
}

function plainText(node: RootContent | Root): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  if ('children' in node && Array.isArray((node as { children: unknown[] }).children)) {
    return (node as { children: RootContent[] }).children.map((child) => plainText(child)).join('');
  }
  return '';
}

function walk(node: Root | RootContent, visit: Visitor): void {
  visit(node as Root | RootContent);
  if ('children' in node && Array.isArray((node as { children: unknown[] }).children)) {
    for (const child of (node as { children: RootContent[] }).children) {
      walk(child, visit);
    }
  }
}
