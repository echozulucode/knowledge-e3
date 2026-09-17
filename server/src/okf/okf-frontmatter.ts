/**
 * The base OKF-to-E3 frontmatter mapping. Every inbound door — rebuild-from-git,
 * git sync (`ContentCommandsService.indexFromFile`) and the bundle import — maps
 * a concept through `e3FrontmatterFromFile` in index-rebuild.service.ts, which
 * starts from this function and corrects it against the file.
 *
 * Its own module, with no Nest dependencies, because it used to live in
 * `okf-import.service.ts`: once the import wrote through
 * `ContentCommandsService` (issue 70), index-rebuild importing it from there
 * closed an ES-module cycle (commands -> rebuild -> import -> commands), and
 * Nest then saw `ContentCommandsService` as `undefined` when it read the import
 * service's constructor types.
 */
import type { OkfImportItem } from '@echozedlabs/okf';

/**
 * Rebuild E3-shaped frontmatter from a recovered OKF item.
 *
 * The v0.2 trust/provenance families are consumed out of `extraFrontmatter` into
 * typed {@link OkfImportItem} fields on the way in, so they are re-injected here
 * (as normalized values) to survive the git-of-record round-trip. `status` here
 * is E3's publish flag; the OKF v0.2 lifecycle value is derived on export (see
 * the OKF v0.2 migration notes), so E3's product model does not persist a
 * distinct `deprecated` state today.
 */
export function toE3Frontmatter(item: OkfImportItem): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...item.extraFrontmatter, title: item.title };
  if (item.status) fm['status'] = item.status;
  if (item.tags.length > 0) fm['tags'] = item.tags;
  if (item.categories.length > 0) fm['categories'] = item.categories;
  if (item.groups.length > 0) fm['groups'] = item.groups;
  if (item.space) fm['topic'] = item.space; // E3 persists space association via frontmatter.topic
  // NOTE (2026-09-11, curated-categories work): an OKF `description` lands as
  // `summary` here, while the publish lint reads `description`. Left alone on
  // purpose: `e3FrontmatterOf` in index-rebuild.service.ts corrects it against
  // the file (a file that authored only `description` keeps `description`), and
  // every inbound door — the bundle import included, since issue 70 — maps
  // through that correction rather than through this function alone.
  //
  // Likewise there is no per-source DEFAULT CATEGORY to apply here: neither
  // `content_sources` nor `space_repos` has a `default_category` column (they
  // carry `default_status` only). Inventing one was out of scope; an imported
  // item with no `categories` therefore lands as a draft carrying
  // `category.missing`, which is the warn-mode behaviour the inbound doors want.
  if (item.description) fm['summary'] = item.description;
  // v0.2 families: preserved so a re-export stays a faithful v0.2 concept.
  if (item.generated) fm['generated'] = item.generated;
  if (item.verified && item.verified.length > 0) fm['verified'] = item.verified;
  if (item.sources && item.sources.length > 0) fm['sources'] = item.sources;
  if (item.usageWindow) fm['usage_window'] = item.usageWindow;
  if (item.staleAfter) fm['stale_after'] = item.staleAfter;
  return fm;
}
