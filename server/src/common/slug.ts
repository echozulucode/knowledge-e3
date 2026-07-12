/**
 * Slug derivation for v0.1.
 *
 * - Lowercase ASCII + digits + hyphen only.
 * - Whitespace and punctuation collapse to a single hyphen.
 * - Leading/trailing hyphens trimmed.
 * - Capped at 200 chars to fit the column.
 *
 * Collision policy: caller decides. v0.1's pages service auto-disambiguates
 * with a `-2`, `-3`, ... suffix when a collision would occur.
 */
export function slugify(title: string): string {
  const normalised = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  return normalised || 'untitled';
}
