import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/**
 * The frontmatter keys this product renders as an image, in the order the
 * renderers consult them: `blogMeta.coverImageOf` (web) and
 * `KnowledgeQueryService.toFeedEntry` (the server's feed) both read
 * `cover` → `cover_image` → `hero_image` and nothing else. This list must stay
 * in lockstep with those two: a key that renders publicly has to be linked, and
 * a key that renders nothing must not be.
 *
 * Enumerated on purpose, rather than "any frontmatter string that looks like an
 * asset path". An `image_links` row is not a passive note — it is BOTH the
 * grant that makes an asset anonymously readable (`isPubliclyLinked`) AND the
 * lock that refuses its deletion (`ImagesService.remove`). Scanning arbitrary
 * frontmatter would let a path quoted in a `description`, named in a `sources`
 * entry, or left in a stray note silently publish an asset and pin it
 * undeletable forever. Only a top-level string value of one of these keys
 * counts — never one nested inside an array or an object.
 */
export const COVER_FRONTMATTER_KEYS = ['cover', 'cover_image', 'hero_image'] as const;

/**
 * The stored filename inside a root-relative `/assets/<file>` URL, or null.
 *
 * Same rule as `declareSiteAssets` in server-config: an off-instance
 * `https://cdn…/x.png` names nothing on this instance and so grants nothing. A
 * `?v=` or `#` suffix is trimmed because the asset store is keyed by filename
 * alone, and a nested path is rejected because stored names never contain one.
 */
function assetFileFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url.startsWith('/assets/')) return null;
  const file = url.slice('/assets/'.length).split(/[?#]/)[0] ?? '';
  return file.length > 0 && !file.includes('/') ? file : null;
}

/**
 * Bundle-relative asset filenames a page references — from its BODY and from
 * the cover keys of its FRONTMATTER.
 *
 * Body: catches BOTH image embeds `![alt](/assets/<file>)` and attachment links
 * `[label](/assets/<file>)` (e.g. a downloadable PDF), so a full-fidelity export
 * carries every referenced asset, not only inline images. The optional leading
 * `!` makes the image form a superset of the link form under one pattern.
 *
 * Frontmatter: a `cover:` never appears in the body, so before this it produced
 * NO `image_links` row at all. Three things followed from that, all wrong: the
 * cover was not publicly linked, so `/assets/<file>` 404'd for exactly the
 * anonymous reader a published post's cover exists for; a cover-only asset
 * looked orphaned in the admin media list and was therefore deletable; and a
 * full-fidelity export dropped it despite the contract above. Widening what
 * counts as a *reference* fixes all three at once. What counts as *public* —
 * published page, non-private topic — is deliberately untouched.
 *
 * `frontmatter` is optional so callers that genuinely have only a body (e.g. a
 * body-only diff) keep working; every page-save path passes it.
 */
export function extractAssetFiles(body: string, frontmatter?: Readonly<Record<string, unknown>>): string[] {
  const files = new Set<string>();
  for (const m of body.matchAll(/!?\[[^\]\n]*\]\(\/assets\/([^)\s"']+)\)/g)) {
    files.add(m[1]!);
  }
  if (frontmatter) {
    for (const key of COVER_FRONTMATTER_KEYS) {
      const file = assetFileFromUrl(frontmatter[key]);
      if (file) files.add(file);
    }
  }
  return [...files];
}

/**
 * Rebuild `image_links` for a page from its body and frontmatter, inside the
 * page-save transaction — the same discipline as wiki-links. This is what powers
 * orphan detection (images with no `image_links`) and what makes an asset
 * readable by an anonymous visitor.
 */
export async function syncImageLinksInTx(
  tx: Kysely<Database>,
  pageId: string,
  body: string,
  frontmatter?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tx.deleteFrom('image_links').where('page_id', '=', pageId).execute();
  const files = extractAssetFiles(body, frontmatter);
  if (files.length === 0) return;
  const imgs = await tx.selectFrom('images').select(['id']).where('file', 'in', files).execute();
  if (imgs.length === 0) return;
  await tx
    .insertInto('image_links')
    .values(imgs.map((i) => ({ page_id: pageId, image_id: i.id })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}
