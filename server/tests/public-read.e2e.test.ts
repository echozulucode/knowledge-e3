/**
 * Public read access e2e (Wave: configurable public reading).
 *
 * Default is `public`: anonymous visitors can read published content in public
 * Spaces, but not drafts or private-Space content. Writes/admin still require a
 * login, and an admin can require authentication for every read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

async function setReadMode(app: INestApplication, adminCookie: string, mode: 'public' | 'authenticated') {
  await request(app.getHttpServer())
    .put('/api/v1/admin/access')
    .set('Cookie', adminCookie)
    .send({ read_mode: mode })
    .expect(200);
}

describe('public read access e2e', () => {
  let app: INestApplication;
  let adminCookie: string;
  let aliceCookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie } = await seedAdminAndLogin(app));
    ({ cookie: aliceCookie } = await seedUserAndLogin(app, 'alice', 'alice-password-123'));
    await curateCategories(app);
  });
  afterEach(async () => app.close());

  describe('default (public)', () => {
    it('reports public mode and opens anonymous content reads', async () => {
      const access = await request(app.getHttpServer()).get('/api/v1/access').expect(200);
      expect(access.body.read_mode).toBe('public');

      // A published page exists.
      await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Visible Later', body: 'hi', status: 'published', frontmatter: conformant() })
        .expect(201);

      // Anonymous (no cookie) can use the public read surfaces.
      await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
      await request(app.getHttpServer()).get('/api/v1/items').expect(200);
      await request(app.getHttpServer()).get('/api/v1/topics').expect(200);
    });
  });

  describe('authenticated mode', () => {
    it('blocks anonymous reads when an administrator closes the instance', async () => {
      await setReadMode(app, adminCookie, 'authenticated');

      const access = await request(app.getHttpServer()).get('/api/v1/access').expect(200);
      expect(access.body.read_mode).toBe('authenticated');
      await request(app.getHttpServer()).get('/api/v1/pages').expect(401);
      await request(app.getHttpServer()).get('/api/v1/items').expect(401);
      await request(app.getHttpServer()).get('/api/v1/topics').expect(401);
    });
  });

  describe('admin toggle', () => {
    it('is admin-only and is reflected by GET /access', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/access')
        .set('Cookie', aliceCookie)
        .send({ read_mode: 'public' })
        .expect(403);

      await setReadMode(app, adminCookie, 'public');
      const access = await request(app.getHttpServer()).get('/api/v1/access').expect(200);
      expect(access.body.read_mode).toBe('public');
    });
  });

  describe('public mode', () => {
    let publishedId: string;
    let draftId: string;

    beforeEach(async () => {
      const pub = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Public Doc', body: 'everyone can read', status: 'published', frontmatter: conformant() })
        .expect(201);
      publishedId = pub.body.page.id;

      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Secret Draft', body: 'hidden', status: 'draft' })
        .expect(201);
      draftId = draft.body.page.id;

      await setReadMode(app, adminCookie, 'public');
    });

    it('lets anonymous visitors read published content but not drafts', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
      const ids = list.body.items.map((p: { id: string }) => p.id);
      expect(ids).toContain(publishedId);
      expect(ids).not.toContain(draftId);

      // Published page is readable by id; the draft resolves to null (hidden).
      const pub = await request(app.getHttpServer()).get(`/api/v1/pages/${publishedId}`).expect(200);
      expect(pub.body.page?.id).toBe(publishedId);
      const draft = await request(app.getHttpServer()).get(`/api/v1/pages/${draftId}`).expect(200);
      expect(draft.body.page).toBeNull();
    });

    it('does not hand an anonymous visitor the repository path or upstream URL of an item', async () => {
      // `source.role`/`mode` are claims about trust and drive the External /
      // Read-only badge, so they stay. `source.path` is an internal repository
      // path and `source.url` points into a repo that may be private; neither
      // belongs in a response to someone who has not signed in, and a reader
      // should not be offered a door they cannot open.
      for (const url of [`/api/v1/pages/${publishedId}`, `/api/v1/pages/by-slug/public-doc`]) {
        const res = await request(app.getHttpServer()).get(url).expect(200);
        const source = res.body.page?.source;
        if (!source) continue;
        expect(source.path ?? null).toBeNull();
        expect(source.url ?? null).toBeNull();
        expect(source.id).toBeTruthy();
      }

      const list = await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
      for (const item of list.body.items as { source?: { path?: unknown; url?: unknown } }[]) {
        expect(item.source?.path ?? null).toBeNull();
        expect(item.source?.url ?? null).toBeNull();
      }
    });

    it('opens the other public read surfaces (items, taxonomy, search)', async () => {
      await request(app.getHttpServer()).get('/api/v1/items').expect(200);
      await request(app.getHttpServer()).get('/api/v1/topics').expect(200);
      await request(app.getHttpServer()).get('/api/v1/taxonomy/tags').expect(200);
      await request(app.getHttpServer()).get('/api/v1/taxonomy/categories').expect(200);
      await request(app.getHttpServer()).get('/api/v1/search?q=public').expect(200);
    });

    it('still requires a login for writes', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/pages')
        .send({ title: 'Anon Write', body: 'no', status: 'published' })
        .expect(401);
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${publishedId}`)
        .set('If-Match', '1')
        .send({ body: 'hijack' })
        .expect(401);
    });

    it('keeps admin endpoints closed to anonymous visitors', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/users').expect(401);
    });
  });
});
