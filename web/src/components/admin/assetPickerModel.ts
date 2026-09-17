/**
 * AssetPicker model: which uploaded files can be a cover, and how the
 * "Choose from Files" search matches them.
 */

export interface AssetLike {
  id: string;
  file: string;
  url: string;
  mime: string;
  alt: string | null;
  original_filename: string | null;
  created_at: string;
}

/** Only raster/vector images can be a cover; Files also holds PDFs and archives. */
export function isImageAsset(asset: Pick<AssetLike, 'mime'>): boolean {
  return asset.mime.startsWith('image/');
}

/** The name a person recognises: the uploaded filename, else the alt text, else the stored name. */
export function assetDisplayName(asset: Pick<AssetLike, 'file' | 'alt' | 'original_filename'>): string {
  return asset.original_filename?.trim() || asset.alt?.trim() || asset.file;
}

/** Images only, newest first, matching the query against every name an asset has. */
export function filterAssets<T extends AssetLike>(assets: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return assets
    .filter(isImageAsset)
    .filter((a) => !needle || [a.file, a.alt ?? '', a.original_filename ?? '', a.url].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Mirrors the server's `assetUrl` (server/src/config/server-config.ts): a
 * root-relative path or an http(s) URL, no whitespace, no `..`. Anything else
 * the server silently drops, so the picker says so instead.
 */
export function isAcceptableAssetUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  if (!raw.startsWith('/') || raw.startsWith('//')) return false;
  return !raw.split('/').includes('..');
}
