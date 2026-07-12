import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';
import { OkfExportService } from '../src/okf/okf-export.service.js';

/**
 * Sections = OKF `type` × space. The `type` is a first-class, filterable field so
 * a "section" (blogs, FAQs, best practices…) can be listed and exported on its own,
 * while still producing standard OKF where `type` is the required concept kind.
 */
describe('OKF sections (type) e2e', () => {
  let app: INestApplication;
  let items: ItemsService;
  let exporter: OkfExportService;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    items = app.get(ItemsService);
    exporter = app.get(OkfExportService);
  });

  afterEach(async () => app.close());

  it('persists type, filters by it, and exports a single section', async () => {
    const blog = await items.create(adminId, {
      title: 'Launch Notes',
      body: 'A blog post.',
      status: 'published',
      frontmatter: { type: 'blog' },
    });
    const faq = await items.create(adminId, {
      title: 'Billing FAQ',
      body: 'A frequently asked question.',
      status: 'published',
      frontmatter: { type: 'faq' },
    });

    // Type is first-class on the item view. The derived `type` column
    // canonicalizes known kinds to their registry label (`faq` → `FAQ`), while
    // unknown kinds pass through verbatim (`blog` stays `blog`). The stored
    // frontmatter/file is left exactly as authored (asserted below).
    expect(blog.type).toBe('blog');
    expect(faq.type).toBe('FAQ');

    // Listing by type returns only that section. The filter is canonicalized the
    // same way, so a lowercase `faq` request still matches the `FAQ` column.
    const blogs = await items.list({ type: 'blog' });
    expect(blogs.map((i) => i.id)).toEqual([blog.id]);
    const faqs = await items.list({ type: 'faq' });
    expect(faqs.map((i) => i.id)).toEqual([faq.id]);

    // Exporting by type yields a bundle of just that section, and every concept
    // carries the type as its required OKF field.
    const result = await exporter.export({ id: adminId, role: 'admin' }, { type: 'faq' });
    expect(result.item_count).toBe(1);
    expect(result.conformance.conformant).toBe(true);
    const concept = result.bundle.files.find((f) => f.path.startsWith('concepts/'));
    expect(concept?.content).toMatch(/^---\ntype: faq/);
    expect(concept?.content).toContain(`e3_id: ${faq.id}`);
  });
});
