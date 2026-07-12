import { describe, it, expect } from 'vitest';
import { restoreWikiLinks, conceptToImport, parseBundleFiles } from '../src/import.js';
import { buildBundle } from '../src/bundle.js';
import type { LinkStyle, PageInput } from '../src/types.js';

describe('restoreWikiLinks', () => {
  it('collapses a dual link back to a wiki-link', () => {
    const out = restoreWikiLinks('See [[Customers]] ([Customers](/concepts/customers.md)) here.');
    expect(out).toBe('See [[Customers]] here.');
  });

  it('converts a bundle-relative markdown link to a wiki-link', () => {
    const out = restoreWikiLinks('See [Customers](/concepts/customers.md) here.');
    expect(out).toBe('See [[Customers]] here.');
  });

  it('leaves a preserved wiki-link unchanged', () => {
    const body = 'See [[Customers]] here.';
    expect(restoreWikiLinks(body)).toBe(body);
  });

  it('does not touch external (non-bundle) links', () => {
    const body = 'See [docs](https://example.com/x.md) here.';
    expect(restoreWikiLinks(body)).toBe(body);
  });

  it('converts relative concept links (no leading slash) to wiki-links', () => {
    expect(restoreWikiLinks('See [Concept Types](concept-types.md).')).toBe('See [[Concept Types]].');
    expect(restoreWikiLinks('See [Claude Research](../research-sources/claude.md).')).toBe(
      'See [[Claude Research]].',
    );
    // Anchored relative links collapse to the same wiki target.
    expect(restoreWikiLinks('See [Rules](rules.md#section).')).toBe('See [[Rules]].');
  });
});

describe('conceptToImport', () => {
  const concept = [
    '---',
    'type: Knowledge Page',
    'title: Orders',
    'description: One row per order.',
    'tags:',
    '  - sales',
    'timestamp: 2026-06-01T00:00:00Z',
    'e3_id: itm_orders',
    'e3_slug: orders',
    'e3_status: published',
    'e3_space: sales',
    'e3_categories:',
    '  - concept',
    'e3_groups:',
    '  - revenue',
    'e3_owner_id: usr_owner',
    'e3_created_at: 2026-05-01T00:00:00Z',
    'custom_key: keep-me',
    '---',
    '',
    'Joined with [[Customers]] ([Customers](/concepts/customers.md)) on id.',
    '',
  ].join('\n');

  it('recovers E3 identity and taxonomy from the e3_* keys', () => {
    const item = conceptToImport(concept);
    expect(item.e3Id).toBe('itm_orders');
    expect(item.title).toBe('Orders');
    expect(item.status).toBe('published');
    expect(item.space).toBe('sales');
    expect(item.tags).toEqual(['sales']);
    expect(item.categories).toEqual(['concept']);
    expect(item.groups).toEqual(['revenue']);
    expect(item.description).toBe('One row per order.');
    expect(item.slug).toBe('orders');
    expect(item.ownerId).toBe('usr_owner');
    // YAML parses an unquoted ISO datetime to a Date; import normalizes to ISO.
    expect(item.createdAt).toBe('2026-05-01T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('restores wiki-links in the body', () => {
    const item = conceptToImport(concept);
    expect(item.body).toContain('[[Customers]]');
    expect(item.body).not.toContain('/concepts/customers.md');
  });

  it('preserves unknown keys and drops OKF/e3 plumbing from extra frontmatter', () => {
    const item = conceptToImport(concept);
    expect(item.extraFrontmatter.custom_key).toBe('keep-me');
    expect(item.extraFrontmatter.type).toBeUndefined();
    expect(item.extraFrontmatter.e3_id).toBeUndefined();
    expect(item.extraFrontmatter.timestamp).toBeUndefined();
  });
});

describe('export → import round-trip', () => {
  const pages: PageInput[] = [
    {
      id: 'itm_orders',
      slug: 'orders',
      title: 'Orders',
      status: 'published',
      space: 'sales',
      tags: ['sales'],
      categories: ['concept'],
      groups: ['revenue'],
      rawMarkdown: '---\ntitle: Orders\nsummary: One row per order.\n---\n\nJoined with [[Customers]] on id.\n',
      updatedAt: '2026-06-01T00:00:00Z',
    },
    {
      id: 'itm_customers',
      slug: 'customers',
      title: 'Customers',
      status: 'published',
      space: 'sales',
      tags: ['sales'],
      categories: ['concept'],
      groups: ['revenue'],
      rawMarkdown: '---\ntitle: Customers\nsummary: One row per customer.\n---\n\nReferenced by orders.\n',
      updatedAt: '2026-06-02T00:00:00Z',
    },
  ];

  for (const style of ['preserve', 'markdown', 'dual'] as LinkStyle[]) {
    it(`recovers identity, taxonomy, and wiki-links (link style: ${style})`, () => {
      const bundle = buildBundle(pages, { linkStyle: style });
      const items = parseBundleFiles(bundle.files);
      expect(items).toHaveLength(2);

      const orders = items.find((i) => i.e3Id === 'itm_orders');
      expect(orders).toBeTruthy();
      expect(orders?.title).toBe('Orders');
      expect(orders?.status).toBe('published');
      expect(orders?.space).toBe('sales');
      expect(orders?.categories).toEqual(['concept']);
      expect(orders?.groups).toEqual(['revenue']);
      // The cross-reference is back to E3's canonical wiki-link form.
      expect(orders?.body).toContain('[[Customers]]');
      expect(orders?.body).not.toContain('/concepts/customers.md');
    });
  }
});
