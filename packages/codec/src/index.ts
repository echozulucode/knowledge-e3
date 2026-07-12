/**
 * @echozedlabs/codec - Markdown round-trip codec.
 *
 * The kill-criterion module from v0.1-spec.md section 12. The contract:
 *  - Parse Markdown + YAML frontmatter into a structured representation.
 *  - Serialise that representation back to Markdown.
 *  - Byte-identical on no-op edits across the test fixture corpus.
 *
 * Design notes:
 *  - Frontmatter is parsed with `gray-matter` (per spec section 3.1).
 *  - The body uses unified/remark with remark-gfm to build an AST for surgical edits.
 *  - Wiki-links (`[[Page Title]]`) are not a remark plugin in v0.1 because that
 *    would alter serialisation. They are detected via a separate scanner that
 *    consults the AST for no-go zones (code blocks, image alt, etc.).
 *  - Unknown frontmatter keys round-trip unchanged.
 *  - The default `serialize` returns raw bytes verbatim. Surgical edits use
 *    `serializeWithBody` plus byte-offset splicing to keep everything else stable.
 */

export { parse, serialize, serializeWithBody, roundTrip } from './codec.js';
export { extractWikiLinks, extractItemLinks, rewriteWikiLinks } from './wikilinks.js';
export * from './types.js';
