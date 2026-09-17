import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';

/**
 * `GET /pages` answers `total` as the number of matches, not the page length.
 *
 * It used to be `items.length`, so `?limit=2` over five matches said `total: 2`.
 * The Sections admin reads `total` as "Matches N items" and flags a section
 * matching nothing (the admin UX review §4.1), so the count has to
 * ignore `limit` while honouring every membership filter and the caller's
 * visibility.
 */
describe('GET /pages total', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);
  });

  afterEach(async () => app.close());

  async function createPage(title: string, opts: { tags?: string[]; status?: 'draft' | 'published'; type?: string } = {}) {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title,
        body: 'x',
        status: opts.status ?? 'published',
        tags: opts.tags ?? [],
        frontmatter: conformant({ type: opts.type ?? 'blog' }),
      })
      .expect(201);
  }

  it('counts every match, independent of limit', async () => {
    for (let i = 1; i <= 5; i += 1) await createPage(`Total Update ${i}`, { tags: ['total-update'] });
    await createPage('Total Other', { tags: ['total-other'] });

    const res = await request(app.getHttpServer())
      .get('/api/v1/pages?tags=total-update&status=published&limit=2')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it('applies the same filters and visibility as the items', async () => {
    await createPage('Visible Update', { tags: ['total-vis'] });
    await createPage('Draft Update', { tags: ['total-vis'], status: 'draft' });
    await createPage('Faq Update', { tags: ['total-vis'], type: 'faq' });

    const published = await request(app.getHttpServer())
      .get('/api/v1/pages?tags=total-vis&status=published&type=blog')
      .set('Cookie', cookie)
      .expect(200);
    expect(published.body.total).toBe(1);

    // An anonymous reader never counts a draft.
    const anon = await request(app.getHttpServer()).get('/api/v1/pages?tags=total-vis').expect(200);
    expect(anon.body.total).toBe(anon.body.items.length);
    expect(anon.body.items.map((i: { title: string }) => i.title)).not.toContain('Draft Update');

    // A filter nothing matches is zero, not an error.
    const none = await request(app.getHttpServer())
      .get('/api/v1/pages?tags=nobody-uses-this')
      .set('Cookie', cookie)
      .expect(200);
    expect(none.body).toMatchObject({ items: [], total: 0 });
  });
});
