import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/** Bundle-relative asset filenames referenced by `![alt](/assets/<file>)` in a body. */
export function extractAssetFiles(body: string): string[] {
  const files = new Set<string>();
  for (const m of body.matchAll(/!\[[^\]\n]*\]\(\/assets\/([^)\s"']+)\)/g)) {
    files.add(m[1]);
  }
  return [...files];
}

/**
 * Rebuild `image_links` for a page from its body, inside the page-save
 * transaction — the same discipline as wiki-links. This is what powers
 * orphan detection (images with no `image_links`).
 */
export async function syncImageLinksInTx(
  tx: Kysely<Database>,
  pageId: string,
  body: string,
): Promise<void> {
  await tx.deleteFrom('image_links').where('page_id', '=', pageId).execute();
  const files = extractAssetFiles(body);
  if (files.length === 0) return;
  const imgs = await tx.selectFrom('images').select(['id']).where('file', 'in', files).execute();
  if (imgs.length === 0) return;
  await tx
    .insertInto('image_links')
    .values(imgs.map((i) => ({ page_id: pageId, image_id: i.id })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}
