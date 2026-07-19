/**
 * Blog presentation helpers — pure functions over a Page, so they can be unit
 * tested and reused by both the feed cards and the post header.
 *
 * These read frontmatter that the server preserves but does not interpret
 * (author, cover), plus the first-class `published_at` (demo-wave Phase 4.1).
 */

export interface BlogPageLike {
  body_markdown?: string;
  updated_at?: string;
  published_at?: string | null;
  authors?: string[];
  frontmatter?: Record<string, unknown>;
  type?: string | null;
}

const WORDS_PER_MINUTE = 225;

function fm(page: BlogPageLike): Record<string, unknown> {
  return page.frontmatter ?? {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Estimated reading time in whole minutes (>= 1), from the rendered-ish body. */
export function readingTimeMinutes(body: string | undefined): number {
  if (!body) return 1;
  const text = body
    .replace(/```[\s\S]*?```/g, ' ') // code fences
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/[#*_>[\]()!-]/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 1;
  const words = text.split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** Author display names, from `authors` (array) or `author` (string) frontmatter. */
export function authorsOf(page: BlogPageLike): string[] {
  const f = fm(page);
  const list = f['authors'] ?? page.authors;
  if (Array.isArray(list)) {
    const names = list.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
    if (names.length) return names;
  }
  const single = asString(f['author']);
  return single ? [single] : [];
}

/** Cover/hero image URL from frontmatter, if any. */
export function coverImageOf(page: BlogPageLike): string | null {
  const f = fm(page);
  return asString(f['cover']) ?? asString(f['cover_image']) ?? asString(f['hero_image']) ?? null;
}

/** Series name/slug this post belongs to (frontmatter `series`), if any. */
export function seriesOf(page: BlogPageLike): string | null {
  return asString(fm(page)['series']) ?? null;
}

/** The canonical publish date (ISO), or null when never published. */
export function publishDateOf(page: BlogPageLike): string | null {
  if (page.published_at) return page.published_at;
  const f = fm(page);
  return asString(f['published_at']) ?? asString(f['date']) ?? null;
}

/**
 * Date to SHOW on a feed card / header: the publish date when known, otherwise
 * the last-updated time so a card is never dateless. Returns an ISO string.
 */
export function displayDateOf(page: BlogPageLike): string | null {
  return publishDateOf(page) ?? asString(page.updated_at) ?? null;
}

/** Format an ISO date for display; empty string on an unparseable value. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A compact "By X · Mar 3, 2026 · 4 min read" byline (parts present only when known). */
export function bylineParts(page: BlogPageLike): string[] {
  const parts: string[] = [];
  const authors = authorsOf(page);
  if (authors.length) parts.push(`By ${authors.join(', ')}`);
  const date = formatDate(displayDateOf(page));
  if (date) parts.push(date);
  parts.push(`${readingTimeMinutes(page.body_markdown)} min read`);
  return parts;
}
