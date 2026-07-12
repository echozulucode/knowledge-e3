import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('topics e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('creates a default topic on startup and lets clients list/create topics', async () => {
    const initial = await request(app.getHttpServer())
      .get('/api/v1/topics')
      .set('Cookie', cookie)
      .expect(200);

    expect(initial.body.topics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'default', name: 'Default' }),
      ]),
    );

    const created = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ slug: 'engineering', name: 'Engineering', description: 'Engineering knowledge' })
      .expect(201);

    expect(created.body.topic).toMatchObject({
      slug: 'engineering',
      name: 'Engineering',
      description: 'Engineering knowledge',
      archived_at: null,
    });

    const listed = await request(app.getHttpServer())
      .get('/api/v1/topics')
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.body.topics.map((topic: { slug: string }) => topic.slug)).toEqual([
      'default',
      'engineering',
    ]);
  });

  it('assigns newly-created items/pages to the default topic transitionally', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Default Topic Item', body: 'body' })
      .expect(201);

    expect(created.body.item.space_id).toBe('space_default');

    const gotPage = await request(app.getHttpServer())
      .get(`/api/v1/pages/${created.body.item.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gotPage.body.page.space_id).toBe('space_default');
  });

  it('lists topic item counts, supports rename, and archives unused topics', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ slug: 'admin-topic', name: 'Admin Topic', description: 'Before rename' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Counted Admin Topic Item', body: 'body', frontmatter: { topic: 'Admin Topic' } })
      .expect(201);

    const counted = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    expect(counted.body.topics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.body.topic.id,
          slug: 'admin-topic',
          name: 'Admin Topic',
          counts: expect.objectContaining({ items: 1, draft: 1, published: 0 }),
        }),
      ]),
    );

    const renamed = await request(app.getHttpServer())
      .put(`/api/v1/topics/${created.body.topic.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed Admin Topic', description: 'After rename' })
      .expect(200);
    expect(renamed.body.topic).toMatchObject({ slug: 'admin-topic', name: 'Renamed Admin Topic', description: 'After rename' });

    const blockedArchive = await request(app.getHttpServer())
      .delete(`/api/v1/topics/${created.body.topic.id}`)
      .set('Cookie', cookie)
      .expect(409);
    expect(blockedArchive.body.message).toContain('topic has assigned items');

    const unused = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ slug: 'unused-topic', name: 'Unused Topic' })
      .expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/topics/${unused.body.topic.id}`).set('Cookie', cookie).expect(200);

    const afterArchive = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    expect(afterArchive.body.topics.map((topic: { slug: string }) => topic.slug)).not.toContain('unused-topic');
  });
});
