import { describe, it, expect } from 'vitest';
import { parseBundleAssets } from '../src/import.js';

describe('parseBundleAssets', () => {
  it('pairs asset bytes with their descriptor sidecar', () => {
    const files = [
      { path: 'concepts/x.md', content: '# X' },
      {
        path: 'assets/a1b2.png.meta.json',
        content: JSON.stringify({ file: 'a1b2.png', mime: 'image/png', alt: 'A' }),
      },
    ];
    const assets = [{ path: 'assets/a1b2.png', bytes: new Uint8Array([1, 2, 3]) }];
    const out = parseBundleAssets(files, assets);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe('a1b2.png');
    expect(Array.from(out[0]!.bytes)).toEqual([1, 2, 3]);
    expect(out[0]!.descriptor?.['mime']).toBe('image/png');
  });

  it('returns bytes without a descriptor when the sidecar is absent or malformed', () => {
    const out = parseBundleAssets(
      [{ path: 'assets/p.pdf.meta.json', content: '{ not json' }],
      [{ path: 'assets/p.pdf', bytes: new Uint8Array([9]) }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.descriptor).toBeUndefined();
  });

  it('ignores nested paths, non-asset entries, and a sidecar posing as its own asset', () => {
    const out = parseBundleAssets(
      [],
      [
        { path: 'assets/sub/deep.png', bytes: new Uint8Array([1]) }, // nested — skip
        { path: 'assets/a.png.meta.json', bytes: new Uint8Array([2]) }, // sidecar — not an asset
        { path: 'concepts/x.md', bytes: new Uint8Array([3]) }, // not under assets/
        { path: 'assets/a.png', bytes: new Uint8Array([4]) }, // the only real asset
      ],
    );
    expect(out.map((a) => a.file)).toEqual(['a.png']);
  });
});
