import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('pages e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  it('creates and reads a page', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'My First Page', body: 'Hello world.', status: 'published' })
      .expect(201);
    expect(res.body.page.slug).toBe('my-first-page');
    expect(res.body.page.title).toBe('My First Page');
    expect(res.body.page.version_token).toBe(1);

    const id = res.body.page.id as string;
    const got = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(got.body.page.body_markdown).toContain('Hello world.');
    expect(got.headers['etag']).toBe('1');
  });

  it('returns 401 for unauthenticated page create', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .send({ title: 'X', body: 'x' })
      .expect(401);
  });

  it('rejects duplicate display titles within the default topic', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Same Title', body: 'one' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Same Title', body: 'two' })
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toContain('An item titled "Same Title" already exists in this topic');
      });
  });

  it('updates a page and bumps the version_token (optimistic concurrency happy path)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Doc', body: 'v1 body' })
      .expect(201);
    const id = created.body.page.id;
    const v1 = created.body.page.version_token;
    const upd = await request(app.getHttpServer())
      .put(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(v1))
      .send({ body: 'v2 body' })
      .expect(200);
    expect(upd.body.page.version_token).toBe(v1 + 1);
    expect(upd.body.page.body_markdown).toContain('v2 body');
  });

  it('returns 409 on stale If-Match (optimistic concurrency conflict)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Doc', body: 'v1' })
      .expect(201);
    const id = created.body.page.id;
    const stale = created.body.page.version_token;
    // Successful update first, bumping version_token
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(stale))
      .send({ body: 'v2' })
      .expect(200);
    // Now retry with the stale token — must 409
    const res = await request(app.getHttpServer())
      .put(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(stale))
      .send({ body: 'v3' })
      .expect(409);
    expect(res.body.message).toBeDefined();
  });

  it('rejects update without If-Match', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Doc', body: 'v1' });
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${created.body.page.id}`)
      .set('Cookie', cookie)
      .send({ body: 'v2' })
      .expect(400);
  });

  it('versions: every save makes a new page_versions row', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Versioned', body: 'v1' });
    const id = created.body.page.id;
    let token = created.body.page.version_token;

    for (let i = 2; i <= 4; i++) {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/pages/${id}`)
        .set('Cookie', cookie)
        .set('If-Match', String(token))
        .send({ body: `v${i}` })
        .expect(200);
      token = res.body.page.version_token;
    }
    const versions = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}/versions`)
      .set('Cookie', cookie)
      .expect(200);
    // Created: 1, then 3 updates: 4 versions total.
    expect(versions.body.versions.length).toBe(4);
  });

  it('soft-deletes a page and hides it from list', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Doomed', body: 'x', status: 'published' });
    await request(app.getHttpServer())
      .delete(`/api/v1/pages/${created.body.page.id}`)
      .set('Cookie', cookie)
      .expect(204);

    const list = await request(app.getHttpServer())
      .get('/api/v1/pages?status=published')
      .set('Cookie', cookie)
      .expect(200);
    const ids = list.body.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(created.body.page.id);
  });

  it('restores a soft-deleted page within the recovery window', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Recoverable', body: 'r' });
    await request(app.getHttpServer())
      .delete(`/api/v1/pages/${created.body.page.id}`)
      .set('Cookie', cookie)
      .expect(204);
    await request(app.getHttpServer())
      .post(`/api/v1/pages/${created.body.page.id}/restore`)
      .set('Cookie', cookie)
      .expect(201);
    const got = await request(app.getHttpServer())
      .get(`/api/v1/pages/${created.body.page.id}`)
      .set('Cookie', cookie);
    expect(got.body.page).not.toBeNull();
  });

  it('GET /pages/:id/versions/:vid returns raw_markdown for that prior version', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'PriorRaw', body: 'v1 body', status: 'draft' });
    const id = created.body.page.id;
    const v1 = created.body.page.version_token;

    await request(app.getHttpServer())
      .put(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(v1))
      .send({ body: 'v2 body' })
      .expect(200);

    const versionsRes = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}/versions`)
      .set('Cookie', cookie)
      .expect(200);
    const versions = versionsRes.body.versions as Array<{ id: string }>;
    // Newest first; the older version is the second entry.
    const olderId = versions[1]!.id;

    const olderRes = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}/versions/${olderId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(typeof olderRes.body.version.raw_markdown).toBe('string');
    expect(olderRes.body.version.raw_markdown).toContain('v1 body');
  });

  it('looks up page by exact title (wiki-link resolution helper)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Service Catalog', body: 'x', status: 'published' });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/pages/by-title/${encodeURIComponent('Service Catalog')}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.page.title).toBe('Service Catalog');
  });
});
