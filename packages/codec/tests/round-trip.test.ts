/**
 * Kill-criterion gate from v0.1-spec.md §12.
 *
 * For every fixture in tests/fixtures, parse → serialize must produce
 * a byte-identical result. The aggregate pass rate must be ≥80% to gate
 * further editor work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { roundTrip, parse, serialize } from '../src/codec.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadFixtures(): { name: string; raw: string }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({
      name,
      raw: readFileSync(join(FIXTURES_DIR, name), 'utf8'),
    }));
}

describe('Markdown round-trip — kill-criterion corpus', () => {
  const fixtures = loadFixtures();

  it('has at least 20 fixtures (per spec §12)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  for (const { name, raw } of fixtures) {
    it(`fixture ${name} round-trips byte-identically`, () => {
      const out = roundTrip(raw);
      // Hard assertion: byte-identical.
      expect(out).toBe(raw);
    });
  }

  it('aggregate pass rate is ≥80% (kill-criterion gate)', () => {
    let pass = 0;
    for (const { raw } of fixtures) {
      if (roundTrip(raw) === raw) pass++;
    }
    const rate = pass / fixtures.length;
    // Log for visibility:
    // eslint-disable-next-line no-console
    console.log(`Round-trip pass rate: ${pass}/${fixtures.length} = ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });
});

describe('parse / serialize semantics', () => {
  it('parse + serialize is the identity on a no-op edit', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\n\nHello.\n';
    const parsed = parse(raw);
    expect(serialize(parsed)).toBe(raw);
  });

  it('handles document with no frontmatter', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.\n';
    const parsed = parse(raw);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({});
    expect(serialize(parsed)).toBe(raw);
  });

  it('extracts known frontmatter fields', () => {
    const raw =
      '---\ntitle: My Page\nstatus: published\ntags: [a, b]\n---\n\nBody.\n';
    const parsed = parse(raw);
    expect(parsed.frontmatter.title).toBe('My Page');
    expect(parsed.frontmatter.status).toBe('published');
    expect(parsed.frontmatter.tags).toEqual(['a', 'b']);
  });

  it('preserves unknown frontmatter keys (forward compatibility)', () => {
    const raw =
      '---\ntitle: T\nstatus: draft\nclassification: internal\nfuture_v02_field: 42\n---\n\nBody.\n';
    const parsed = parse(raw);
    expect(parsed.frontmatter['classification']).toBe('internal');
    expect(parsed.frontmatter['future_v02_field']).toBe(42);
    // Round-trip must preserve them too.
    expect(serialize(parsed)).toBe(raw);
  });

  it('recovers from invalid YAML in frontmatter (no crash)', () => {
    const raw = '---\nthis: is: not: valid: yaml\n---\n\nBody preserved.\n';
    expect(() => parse(raw)).not.toThrow();
    const parsed = parse(raw);
    expect(parsed.frontmatter).toEqual({});
    // Raw still round-trips byte-identically:
    expect(serialize(parsed)).toBe(raw);
  });

  it('parses frontmatter behind a UTF-8 BOM and still round-trips byte-identically (P3-1)', () => {
    const raw = '﻿---\ntitle: BOM Doc\nstatus: draft\n---\n\nBody.\n';
    const parsed = parse(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.title).toBe('BOM Doc');
    expect(parsed.frontmatter.status).toBe('draft');
    // The BOM is preserved on round-trip.
    expect(serialize(parsed)).toBe(raw);
  });

  it('round-trips a BOM doc through the surgical-edit (serializeWithBody) path', async () => {
    const { serializeWithBody } = await import('../src/codec.js');
    const raw = '﻿---\ntitle: BOM Doc\n---\n\nOld body.\n';
    const parsed = parse(raw);
    // Re-emitting the original body must reproduce the original bytes, BOM included.
    expect(serializeWithBody(parsed, parsed.body)).toBe(raw);
  });

  it('strips prototype-polluting keys from frontmatter (P3-2)', () => {
    const raw = '---\ntitle: Safe\n__proto__:\n  polluted: true\nconstructor: nope\n---\n\nBody.\n';
    const parsed = parse(raw);
    // The dangerous keys never become own properties...
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'constructor')).toBe(false);
    // ...and Object.prototype is not polluted.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    // Benign keys survive.
    expect(parsed.frontmatter.title).toBe('Safe');
  });
});
