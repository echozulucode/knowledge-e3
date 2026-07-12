/**
 * Authz cluster e2e — covers issues.yaml#38, #39, #44.
 *
 *   #38: drafts are visible only to admins or the page author.
 *   #39: taxonomy write endpoints are admin-only.
 *   #44: page rename requires page ownership or admin role.
 *
 * All three issues come from the 2026-05-25 code review and are gated on
 * v0.2 multi-user enablement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('authz cluster e2e (#38, #39, #44)', () => {
  let app: INestApplication;
  let adminCookie: string;
  let aliceCookie: string;
  let aliceId: string;
  let bobCookie: string;
  let bobId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie } = await seedAdminAndLogin(app));
    ({ cookie: aliceCookie, userId: aliceId } = await seedUserAndLogin(app, 'alice'));
    ({ cookie: bobCookie, userId: bobId } = await seedUserAndLogin(app, 'bob'));
  });
  afterEach(async () => app.close());

  describe('#38 draft visibility on pages/items REST', () => {
    it('hides another users draft from a non-admin /pages list and /pages/:id read', async () => {
      // Alice creates a draft.
      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Aliasing Draft', body: 'secret', status: 'draft' })
        .expect(201);
      const draftId = draft.body.page.id;

      // Bob (non-admin, non-owner) cannot see it in list responses.
      const bobList = await request(app.getHttpServer())
        .get('/api/v1/pages')
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobList.body.items.map((p: { id: string }) => p.id)).not.toContain(draftId);

      // Bob hitting the detail endpoint gets `page: null` (treated as 404 by callers).
      const bobGet = await request(app.getHttpServer())
        .get(`/api/v1/pages/${draftId}`)
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobGet.body.page).toBeNull();

      // Bob's slug/title lookups are also blocked.
      const bobBySlug = await request(app.getHttpServer())
        .get('/api/v1/pages/by-slug/aliasing-draft')
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobBySlug.body.page).toBeNull();
      const bobByTitle = await request(app.getHttpServer())
        .get('/api/v1/pages/by-title/Aliasing%20Draft')
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobByTitle.body.page).toBeNull();
    });

    it('lets the draft author see their own draft', async () => {
      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Draft', body: 'mine', status: 'draft' })
        .expect(201);
      const draftId = draft.body.page.id;

      const list = await request(app.getHttpServer())
        .get('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .expect(200);
      expect(list.body.items.map((p: { id: string }) => p.id)).toContain(draftId);

      const got = await request(app.getHttpServer())
        .get(`/api/v1/pages/${draftId}`)
        .set('Cookie', aliceCookie)
        .expect(200);
      expect(got.body.page?.id).toBe(draftId);
    });

    it('lets an admin see everyones drafts', async () => {
      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Draft 2', body: 'mine', status: 'draft' })
        .expect(201);
      const draftId = draft.body.page.id;

      const adminList = await request(app.getHttpServer())
        .get('/api/v1/pages?status=draft')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(adminList.body.items.map((p: { id: string }) => p.id)).toContain(draftId);
    });

    it('hides drafts from non-owners via /items list and /items/:id read', async () => {
      const draft = await request(app.getHttpServer())
        .post('/api/v1/items')
        .set('Cookie', aliceCookie)
        .send({ title: 'Item Draft', body: 'secret', status: 'draft' })
        .expect(201);
      const draftId = draft.body.item.id;

      const bobList = await request(app.getHttpServer())
        .get('/api/v1/items')
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobList.body.items.map((i: { id: string }) => i.id)).not.toContain(draftId);

      const bobGet = await request(app.getHttpServer())
        .get(`/api/v1/items/${draftId}`)
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobGet.body.item).toBeNull();
    });

    it('still surfaces published pages to everyone', async () => {
      const pub = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Published', body: 'all may see', status: 'published' })
        .expect(201);
      const pubId = pub.body.page.id;

      const bobList = await request(app.getHttpServer())
        .get('/api/v1/pages')
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobList.body.items.map((p: { id: string }) => p.id)).toContain(pubId);

      const bobGet = await request(app.getHttpServer())
        .get(`/api/v1/pages/${pubId}`)
        .set('Cookie', bobCookie)
        .expect(200);
      expect(bobGet.body.page?.id).toBe(pubId);
    });
  });

  describe('#39 taxonomy admin gating', () => {
    it('returns 403 for non-admin POST/PUT/DELETE on topics/categories/groups/spaces', async () => {
      // Non-admin create topic.
      await request(app.getHttpServer())
        .post('/api/v1/topics')
        .set('Cookie', aliceCookie)
        .send({ name: 'Forbidden Topic' })
        .expect(403);

      // Non-admin create space (treated the same).
      await request(app.getHttpServer())
        .post('/api/v1/spaces')
        .set('Cookie', aliceCookie)
        .send({ name: 'Forbidden Space' })
        .expect(403);

      // Non-admin create category.
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/categories')
        .set('Cookie', aliceCookie)
        .send({ name: 'Forbidden Category' })
        .expect(403);

      // Non-admin create group.
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/groups')
        .set('Cookie', aliceCookie)
        .send({ name: 'Forbidden Group' })
        .expect(403);

      // For PUT/DELETE we need a target — admin creates one first.
      const topic = await request(app.getHttpServer())
        .post('/api/v1/topics')
        .set('Cookie', adminCookie)
        .send({ name: 'Admin Topic' })
        .expect(201);
      const topicId = topic.body.topic.id;

      await request(app.getHttpServer())
        .put(`/api/v1/topics/${topicId}`)
        .set('Cookie', aliceCookie)
        .send({ name: 'Hijacked Name' })
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/api/v1/topics/${topicId}`)
        .set('Cookie', aliceCookie)
        .expect(403);

      const cat = await request(app.getHttpServer())
        .post('/api/v1/taxonomy/categories')
        .set('Cookie', adminCookie)
        .send({ name: 'Admin Cat' })
        .expect(201);
      const catSlug = cat.body.category.slug;

      await request(app.getHttpServer())
        .put(`/api/v1/taxonomy/categories/${catSlug}`)
        .set('Cookie', aliceCookie)
        .send({ name: 'Hijacked Cat' })
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/api/v1/taxonomy/categories/${catSlug}`)
        .set('Cookie', aliceCookie)
        .expect(403);
    });

    it('allows admin to perform the same writes', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/topics')
        .set('Cookie', adminCookie)
        .send({ name: 'Allowed Topic' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/categories')
        .set('Cookie', adminCookie)
        .send({ name: 'Allowed Cat' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/groups')
        .set('Cookie', adminCookie)
        .send({ name: 'Allowed Grp' })
        .expect(201);
    });

    it('keeps taxonomy reads open to all signed-in users', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/topics')
        .set('Cookie', aliceCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/taxonomy/tags')
        .set('Cookie', aliceCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/taxonomy/categories')
        .set('Cookie', aliceCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/taxonomy/groups')
        .set('Cookie', aliceCookie)
        .expect(200);
    });
  });

  describe('#44 page rename ownership check', () => {
    it('returns 403 when user B renames user As page', async () => {
      const page = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Doc', body: 'hi', status: 'published' })
        .expect(201);
      const id = page.body.page.id;
      const token = page.body.version_token;

      await request(app.getHttpServer())
        .post(`/api/v1/pages/${id}/rename`)
        .set('Cookie', bobCookie)
        .set('If-Match', String(token))
        .send({ new_title: 'Hijacked', link_action: 'skip' })
        .expect(403);

      // Confirm the title was not changed.
      const after = await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(after.body.page.title).toBe('Alice Doc');
    });

    it('allows the owner to rename their own page', async () => {
      const page = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Owns This', body: 'hi', status: 'published' })
        .expect(201);
      const id = page.body.page.id;
      const token = page.body.version_token;

      await request(app.getHttpServer())
        .post(`/api/v1/pages/${id}/rename`)
        .set('Cookie', aliceCookie)
        .set('If-Match', String(token))
        .send({ new_title: 'Alice Renamed It', link_action: 'skip' })
        .expect(201);
    });

    it('allows an admin to rename anyones page', async () => {
      const page = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Page To Admin Rename', body: 'hi', status: 'published' })
        .expect(201);
      const id = page.body.page.id;
      const token = page.body.version_token;

      await request(app.getHttpServer())
        .post(`/api/v1/pages/${id}/rename`)
        .set('Cookie', adminCookie)
        .set('If-Match', String(token))
        .send({ new_title: 'Admin Renamed It', link_action: 'skip' })
        .expect(201);
    });

    it('rejects non-numeric expected_affected_versions entries with 400', async () => {
      const page = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Bad Versions Payload', body: 'x', status: 'published' })
        .expect(201);
      const id = page.body.page.id;
      const token = page.body.version_token;

      await request(app.getHttpServer())
        .post(`/api/v1/pages/${id}/rename`)
        .set('Cookie', aliceCookie)
        .set('If-Match', String(token))
        .send({
          new_title: 'Bad Versions Payload Renamed',
          link_action: 'update_all',
          expected_affected_versions: { 'page_x': 'not-a-number' },
        })
        .expect(400);
    });
  });

  describe('P0-1 page/item mutation ownership (update/delete/restore)', () => {
    async function aliceePublishedPage(title: string) {
      const page = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title, body: 'hi', status: 'published' })
        .expect(201);
      return { id: page.body.page.id as string, token: page.body.version_token as number };
    }

    it('returns 403 when user B updates user As page', async () => {
      const { id, token } = await aliceePublishedPage('Alice Update Target');
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${id}`)
        .set('Cookie', bobCookie)
        .set('If-Match', String(token))
        .send({ body: 'hijacked body' })
        .expect(403);

      // Body unchanged.
      const after = await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(after.body.page.body_markdown).toContain('hi');
    });

    it('returns 403 when user B deletes user As page, and the page survives', async () => {
      const { id } = await aliceePublishedPage('Alice Delete Target');
      await request(app.getHttpServer())
        .delete(`/api/v1/pages/${id}`)
        .set('Cookie', bobCookie)
        .expect(403);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}`)
        .set('Cookie', aliceCookie)
        .expect(200);
      expect(after.body.page?.id).toBe(id);
    });

    it('returns 403 when user B restores user As deleted page', async () => {
      const { id } = await aliceePublishedPage('Alice Restore Target');
      await request(app.getHttpServer())
        .delete(`/api/v1/pages/${id}`)
        .set('Cookie', aliceCookie)
        .expect(204);

      await request(app.getHttpServer())
        .post(`/api/v1/pages/${id}/restore`)
        .set('Cookie', bobCookie)
        .expect(403);
    });

    it('lets the owner update, and an admin update/delete anyones page', async () => {
      const { id, token } = await aliceePublishedPage('Alice Self Update');
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${id}`)
        .set('Cookie', aliceCookie)
        .set('If-Match', String(token))
        .send({ body: 'owner edit' })
        .expect(200);

      const { id: id2, token: token2 } = await aliceePublishedPage('Admin Override Target');
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${id2}`)
        .set('Cookie', adminCookie)
        .set('If-Match', String(token2))
        .send({ body: 'admin edit' })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/v1/pages/${id2}`)
        .set('Cookie', adminCookie)
        .expect(204);
    });

    it('returns 403 when user B updates user As item', async () => {
      const item = await request(app.getHttpServer())
        .post('/api/v1/items')
        .set('Cookie', aliceCookie)
        .send({ title: 'Alice Item Update Target', body: 'hi', status: 'published' })
        .expect(201);
      const id = item.body.item.id;
      const token = item.body.version_token;
      await request(app.getHttpServer())
        .put(`/api/v1/items/${id}`)
        .set('Cookie', bobCookie)
        .set('If-Match', String(token))
        .send({ body: 'hijacked' })
        .expect(403);
    });
  });

  describe('P1-2 version-history visibility', () => {
    it('hides a draft page’s version history from a non-owner', async () => {
      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', aliceCookie)
        .send({ title: 'Versioned Draft', body: 'v1', status: 'draft' })
        .expect(201);
      const id = draft.body.page.id;

      // Owner can list versions.
      const ownerVersions = await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}/versions`)
        .set('Cookie', aliceCookie)
        .expect(200);
      expect(ownerVersions.body.versions.length).toBeGreaterThan(0);
      const vid = ownerVersions.body.versions[0].id;

      // Non-owner is 404'd on both list and detail.
      await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}/versions`)
        .set('Cookie', bobCookie)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}/versions/${vid}`)
        .set('Cookie', bobCookie)
        .expect(404);
    });
  });

  // Silence unused-var lints in case future refactors drop direct ids.
  void aliceId;
  void bobId;
});
