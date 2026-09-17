/**
 * Series landing e2e (home plan R2.11): `GET /feed/series/:slug` carries the
 * published Series item whose slug the series names, alongside the parts. The
 * Series item is read as the viewer — a private topic's Series item is not a
 * landing page for an anonymous visitor, and a draft is not one for anybody.
 * (The humanised-slug fallback when there is no Series item is the web's.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';

describe('series landing e2e', () => {
  let app: INestApplication;
  let cookie: string;

  /**
   * A published item that passes the publish gate: conformant frontmatter, and
   * a Blog Post additionally carries `published_at` and an author. The test's
   * own frontmatter keys win.
   */
  async function seed(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    const own = (body['frontmatter'] ?? {}) as Record<string, unknown>;
    const blog = own['type'] === 'Blog Post' ? { published_at: '2026-09-01T00:00:00.000Z', authors: ['admin'] } : {};
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ body: 'Some words here.', status: 'published', ...body, frontmatter: conformant({ ...blog, ...own }) })
      .expect(201);
    return { id: res.body.page.id as string, slug: res.body.page.slug as string };
  }

  /**
   * Legacy content with no `description` cannot pass the publish gate, so it is
   * saved as a draft and published over its diagnostics by an admin — the
   * audited escape hatch that exists for exactly this kind of content.
   */
  async function seedLegacy(title: string, frontmatter: Record<string, unknown>): Promise<void> {
    const { description: _omitted, ...rest } = conformant(frontmatter);
    const draft = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body: 'Some words here.', status: 'draft', frontmatter: rest })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${draft.body.page.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(draft.body.version_token))
      .send({ status: 'published', frontmatter: { ...draft.body.page.frontmatter, status: 'published' }, allow_lint_errors: true })
      .expect(200);
  }

  const titles = (res: request.Response) => res.body.items.map((i: { title: string }) => i.title);

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Secret Topic', visibility: 'private' })
      .expect(201);
  });
  afterEach(async () => app.close());

  it('returns the Series item title, description, cover and cover alt with the parts in series_order', async () => {
    const landing = await seed({
      title: 'Getting Started',
      frontmatter: {
        type: 'Series',
        topic: 'Open Topic',
        description: 'Three steps from nothing to a working hub.',
        cover: '/assets/getting-started.png',
        cover_alt: 'A path of stepping stones',
      },
    });
    expect(landing.slug).toBe('getting-started');
    await seed({ title: 'Part Two', frontmatter: { type: 'Blog Post', topic: 'Open Topic', series: 'getting-started', series_order: 2 } });
    await seed({ title: 'Part One', frontmatter: { type: 'Blog Post', topic: 'Open Topic', series: 'getting-started', series_order: 1 } });

    const res = await request(app.getHttpServer()).get('/api/v1/feed/series/getting-started').expect(200);
    // Existing shape is unchanged: `series` is still the slug.
    expect(res.body.series).toBe('getting-started');
    expect(titles(res)).toEqual(['Part One', 'Part Two']);
    expect(res.body.series_item).toMatchObject({
      id: landing.id,
      slug: 'getting-started',
      title: 'Getting Started',
      description: 'Three steps from nothing to a working hub.',
      cover: '/assets/getting-started.png',
      cover_alt: 'A path of stepping stones',
    });
    // The Series item names the series; it is not one of its parts.
    expect(titles(res)).not.toContain('Getting Started');
  });

  it('falls back to `summary` for the description and leaves cover fields null when unset', async () => {
    await seedLegacy('Plain Series', { type: 'Series', summary: 'Only a summary.' });
    const res = await request(app.getHttpServer()).get('/api/v1/feed/series/plain-series').expect(200);
    expect(res.body.series_item).toMatchObject({ title: 'Plain Series', description: 'Only a summary.', cover: null, cover_alt: null });
  });

  it('is null when no item has the slug, or the item with it is not a Series', async () => {
    await seed({ title: 'Lonely Part', frontmatter: { type: 'Blog Post', series: 'no-landing', series_order: 1 } });
    const none = await request(app.getHttpServer()).get('/api/v1/feed/series/no-landing').expect(200);
    expect(none.body.series_item).toBeNull();
    expect(titles(none)).toEqual(['Lonely Part']);

    await seed({ title: 'Not A Series', frontmatter: { type: 'Blog Post' } });
    const wrongType = await request(app.getHttpServer()).get('/api/v1/feed/series/not-a-series').expect(200);
    expect(wrongType.body.series_item).toBeNull();
  });

  it('hides a private topic\'s Series item from anonymous visitors but not from signed-in users', async () => {
    await seed({ title: 'Hidden Series', frontmatter: { type: 'Series', topic: 'Secret Topic', description: 'Private.' } });
    await seed({ title: 'Hidden Part', frontmatter: { type: 'Blog Post', topic: 'Secret Topic', series: 'hidden-series', series_order: 1 } });

    const anon = await request(app.getHttpServer()).get('/api/v1/feed/series/hidden-series').expect(200);
    expect(anon.body.series_item).toBeNull();
    expect(titles(anon)).toEqual([]);

    const admin = await request(app.getHttpServer()).get('/api/v1/feed/series/hidden-series').set('Cookie', cookie).expect(200);
    expect(admin.body.series_item).toMatchObject({ title: 'Hidden Series', description: 'Private.' });
    expect(titles(admin)).toEqual(['Hidden Part']);
  });

  it('excludes a draft Series item, even for its author', async () => {
    await seed({ title: 'Draft Series', status: 'draft', frontmatter: { type: 'Series', description: 'Not yet.' } });
    await seed({ title: 'Published Part', frontmatter: { type: 'Blog Post', series: 'draft-series', series_order: 1 } });

    const admin = await request(app.getHttpServer()).get('/api/v1/feed/series/draft-series').set('Cookie', cookie).expect(200);
    expect(admin.body.series_item).toBeNull();
    expect(titles(admin)).toEqual(['Published Part']);
    const anon = await request(app.getHttpServer()).get('/api/v1/feed/series/draft-series').expect(200);
    expect(anon.body.series_item).toBeNull();
  });
});
