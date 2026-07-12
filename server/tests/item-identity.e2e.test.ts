import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('item identity contract e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('keeps immutable item id canonical across DTOs, update, get, search, and backlinks', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        title: 'Identity Anchor',
        body: 'Stable reconciliation key body.',
        status: 'published',
        tags: ['identity'],
      })
      .expect(201);

    expect(created.body.item).toMatchObject({
      id: expect.any(String),
      slug: 'identity-anchor',
      title: 'Identity Anchor',
      status: 'published',
    });
    const id = created.body.item.id as string;
    const originalSlug = created.body.item.slug as string;

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        title: 'Identity Source',
        body: `Reference by immutable id [anchor](${id}) and old display link [[Identity Anchor]].`,
        status: 'published',
      })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ title: 'Renamed Identity Anchor', body: 'Stable reconciliation key body with a new display title.' })
      .expect(200);

    expect(updated.body.item).toMatchObject({
      id,
      slug: originalSlug,
      title: 'Renamed Identity Anchor',
      status: 'published',
    });

    const gotById = await request(app.getHttpServer())
      .get(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gotById.body.item).toMatchObject({ id, slug: originalSlug, title: 'Renamed Identity Anchor' });

    const searchByNewTitle = await request(app.getHttpServer())
      .get('/api/v1/search?q=Renamed&include_drafts=1')
      .set('Cookie', cookie)
      .expect(200);
    expect(searchByNewTitle.body.results[0]).toMatchObject({
      id,
      slug: originalSlug,
      title: 'Renamed Identity Anchor',
    });

    const listByOldSlug = await request(app.getHttpServer())
      .get(`/api/v1/items?q=${encodeURIComponent(originalSlug)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(listByOldSlug.body.items.map((item: { id: string }) => item.id)).toContain(id);

    const backlinks = await request(app.getHttpServer())
      .get(`/api/v1/pages/${id}/backlinks`)
      .set('Cookie', cookie)
      .expect(200);
    expect(backlinks.body.backlinks).toEqual([
      expect.objectContaining({
        source_item_id: expect.any(String),
        source_item_title: 'Identity Source',
        source_item_slug: 'identity-source',
        source_page_id: expect.any(String),
        source_title: 'Identity Source',
        source_slug: 'identity-source',
        link_type: 'markdown',
        link_text: 'anchor',
        target_ref: id,
      }),
    ]);
  });
});
