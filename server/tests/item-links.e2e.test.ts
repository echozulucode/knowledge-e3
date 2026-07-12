import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('item links e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('indexes wiki-links and Markdown links into unified item_links for backlinks', async () => {
    const target = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Hub Page', body: 'Hub body.', status: 'published' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        title: 'Mixed Source',
        body: [
          'See [[Hub Page]] and [the hub](<Hub Page>).',
          '',
          '`[inline ignored](Hub Page)` and `[[Hub Page]]` are code.',
          '',
          '```md',
          '[fenced ignored](Hub Page)',
          '[[Hub Page]]',
          '```',
        ].join('\n'),
        status: 'published',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/pages/${target.body.item.id}/backlinks`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.backlinks).toHaveLength(2);
    expect(res.body.backlinks.map((b: { link_type: string }) => b.link_type).sort()).toEqual([
      'markdown',
      'wiki',
    ]);
    expect(res.body.backlinks.map((b: { link_text: string }) => b.link_text).sort()).toEqual([
      'Hub Page',
      'the hub',
    ]);
    expect(res.body.backlinks.every((b: { source_title: string }) => b.source_title === 'Mixed Source')).toBe(true);
  });

  it('supports backlinks lookup by item id, slug, and exact title', async () => {
    const target = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Lookup Hub', body: 'Hub body.', status: 'published' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Lookup Source', body: 'See [Lookup Hub](lookup-hub).', status: 'published' })
      .expect(201);

    for (const ref of [target.body.item.id, target.body.item.slug, target.body.item.title]) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/pages/${encodeURIComponent(ref)}/backlinks`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body.backlinks).toHaveLength(1);
      expect(res.body.backlinks[0]).toMatchObject({
        source_title: 'Lookup Source',
        link_type: 'markdown',
        link_text: 'Lookup Hub',
        target_ref: 'lookup-hub',
      });
    }
  });

  it('keeps id-backed suggested Markdown backlinks working after the target title is renamed', async () => {
    const target = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Stable Hub', body: 'Hub body.', status: 'published' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        title: 'Stable Source',
        body: `See [Stable Hub](<${target.body.item.id}>).`,
        status: 'published',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.body.item.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.body.item.version_token))
      .send({ new_title: 'Stable Hub Renamed', link_action: 'skip' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/pages/${target.body.item.id}/backlinks`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.backlinks).toHaveLength(1);
    expect(res.body.backlinks[0]).toMatchObject({
      source_title: 'Stable Source',
      link_type: 'markdown',
      link_text: 'Stable Hub',
      target_ref: target.body.item.id,
    });
    expect(res.body.backlinks[0].snippet).toContain('[Stable Hub]');
  });
});
