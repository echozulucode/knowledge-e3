import { describe, it, expect } from 'vitest';
import { createTar, createTarGz, extractTar, extractTarGz } from '../src/okf/tar.js';

describe('tar (ustar) writer/reader', () => {
  it('round-trips text and binary files through gzip', () => {
    const bin = Buffer.from([0, 1, 2, 255, 254, 0, 128, 0]);
    const files = [
      { path: 'concepts/hello.md', content: '# Hello\n\nBody with ünïcode.' },
      { path: 'assets/a1b2.png', content: bin },
      { path: 'assets/a1b2.png.meta.json', content: '{"file":"a1b2.png"}' },
    ];
    const out = extractTarGz(createTarGz(files));
    const byPath = new Map(out.map((e) => [e.path, e.bytes]));
    expect(byPath.get('concepts/hello.md')!.toString('utf8')).toBe('# Hello\n\nBody with ünïcode.');
    expect(byPath.get('assets/a1b2.png')!.equals(bin)).toBe(true);
    expect(byPath.get('assets/a1b2.png.meta.json')!.toString('utf8')).toBe('{"file":"a1b2.png"}');
  });

  it('round-trips a long path via the ustar name/prefix split', () => {
    const longDir = 'assets/' + 'd'.repeat(120);
    const files = [{ path: `${longDir}/x.png`, content: Buffer.from([7, 8, 9]) }];
    const out = extractTar(createTar(files));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe(`${longDir}/x.png`);
    expect(out[0]!.bytes.equals(Buffer.from([7, 8, 9]))).toBe(true);
  });

  it('stops cleanly at the end-of-archive marker even with zero-filled data', () => {
    // A body that is itself all-zero must not be mistaken for the terminator.
    const out = extractTar(createTar([{ path: 'z.bin', content: Buffer.alloc(600, 0) }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.bytes.length).toBe(600);
  });
});
