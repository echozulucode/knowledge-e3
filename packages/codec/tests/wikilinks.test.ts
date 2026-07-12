/**
 * Wiki-link extraction and AST-aware rewrite.
 * Covers the acceptance tests from v0.1-spec.md §6.5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parse,
  serializeWithBody,
  extractWikiLinks,
  extractItemLinks,
  rewriteWikiLinks,
} from '../src/index.js';
import { rewriteWikiLinksInDocument } from '../src/wikilinks.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function fix(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

describe('extractItemLinks', () => {
  it('finds wiki-links and Markdown links while ignoring code', () => {
    const raw = [
      '---',
      'title: Links',
      'status: draft',
      '---',
      '',
      'See [[Hub Page]] and [the hub](<Hub Page>).',
      '',
      '`[inline ignored](Hub Page)` and `[[Hub Page]]` are code.',
      '',
      '```md',
      '[fenced ignored](Hub Page)',
      '[[Hub Page]]',
      '```',
    ].join('\n');
    const parsed = parse(raw);
    const links = extractItemLinks(parsed);
    expect(links.map((l) => ({ type: l.type, target: l.target, text: l.text }))).toEqual([
      { type: 'wiki', target: 'Hub Page', text: 'Hub Page' },
      { type: 'markdown', target: 'Hub Page', text: 'the hub' },
    ]);
  });
});

describe('extractWikiLinks', () => {
  it('finds wiki-links in plain prose', () => {
    const raw = fix('15-wiki-links.md');
    const parsed = parse(raw);
    const links = extractWikiLinks(parsed);
    const targets = links.map((l) => l.target).sort();
    expect(targets).toEqual(
      ['On-Call Rotations', 'Other Page', 'Payment Retry Policy', 'Service Catalog', 'Yet Another Page'].sort(),
    );
  });

  it('does NOT detect wiki-links inside fenced code blocks', () => {
    const raw = fix('19-mixed-everything.md');
    const parsed = parse(raw);
    const links = extractWikiLinks(parsed);
    const targets = links.map((l) => l.target);
    expect(targets).toContain('Wiki Link');
    expect(targets).toContain('Page Link');
    expect(targets).toContain('Quoted Wiki Link');
    // The string `Not A Real Link` appears inside a fenced code block — must NOT be detected.
    expect(targets).not.toContain('Not A Real Link');
  });

  it('returns empty when there are no wiki-links', () => {
    const raw = fix('06-fenced-code.md');
    const parsed = parse(raw);
    expect(extractWikiLinks(parsed)).toEqual([]);
  });

  it('records byte offsets that point at the [[ delimiter', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\n\nA [[Foo]] here.\n';
    const parsed = parse(raw);
    const links = extractWikiLinks(parsed);
    expect(links).toHaveLength(1);
    const occ = links[0]!;
    expect(parsed.body.slice(occ.start, occ.end)).toBe('[[Foo]]');
    expect(occ.target).toBe('Foo');
  });
});

describe('rewriteWikiLinks (acceptance tests from spec §6.5)', () => {
  it('AT-1: rename a page with 0 inbound links is a no-op rewrite', () => {
    const raw = fix('15-wiki-links.md');
    const parsed = parse(raw);
    const result = rewriteWikiLinks(parsed, 'Nonexistent Title', 'New Title');
    expect(result.count).toBe(0);
    expect(result.body).toBe(parsed.body);
  });

  it('AT-2: rewrites all matching wiki-link tokens atomically', () => {
    const raw = fix('15-wiki-links.md');
    const parsed = parse(raw);
    const result = rewriteWikiLinks(parsed, 'Other Page', 'Other Page Renamed');
    expect(result.count).toBe(1);
    expect(result.body).toContain('[[Other Page Renamed]]');
    // No other wiki-links should have changed.
    expect(result.body).toContain('[[Yet Another Page]]');
    expect(result.body).toContain('[[Payment Retry Policy]]');
  });

  it('AT-3: code-block content with the same title is NOT rewritten', () => {
    // Fixture 19 contains "Not A Real Link" inside a fenced code block.
    const raw = fix('19-mixed-everything.md');
    const parsed = parse(raw);
    const result = rewriteWikiLinks(parsed, 'Not A Real Link', 'Definitely Real');
    // Zero rewrites — the string is in a code block and is correctly skipped.
    expect(result.count).toBe(0);
    expect(result.body).toBe(parsed.body);
    // The literal text inside the code block is unchanged:
    expect(result.body).toContain('"[[Not A Real Link]]"');
  });

  it('AT-3 (positive): a real wiki-link in prose IS rewritten while code is untouched', () => {
    const raw = fix('19-mixed-everything.md');
    const parsed = parse(raw);
    const result = rewriteWikiLinks(parsed, 'Wiki Link', 'Wiki Link 2');
    expect(result.count).toBe(1);
    expect(result.body).toContain('[[Wiki Link 2]]');
    // The code block content is preserved verbatim:
    expect(result.body).toContain('"[[Not A Real Link]]"');
  });

  it('AT-5 (skip path): caller may serialise without applying rewrites', () => {
    // The "skip" path is just: don't call rewriteWikiLinks. Serializing the parsed
    // page with serialize() returns raw; broken-link surfaces remain.
    const raw = fix('15-wiki-links.md');
    const parsed = parse(raw);
    expect(parsed.raw).toBe(raw);
  });
});

describe('rewriteWikiLinksInDocument (raw-document convenience)', () => {
  it('returns a new raw document with rewrites spliced in', () => {
    const raw = fix('15-wiki-links.md');
    const result = rewriteWikiLinksInDocument(raw, 'Other Page', 'Other Page Renamed');
    expect(result.count).toBe(1);
    expect(result.raw).toContain('[[Other Page Renamed]]');
    // Frontmatter block is preserved verbatim:
    expect(result.raw.startsWith(raw.slice(0, raw.indexOf('\n---\n') + 5))).toBe(true);
  });

  it('returns the original raw when no occurrences match', () => {
    const raw = fix('15-wiki-links.md');
    const result = rewriteWikiLinksInDocument(raw, 'Nope', 'Nada');
    expect(result.count).toBe(0);
    expect(result.raw).toBe(raw);
  });

  it('handles multiple occurrences of the same target', () => {
    const raw =
      '---\ntitle: T\nstatus: draft\n---\n\nA [[Foo]] then [[Foo]] then [[Bar]].\n';
    const result = rewriteWikiLinksInDocument(raw, 'Foo', 'Quux');
    expect(result.count).toBe(2);
    expect(result.raw).toContain('A [[Quux]] then [[Quux]] then [[Bar]].');
  });
});

describe('serializeWithBody', () => {
  it('joins original frontmatter with new body', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\n\nOriginal body.\n';
    const parsed = parse(raw);
    const out = serializeWithBody(parsed, '\nNew body content.\n');
    expect(out).toBe('---\ntitle: T\nstatus: draft\n---\n\nNew body content.\n');
  });

  it('preserves byte-stable output when newBody equals parsed.body', () => {
    const raw = '---\ntitle: T\nstatus: draft\n---\n\nUnchanged.\n';
    const parsed = parse(raw);
    expect(serializeWithBody(parsed, parsed.body)).toBe(raw);
  });
});
