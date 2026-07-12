import { parse, extractWikiLinks } from '@echozedlabs/codec';
import type { LinkStyle } from './types.js';

/**
 * Resolves a wiki-link target title to a bundle-relative path (e.g.
 * `/concepts/my-page.md`), or `undefined` when the target is not in the bundle.
 */
export type LinkResolver = (title: string) => string | undefined;

/**
 * Translate `[[wiki-links]]` in an E3 document body into OKF-friendly links.
 *
 * Operates on the parsed body (so frontmatter is excluded) and uses the codec's
 * AST-aware `extractWikiLinks`, which already ignores wiki-link syntax inside
 * fenced/inline code and image alt text. Unresolved targets are left untouched —
 * OKF consumers tolerate broken links (spec §5.3).
 *
 * Note: the E3 codec recognizes only `[[Title]]` (no `[[Title|alias]]`) in v0.1.
 */
export function translateLinks(
  rawMarkdown: string,
  resolve: LinkResolver,
  style: LinkStyle = 'dual',
): string {
  const parsed = parse(rawMarkdown);
  if (style === 'preserve') return parsed.body;

  let body = parsed.body;
  const occurrences = extractWikiLinks(parsed);

  // Splice from the back so earlier byte offsets stay valid as we mutate.
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i];
    if (!occ) continue;
    const target = resolve(occ.target);
    if (!target) continue; // unresolved → leave the original token in place
    const markdownLink = `[${occ.target}](${target})`;
    const replacement = style === 'markdown' ? markdownLink : `${occ.raw} (${markdownLink})`;
    body = body.slice(0, occ.start) + replacement + body.slice(occ.end);
  }

  return body;
}
