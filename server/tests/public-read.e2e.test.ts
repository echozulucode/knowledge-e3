/**
 * Public read access e2e (Wave: configurable public reading).
 *
 * Default is `authenticated` (login required to view). An admin can switch the
 * instance to `public`, after which anonymous visitors can read PUBLISHED
 * content but not drafts, and writes/admin still require a login.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

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
  });
  afterEach(async () => app.close());

  describe('default (authenticated)', () => {
    it('reports authenticated mode and blocks anonymous reads', async () => {
      const access = await request(app.getHttpServer()).get('/api/v1/access').expect(200);
      expect(access.body.read_mode).toBe('authenticated');

      // A published page exists.
      await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Visible Later', body: 'hi', status: 'published' })
        .expect(201);

      // Anonymous (no cookie) is rejected on content reads.
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
        .send({ title: 'Public Doc', body: 'everyone can read', status: 'published' })
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
