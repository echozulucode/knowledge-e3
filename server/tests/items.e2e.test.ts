import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('items e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('creates, lists, gets, and updates items through item-named DTOs while pages remain available', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw_markdown: '---\ntitle: Item Runbook\nstatus: draft\ntags:\n  - ops\n---\nInitial body',
      })
      .expect(201);

    expect(created.body.item).toMatchObject({
      slug: 'item-runbook',
      title: 'Item Runbook',
      status: 'draft',
      body_markdown: 'Initial body',
      tags: ['ops'],
    });
    expect(created.body.item.raw_markdown).toContain('title: Item Runbook');
    expect(created.body.item.frontmatter.title).toBe('Item Runbook');
    expect(created.body.version_token).toBe(created.body.item.version_token);

    const id = created.body.item.id as string;
    const listed = await request(app.getHttpServer())
      .get('/api/v1/items?tag=ops')
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(id);
    expect(listed.body.total).toBeGreaterThanOrEqual(1);

    const gotItem = await request(app.getHttpServer())
      .get(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gotItem.body.item.id).toBe(id);
    expect(gotItem.headers['etag']).toBe('1');

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ raw_markdown: '---\ntitle: Item Runbook Updated\nstatus: published\ntags:\n  - ops\n  - mvp\n---\nUpdated body' })
      .expect(200);
    expect(updated.body.item).toMatchObject({
      id,
      title: 'Item Runbook Updated',
      status: 'published',
      body_markdown: 'Updated body',
      tags: ['ops', 'mvp'],
    });
    expect(updated.body.item.version_token).toBe(2);

    const gotPage = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gotPage.body.page.title).toBe('Item Runbook Updated');
  });

  it('keeps item id canonical while display title and first heading can change independently', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Canonical Item', raw_markdown: '# Convenience Heading\n\nInitial body' })
      .expect(201);

    const id = created.body.item.id as string;
    const slug = created.body.item.slug as string;
    expect(created.body.item).toMatchObject({
      id,
      slug,
      title: 'Canonical Item',
      body_markdown: '# Convenience Heading\n\nInitial body',
    });

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ title: 'Mutable Display Title', raw_markdown: '# Edited Convenience Heading\n\nUpdated body' })
      .expect(200);

    expect(updated.body.item).toMatchObject({
      id,
      slug,
      title: 'Mutable Display Title',
      body_markdown: '# Edited Convenience Heading\n\nUpdated body',
    });

    const gotById = await request(app.getHttpServer())
      .get(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gotById.body.item).toMatchObject({ id, slug, title: 'Mutable Display Title' });
  });

  it('preserves a leading H1 body heading when only item title metadata changes', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Imported Title', raw_markdown: '# Imported Title\n\nImported body' })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ title: 'Metadata Title Changed', raw_markdown: created.body.item.raw_markdown })
      .expect(200);

    expect(updated.body.item.title).toBe('Metadata Title Changed');
    expect(updated.body.item.body_markdown).toContain('# Imported Title\n\nImported body');
    expect(updated.body.item.body_markdown).not.toContain('# Metadata Title Changed');
  });

  it('rejects duplicate item display titles within the default topic with a clear error', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Duplicate Title', body: 'one' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Duplicate Title', body: 'two' })
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toContain('An item titled "Duplicate Title" already exists in this topic');
      });
  });

  it('rejects invalid taxonomy frontmatter with clear server-authoritative validation errors', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ raw_markdown: '---\ntitle: Invalid Taxonomy\ncategories: platform\n---\nBody' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('invalid taxonomy: categories must be a list of strings');
      });

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Valid Before Bad Update', body: 'safe body' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ raw_markdown: '---\ntitle: Valid Before Bad Update\ngroups:\n  - ok\n  - 42\n---\nUnsaved server should reject this.' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('invalid taxonomy: groups must be a list of strings');
      });

    const afterRejectedUpdate = await request(app.getHttpServer())
      .get(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(afterRejectedUpdate.body.item.body_markdown).toContain('safe body');
    expect(afterRejectedUpdate.body.item.version_token).toBe(created.body.item.version_token);
  });

  it('rejects updates that would duplicate another item title in the default topic', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Existing Title', body: 'one' })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Other Title', body: 'two' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ title: 'Existing Title' })
      .expect(409)
      .expect(({ body }) => {
        expect(body.message).toContain('An item titled "Existing Title" already exists in this topic');
      });
  });

  it('persists status and taxonomy metadata updates across item, list, and search boundaries', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw_markdown: '---\ntitle: Metadata Boundary Runbook\ntopic: Product\nstatus: published\ntags: [alpha]\ncategories: [ops]\ngroups: [launch]\n---\nOriginal metadata boundary needle.',
      })
      .expect(201);

    expect(created.body.item).toMatchObject({
      title: 'Metadata Boundary Runbook',
      status: 'published',
      tags: ['alpha'],
      categories: ['ops'],
      groups: ['launch'],
    });
    expect(created.body.item.frontmatter.topic).toBe('Product');

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({
        raw_markdown: '---\ntitle: Metadata Boundary Runbook\ntopic: Research Lab\nstatus: draft\ntags: [beta, regression]\ncategories: [research]\ngroups: [review]\n---\nUpdated metadata boundary needle.',
      })
      .expect(200);

    expect(updated.body.item).toMatchObject({
      id: created.body.item.id,
      slug: 'metadata-boundary-runbook',
      title: 'Metadata Boundary Runbook',
      status: 'draft',
      tags: ['beta', 'regression'],
      categories: ['research'],
      groups: ['review'],
      body_markdown: 'Updated metadata boundary needle.',
    });
    expect(updated.body.item.frontmatter.topic).toBe('Research Lab');

    const got = await request(app.getHttpServer())
      .get(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(got.body.item).toMatchObject(updated.body.item);

    const listedByNewTag = await request(app.getHttpServer())
      .get('/api/v1/items?tag=regression')
      .set('Cookie', cookie)
      .expect(200);
    expect(listedByNewTag.body.items.map((item: { id: string }) => item.id)).toContain(created.body.item.id);

    const listedByOldTag = await request(app.getHttpServer())
      .get('/api/v1/items?tag=alpha')
      .set('Cookie', cookie)
      .expect(200);
    expect(listedByOldTag.body.items.map((item: { id: string }) => item.id)).not.toContain(created.body.item.id);

    const publishedSearch = await request(app.getHttpServer())
      .get('/api/v1/search?q=metadata%20boundary&status=published')
      .set('Cookie', cookie)
      .expect(200);
    expect(publishedSearch.body.results.map((item: { id: string }) => item.id)).not.toContain(created.body.item.id);

    const draftSearch = await request(app.getHttpServer())
      .get('/api/v1/search?q=metadata%20boundary&status=draft&include_drafts=1&space=research-lab&tag=regression&category=research&group=review')
      .set('Cookie', cookie)
      .expect(200);
    const hit = draftSearch.body.results.find((item: { id: string }) => item.id === created.body.item.id);
    expect(hit).toMatchObject({
      title: 'Metadata Boundary Runbook',
      status: 'draft',
      topic: 'Research Lab',
      tags: ['beta', 'regression'],
      categories: ['research'],
      groups: ['review'],
      path: `/items/${created.body.item.id}`,
      url: '/p/metadata-boundary-runbook',
    });
  });

  it('returns item:null for missing ids and rejects item updates without If-Match', async () => {
    await request(app.getHttpServer()).get('/api/v1/items/missing').set('Cookie', cookie).expect(200).expect(({ body }) => {
      expect(body.item).toBeNull();
    });

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Needs Match', body: 'v1' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .send({ body: 'v2' })
      .expect(400);
  });
});
