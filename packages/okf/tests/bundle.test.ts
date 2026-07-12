import { describe, it, expect } from 'vitest';
import { buildBundle } from '../src/bundle.js';
import { validateBundle } from '../src/conformance.js';
import type { PageInput } from '../src/types.js';

const pages: PageInput[] = [
  {
    id: 'itm_orders',
    slug: 'orders',
    title: 'Orders',
    status: 'published',
    tags: ['sales'],
    rawMarkdown: '---\ntitle: Orders\nsummary: One row per order.\n---\n\nJoined with [[Customers]] on customer id.\n',
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'itm_customers',
    slug: 'customers',
    title: 'Customers',
    status: 'published',
    tags: ['sales'],
    rawMarkdown: '---\ntitle: Customers\nsummary: One row per customer.\n---\n\nReferenced by orders.\n',
    updatedAt: '2026-06-02T00:00:00Z',
  },
];

describe('buildBundle', () => {
  it('emits one concept file per page plus a root index', () => {
    const bundle = buildBundle(pages);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(['concepts/customers.md', 'concepts/orders.md', 'index.md']);
  });

  it('declares the OKF version in the bundle-root index', () => {
    const bundle = buildBundle(pages, { okfVersion: '0.1' });
    const index = bundle.files.find((f) => f.path === 'index.md');
    expect(index?.content).toContain('okf_version: "0.1"');
    expect(index?.content).toContain('[Orders](/concepts/orders.md)');
    expect(index?.content).toContain('[Customers](/concepts/customers.md)');
  });

  it('resolves cross-links across the page set', () => {
    const bundle = buildBundle(pages, { linkStyle: 'markdown' });
    const orders = bundle.files.find((f) => f.path === 'concepts/orders.md');
    expect(orders?.content).toContain('[Customers](/concepts/customers.md)');
  });

  it('produces a conformant bundle', () => {
    const report = validateBundle(buildBundle(pages));
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(2);
    expect(report.issues).toHaveLength(0);
  });
});
