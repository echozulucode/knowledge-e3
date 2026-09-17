/**
 * The one-line summary of an item, read from its frontmatter.
 *
 * Every publishable item carries a `description` (the publish lint gate refuses
 * the draft→published transition without one), and it is the best short answer
 * an item has about itself — so it is indexed in `pages_fts` alongside title,
 * body and tags and weighted between the two by the ranker.
 *
 * `summary` is the older spelling: `packages/okf` reads `description ?? summary`
 * when importing and writes `summary` when exporting, so content that predates
 * the content model carries the value under that key. Both are accepted here for
 * the same reason the importer accepts both — the field is the same field.
 */
export function descriptionFromFrontmatter(frontmatter: Record<string, unknown> | null | undefined): string {
  if (!frontmatter) return '';
  const value = frontmatter['description'] ?? frontmatter['summary'];
  return typeof value === 'string' ? value.trim() : '';
}

/** The same, from the stored `page_versions.frontmatter_json`. Never throws. */
export function descriptionFromFrontmatterJson(json: string | null | undefined): string {
  if (!json) return '';
  try {
    return descriptionFromFrontmatter(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return '';
  }
}
