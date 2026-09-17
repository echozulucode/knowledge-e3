import { describe, it, expect } from 'vitest';
import { resolveBundleLinks } from '../src/links.js';
import { validateBundle } from '../src/conformance.js';
import type { BundleFile, OkfBundle } from '../src/types.js';

function concept(path: string, frontmatter: string, body = 'Body.\n'): BundleFile {
  return { path, content: `---\n${frontmatter.trim()}\n---\n\n${body}` };
}

const CUSTOMERS = concept('concepts/customers.md', 'type: Concept\ntitle: Customers');

/** `[[Title]]` + a bundle-relative markdown link, both pointing at Customers. */
const ORDERS_DUAL = concept(
  'concepts/orders.md',
  'type: Concept\ntitle: Orders',
  'Joins [[Customers]] ([Customers](/concepts/customers.md)).\n',
);

describe('resolveBundleLinks', () => {
  it('resolves wiki-links by title and markdown links by path', () => {
    expect(resolveBundleLinks({ files: [CUSTOMERS, ORDERS_DUAL] })).toEqual([]);
  });

  it('resolves a wiki-link written against the concept filename', () => {
    const bundle: OkfBundle = {
      files: [CUSTOMERS, concept('concepts/o.md', 'type: Concept\ntitle: O', 'See [[customers]].\n')],
    };
    expect(resolveBundleLinks(bundle)).toEqual([]);
  });

  it('reports an unresolved wiki-link as a warning, with the target', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O', 'See [[Ghost Page]].\n')],
    };
    const [issue, ...rest] = resolveBundleLinks(bundle);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      path: 'concepts/o.md',
      code: 'link.unresolved',
      severity: 'warning',
      origin: 'wiki-link',
      target: 'Ghost Page',
    });
  });

  it('reports one issue per distinct target, however many times it is linked', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O', '[[Ghost]] and [[Ghost]] and [[ghost]].\n')],
    };
    expect(resolveBundleLinks(bundle)).toHaveLength(1);
  });

  it('reports a dangling bundle-relative markdown link', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O', 'See [x](/concepts/ghost.md).\n')],
    };
    expect(resolveBundleLinks(bundle)[0]).toMatchObject({
      origin: 'markdown-link',
      target: '/concepts/ghost.md',
      severity: 'warning',
    });
  });

  it.each([
    ['an absolute URL', '[x](https://example.com/a.md)'],
    ['a relative path', '[x](../other/a.md)'],
    ['a bare fragment', '[x](#section)'],
  ])('ignores %s — it resolves against something the bundle does not define', (_label, link) => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O', `See ${link}.\n`)],
    };
    expect(resolveBundleLinks(bundle)).toEqual([]);
  });

  it('matches a percent-escaped link against the file it names', () => {
    const bundle: OkfBundle = {
      files: [
        concept('concepts/my page.md', 'type: Concept\ntitle: My Page'),
        concept('concepts/o.md', 'type: Concept\ntitle: O', 'See [x](/concepts/my%20page.md#top).\n'),
      ],
    };
    expect(resolveBundleLinks(bundle)).toEqual([]);
  });

  it('checks bundle-relative path-valued frontmatter, and names the field', () => {
    const bundle: OkfBundle = {
      files: [
        concept(
          'computations/revenue.md',
          [
            'type: Attested Computation',
            'title: Revenue',
            'runtime: bigquery',
            'computation: /references/revenue.sql',
            'attester:',
            '  resource: /references/attest.py',
            'sources:',
            '  - resource: /concepts/customers.md',
            '  - resource: all queries in project X',
            '  - resource: https://example.com/spec',
          ].join('\n'),
          '# Computation\n\nSee the file.\n',
        ),
        CUSTOMERS,
        { path: 'references/revenue.sql', content: 'SELECT 1' },
      ],
    };
    const issues = resolveBundleLinks(bundle);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      field: 'attester.resource',
      origin: 'frontmatter',
      target: '/references/attest.py',
      severity: 'warning',
    });
  });

  it('resolves a frontmatter path against a binary asset', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O\nsources:\n  - resource: /assets/a.png')],
      assets: [{ path: 'assets/a.png', bytes: new Uint8Array([1]) }],
    };
    expect(resolveBundleLinks(bundle)).toEqual([]);
  });

  it('never scans the reserved generated files', () => {
    const bundle: OkfBundle = {
      files: [
        { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n* [Ghost](/concepts/ghost.md)\n' },
        { path: 'log.md', content: '# Log\n\nSee [[Ghost]].\n' },
      ],
    };
    expect(resolveBundleLinks(bundle)).toEqual([]);
  });
});

describe('validateBundle link reporting', () => {
  it('reports an unresolved link without making the bundle non-conformant', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/o.md', 'type: Concept\ntitle: O', 'See [[Elsewhere]].\n')],
    };
    const report = validateBundle(bundle);
    // A concept that references a concept in ANOTHER bundle is legitimate OKF.
    expect(report.conformant).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.links).toHaveLength(1);
    expect(report.links.every((l) => l.severity === 'warning')).toBe(true);
  });
});
