/**
 * Blog feeds e2e (plan §3.3): the JSON feed with its filters (types, series,
 * author, homepage aging), the series and author routes, visibility through the
 * viewer, and the Atom documents generated from the same query.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';

describe('feed e2e', () => {
  let app: INestApplication;
  let cookie: string;

  // Every seeded item is a document that could be published: publishing is
  // gated from every interactive door, a published create included (issue 98).
  async function seed(body: Record<string, unknown>): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ body: 'Some words here.', status: 'published', ...body, frontmatter: conformant(body['frontmatter'] as Record<string, unknown>) })
      .expect(201);
    return res.body.page.id as string;
  }

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);

    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Secret Topic', visibility: 'private' })
      .expect(201);

    // Three Blog Posts (two in a series, one aged off the homepage), a Release
    // Note, a Concept, a draft, and a post in a private Topic.
    await seed({
      title: 'Second Step',
      frontmatter: { type: 'Blog Post', topic: 'Open Topic', authors: ['Ada Lovelace'], series: 'getting-started', series_order: 2, published_at: '2024-03-03T00:00:00.000Z', tags: ['intro'], description: 'Step two' },
    });
    await seed({
      title: 'First Step',
      frontmatter: { type: 'Blog Post', topic: 'Open Topic', author: 'Grace Hopper', series: 'getting-started', series_order: 1, published_at: '2024-03-01T00:00:00.000Z' },
    });
    await seed({
      title: 'Tips & Tricks',
      frontmatter: { type: 'Blog Post', authors: ['Ada Lovelace', 'Grace Hopper'], published_at: '2024-03-05T00:00:00.000Z', homepage_until: '2020-01-01T00:00:00.000Z', featured_until: '2999-01-01T00:00:00.000Z' },
    });
    await seed({ title: 'v1.2 Released', frontmatter: { type: 'Release Note', published_at: '2024-03-04T00:00:00.000Z' } });
    await seed({ title: 'Idempotency', frontmatter: { type: 'Concept', published_at: '2024-03-02T00:00:00.000Z' } });
    await seed({ title: 'Unfinished', status: 'draft', frontmatter: { type: 'Blog Post' } });
    await seed({ title: 'Secret Post', frontmatter: { type: 'Blog Post', topic: 'Secret Topic', author: 'Secret Author', published_at: '2024-03-06T00:00:00.000Z' } });
  });
  afterEach(async () => app.close());

  const titles = (res: request.Response) => res.body.items.map((i: { title: string }) => i.title);

  it('lists Blog Posts and Release Notes by default, newest publish date first', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/feed').expect(200);
    expect(titles(res)).toEqual(['Tips & Tricks', 'v1.2 Released', 'Second Step', 'First Step']);
    expect(res.body.total).toBe(4);
    expect(res.body.next_cursor).toBeNull();

    const featured = res.body.items.map((i: { title: string; featured: boolean }) => [i.title, i.featured]);
    expect(featured).toContainEqual(['Tips & Tricks', true]);
    expect(featured).toContainEqual(['Second Step', false]);
    const second = res.body.items.find((i: { title: string }) => i.title === 'Second Step');
    expect(second).toMatchObject({ authors: ['Ada Lovelace'], series: 'getting-started', series_order: 2, reading_time_minutes: 1, description: 'Step two' });
  });

  it('pages with an offset cursor', async () => {
    const first = await request(app.getHttpServer()).get('/api/v1/feed?limit=3').expect(200);
    expect(titles(first)).toEqual(['Tips & Tricks', 'v1.2 Released', 'Second Step']);
    expect(first.body.next_cursor).toBe('3');
    const rest = await request(app.getHttpServer()).get(`/api/v1/feed?limit=3&cursor=${first.body.next_cursor}`).expect(200);
    expect(titles(rest)).toEqual(['First Step']);
  });

  it('filters by one or several types', async () => {
    const one = await request(app.getHttpServer()).get('/api/v1/feed?types=Concept').expect(200);
    expect(titles(one)).toEqual(['Idempotency']);
    const two = await request(app.getHttpServer()).get('/api/v1/feed?types=Blog%20Post,Concept').expect(200);
    expect(titles(two)).toEqual(['Tips & Tricks', 'Second Step', 'Idempotency', 'First Step']);
  });

  it('orders a series by series_order', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/feed/series/getting-started').expect(200);
    expect(res.body.series).toBe('getting-started');
    expect(titles(res)).toEqual(['First Step', 'Second Step']);
    const viaQuery = await request(app.getHttpServer()).get('/api/v1/feed?series=getting-started').expect(200);
    expect(titles(viaQuery)).toEqual(['First Step', 'Second Step']);
  });

  it('matches authors case-insensitively from `authors` or `author`', async () => {
    const grace = await request(app.getHttpServer()).get('/api/v1/feed/authors/grace%20hopper').expect(200);
    expect(titles(grace)).toEqual(['Tips & Tricks', 'First Step']);
    const ada = await request(app.getHttpServer()).get('/api/v1/feed?author=ADA%20LOVELACE').expect(200);
    expect(titles(ada)).toEqual(['Tips & Tricks', 'Second Step']);
  });

  it('drops entries past homepage_until only when homepage=1', async () => {
    const home = await request(app.getHttpServer()).get('/api/v1/feed?homepage=1').expect(200);
    expect(titles(home)).toEqual(['v1.2 Released', 'Second Step', 'First Step']);
    const all = await request(app.getHttpServer()).get('/api/v1/feed').expect(200);
    expect(titles(all)).toContain('Tips & Tricks');
  });

  it('hides private-Topic items from anonymous visitors but not from signed-in users', async () => {
    const anon = await request(app.getHttpServer()).get('/api/v1/feed').expect(200);
    expect(titles(anon)).not.toContain('Secret Post');
    const admin = await request(app.getHttpServer()).get('/api/v1/feed').set('Cookie', cookie).expect(200);
    expect(titles(admin)[0]).toBe('Secret Post');
    // Drafts never appear, even for their owner.
    expect(titles(admin)).not.toContain('Unfinished');
  });

  it('serves the site-wide Atom feed', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/feeds/latest.atom').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/atom\+xml/);
    const xml = res.text;
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    expect(xml.match(/<entry>/g)).toHaveLength(4);
    expect(xml).toContain('<id>urn:e3:feed:latest</id>');
    expect(xml).toMatch(/<id>urn:e3:item:[A-Za-z0-9_-]+<\/id>/);
    expect(xml).toContain('<title>Tips &amp; Tricks</title>');
    expect(xml).toContain('<author><name>Ada Lovelace</name></author>');
    expect(xml).toContain('<category term="intro"/>');
    expect(xml).toContain('<summary>Step two</summary>');
    expect(xml).toContain('<published>2024-03-05T00:00:00.000Z</published>');
    expect(xml).toMatch(/<link rel="alternate" type="text\/html" href="\/p\/second-step"\/>/);
    expect(xml).not.toContain('Secret Post');
  });

  it('serves a per-Topic Atom feed and 404s for a Topic the viewer cannot see', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/feeds/topics/open-topic.atom').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/atom\+xml/);
    expect(res.text.match(/<entry>/g)).toHaveLength(2);
    expect(res.text).toContain('<id>urn:e3:feed:topic:open-topic</id>');

    await request(app.getHttpServer()).get('/api/v1/feeds/topics/secret-topic.atom').expect(404);
    await request(app.getHttpServer()).get('/api/v1/feeds/topics/no-such-topic.atom').expect(404);
    const admin = await request(app.getHttpServer()).get('/api/v1/feeds/topics/secret-topic.atom').set('Cookie', cookie).expect(200);
    expect(admin.text.match(/<entry>/g)).toHaveLength(1);
  });
});
