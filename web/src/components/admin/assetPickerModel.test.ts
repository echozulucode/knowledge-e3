import { describe, expect, it } from 'vitest';
import { assetDisplayName, filterAssets, isAcceptableAssetUrl, isImageAsset, type AssetLike } from './assetPickerModel.js';

const asset = (over: Partial<AssetLike>): AssetLike => ({
  id: 'a',
  file: 'abc123.png',
  url: '/assets/abc123.png',
  mime: 'image/png',
  alt: null,
  original_filename: null,
  created_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('asset picker', () => {
  it('offers images only, newest first', () => {
    const list = [
      asset({ id: 'old', created_at: '2026-01-01T00:00:00.000Z' }),
      asset({ id: 'pdf', mime: 'application/pdf', file: 'doc.pdf' }),
      asset({ id: 'new', created_at: '2026-09-10T00:00:00.000Z', mime: 'image/svg+xml' }),
    ];
    expect(isImageAsset({ mime: 'image/webp' })).toBe(true);
    expect(filterAssets(list, '').map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('searches the uploaded filename, alt text and stored name', () => {
    const list = [
      asset({ id: 'ops', original_filename: 'Operations-Cover.png' }),
      asset({ id: 'alt', alt: 'Architecture diagram', file: 'f00.png' }),
      asset({ id: 'plain', file: 'deadbeef.jpg', url: '/assets/deadbeef.jpg' }),
    ];
    expect(filterAssets(list, 'cover').map((a) => a.id)).toEqual(['ops']);
    expect(filterAssets(list, 'ARCHITECTURE').map((a) => a.id)).toEqual(['alt']);
    expect(filterAssets(list, 'deadbeef').map((a) => a.id)).toEqual(['plain']);
  });

  it('names an asset the way a person would recognise it', () => {
    expect(assetDisplayName(asset({ original_filename: 'cover.png', alt: 'x' }))).toBe('cover.png');
    expect(assetDisplayName(asset({ alt: 'Team photo' }))).toBe('Team photo');
    expect(assetDisplayName(asset({}))).toBe('abc123.png');
  });

  it('accepts only the URLs the server keeps', () => {
    expect(isAcceptableAssetUrl('/assets/a.png')).toBe(true);
    expect(isAcceptableAssetUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isAcceptableAssetUrl('//evil.example/a.png')).toBe(false);
    expect(isAcceptableAssetUrl('assets/a.png')).toBe(false);
    expect(isAcceptableAssetUrl('/assets/../secret')).toBe(false);
    expect(isAcceptableAssetUrl('/assets/a b.png')).toBe(false);
    expect(isAcceptableAssetUrl('')).toBe(false);
  });
});
