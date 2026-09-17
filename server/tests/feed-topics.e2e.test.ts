/**
 * List items carry their topic (home plan R3): `topic` (slug) and `topic_name`
 * on every entry the feed, Sections and series return, so an index surface can
 * label a row without a second request. Plus the `/feed` knobs a topic landing
 * page needs: `tags` (any-of, as on a Section) and `all_types=1`.
 *
 * The private-topic case is asserted from both sides: an anonymous visitor
 * receives neither the item nor the topic's name; a signed-in reader receives
 * both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('feed topics and tags e2e', () => {
  let app: INestApplication;
  let admin: string;
  let reader: string;

  const http = () => request(app.getHttpServer());
  const titles = (items: { title: string }[]) => items.map((i) => i.title);

  async function seed(title: string, fm: Record<string, unknown>, tags: string[] = []) {
    await http()
      .post('/api/v1/pages')
      .set('Cookie', admin)
      // Conformant, so every fixture passes the publish gate (issue 98).
      .send({ title, body: 'Words.', status: 'published', tags, frontmatter: conformant(fm) })
      .expect(201);
  }

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: admin } = await seedAdminAndLogin(app));
    ({ cookie: reader } = await seedUserAndLogin(app));
    await curateCategories(app);
    await http().post('/api/v1/topics').set('Cookie', admin).send({ name: 'Platform Team', slug: 'platform' }).expect(201);
    await http().post('/api/v1/topics').set('Cookie', admin).send({ name: 'Hidden Lab', slug: 'lab', visibility: 'private' }).expect(201);

    await seed('Platform Update', { type: 'Blog Post', authors: ['admin'], topic: 'platform', published_at: '2026-03-03T00:00:00.000Z', series: 'rollout', series_order: 1 }, ['update']);
    await seed('Platform Concept', { type: 'Concept', topic: 'platform', published_at: '2026-03-02T00:00:00.000Z' }, ['update']);
    await seed('Platform Untagged', { type: 'Blog Post', authors: ['admin'], topic: 'platform', published_at: '2026-03-01T00:00:00.000Z' });
    await seed('Lab Update', { type: 'Blog Post', authors: ['admin'], topic: 'lab', published_at: '2026-03-04T00:00:00.000Z', series: 'rollout', series_order: 2 }, ['update']);
  });
  afterEach(async () => app.close());

  it('fills topic and topic_name on feed entries', async () => {
    const res = await http().get('/api/v1/feed?topic=platform').expect(200);
    expect(res.body.items.map((i: { title: string; topic: string; topic_name: string }) => [i.title, i.topic, i.topic_name])).toEqual([
      ['Platform Update', 'platform', 'Platform Team'],
      ['Platform Untagged', 'platform', 'Platform Team'],
    ]);
  });

  it('filters by tags (any-of) inside a topic', async () => {
    const res = await http().get('/api/v1/feed?topic=platform&tags=update').expect(200);
    expect(titles(res.body.items)).toEqual(['Platform Update']);
    const either = await http().get('/api/v1/feed?topic=platform&tags=nothing,update').expect(200);
    expect(titles(either.body.items)).toEqual(['Platform Update']);
    const none = await http().get('/api/v1/feed?topic=platform&tags=nothing').expect(200);
    expect(titles(none.body.items)).toEqual([]);
  });

  it('all_types=1 lifts the default type restriction; explicit types still win', async () => {
    const all = await http().get('/api/v1/feed?topic=platform&tags=update&all_types=1').expect(200);
    expect(titles(all.body.items)).toEqual(['Platform Update', 'Platform Concept']);
    const everything = await http().get('/api/v1/feed?topic=platform&all_types=1').expect(200);
    expect(titles(everything.body.items)).toEqual(['Platform Update', 'Platform Concept', 'Platform Untagged']);
    const typed = await http().get('/api/v1/feed?topic=platform&all_types=1&types=Concept').expect(200);
    expect(titles(typed.body.items)).toEqual(['Platform Concept']);
  });

  it('never gives an anonymous visitor a private topic, by item or by name', async () => {
    const anon = await http().get('/api/v1/feed?tags=update&all_types=1').expect(200);
    expect(titles(anon.body.items)).toEqual(['Platform Update', 'Platform Concept']);
    expect(JSON.stringify(anon.body)).not.toContain('Hidden Lab');

    const signedIn = await http().get('/api/v1/feed?tags=update&all_types=1').set('Cookie', reader).expect(200);
    expect(signedIn.body.items[0]).toMatchObject({ title: 'Lab Update', topic: 'lab', topic_name: 'Hidden Lab' });
  });

  it('fills topics on series parts', async () => {
    const anon = await http().get('/api/v1/feed/series/rollout').expect(200);
    expect(anon.body.items.map((i: { topic_name: string }) => i.topic_name)).toEqual(['Platform Team']);
    const signedIn = await http().get('/api/v1/feed/series/rollout').set('Cookie', reader).expect(200);
    expect(signedIn.body.items.map((i: { topic: string }) => i.topic)).toEqual(['platform', 'lab']);
  });

  it('fills topics on cross-topic and topic Sections', async () => {
    await http()
      .put('/api/v1/sections')
      .set('Cookie', admin)
      .send({
        sections: [
          { slug: 'updates', name: 'Updates', tags: ['update'], order: 0 },
          { slug: 'platform-posts', name: 'Posts', space: 'platform', type: 'Blog Post', slot: 'latest' },
        ],
      })
      .expect(200);

    const cross = await http().get('/api/v1/sections/cross-topic').expect(200);
    const updates = cross.body.sections.find((s: { slug: string }) => s.slug === 'updates');
    expect(updates.items.map((i: { title: string; topic_name: string }) => [i.title, i.topic_name])).toEqual([
      ['Platform Update', 'Platform Team'],
      ['Platform Concept', 'Platform Team'],
    ]);

    const signedIn = await http().get('/api/v1/sections/cross-topic').set('Cookie', reader).expect(200);
    const signedInUpdates = signedIn.body.sections.find((s: { slug: string }) => s.slug === 'updates');
    expect(signedInUpdates.items[0]).toMatchObject({ title: 'Lab Update', topic: 'lab', topic_name: 'Hidden Lab' });

    const landing = await http().get('/api/v1/topics/platform/landing').expect(200);
    const posts = landing.body.topic.sections.find((s: { slug: string }) => s.slug === 'platform-posts');
    expect(posts.items.every((i: { topic: string; topic_name: string }) => i.topic === 'platform' && i.topic_name === 'Platform Team')).toBe(true);
  });
});
