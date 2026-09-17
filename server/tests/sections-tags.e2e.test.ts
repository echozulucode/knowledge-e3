/**
 * A Section's tag filter — the mechanism behind "custom news and updates" on the
 * front page. A curator names the tags a section draws from; membership is
 * any-of within `tags` and all-of across `type`/`space`/`tags`.
 *
 * Tags are emergent in this product (`tag.unknown` is only a warning), so the
 * sharp case is a section naming a tag nobody has used: it must resolve to an
 * empty section, never an error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { CONFORMANT_YAML, FIXTURE_CATEGORY, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';

/**
 * The publish-time frontmatter for a raw fixture that already names its `type`
 * (issue 98): a description, a curated category, and the author a published
 * Blog Post needs (an FAQ tolerates it).
 */
const PUBLISHABLE = `description: A test fixture.\ncategories: [${FIXTURE_CATEGORY}]\nauthors: [admin]\n`;

describe('Section tag filter', () => {
  let app: INestApplication;
  let cookie: string;
  let admin: Viewer;
  let query: KnowledgeQueryService;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    admin = { userId: login.userId, role: 'admin' };
    query = app.get(KnowledgeQueryService);
    await curateCategories(app);
  });
  afterEach(async () => app.close());

  function createRaw(raw: string) {
    return request(app.getHttpServer()).post('/api/v1/items').set('Cookie', cookie).send({ raw }).expect(201);
  }

  function putSections(sections: unknown[]) {
    return request(app.getHttpServer()).put('/api/v1/sections').set('Cookie', cookie).send({ sections });
  }

  function titles(items: { title: string }[] | undefined) {
    return (items ?? []).map((i) => i.title);
  }

  describe('config validation', () => {
    it('round-trips tags, normalizes them, and drops an empty list', async () => {
      const res = await putSections([
        { name: 'News', type: 'blog-post', space: 'default', tags: [' release ', 'news', 'news', ''] },
        // An empty list means "do not filter by tag", the way a blank type does —
        // it must not be stored as a filter that matches nothing.
        { name: 'Everything', tags: [] },
      ]).expect(200);

      const [everything, news] = res.body.sections as { slug: string; tags?: string[] }[];
      expect(news).toEqual({ slug: 'news', name: 'News', type: 'blog-post', space: 'default', tags: ['news', 'release'] });
      expect(everything).toEqual({ slug: 'everything', name: 'Everything' });
      expect(everything.tags).toBeUndefined();
    });

    it('rejects tags that are not a list of strings, storing nothing', async () => {
      await putSections([{ name: 'Bad', tags: 'news' }]).expect(400);
      await putSections([{ name: 'Bad', tags: ['news', 7] }]).expect(400);
      const got = await request(app.getHttpServer()).get('/api/v1/sections').set('Cookie', cookie).expect(200);
      expect(got.body.sections).toEqual([]);
    });
  });

  describe('resolving members', () => {
    it('resolves any-of tags, newest first, and ANDs with type and space', async () => {
      await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
        .send({ name: 'Main', slug: 'main', presentation: 'portal' }).expect(201);
      await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
        .send({ name: 'Elsewhere', slug: 'elsewhere' }).expect(201);

      const post = (title: string, fm: string) =>
        createRaw(`---\ntitle: ${title}\nstatus: published\n${PUBLISHABLE}${fm}---\nBody.\n`);

      await post('Release Two', 'type: Blog Post\ntopic: main\npublished_at: 2026-02-01T00:00:00.000Z\ntags: [release]\n');
      await post('News One', 'type: Blog Post\ntopic: main\npublished_at: 2026-01-01T00:00:00.000Z\ntags: [news]\n');
      await post('Announcement Three', 'type: Blog Post\ntopic: main\npublished_at: 2026-03-01T00:00:00.000Z\ntags: [announcement]\n');
      // Each of the next three fails exactly one of the three filters.
      await post('Untagged Post', 'type: Blog Post\ntopic: main\npublished_at: 2026-04-01T00:00:00.000Z\n');
      await post('Tagged FAQ', 'type: FAQ\ntopic: main\npublished_at: 2026-04-01T00:00:00.000Z\ntags: [news]\n');
      await post('Other Topic News', 'type: Blog Post\ntopic: elsewhere\npublished_at: 2026-04-01T00:00:00.000Z\ntags: [news]\n');
      // A draft carrying the tag is still not published content.
      await createRaw('---\ntitle: Draft News\ntype: Blog Post\ntopic: main\ntags: [news]\n---\nNot yet.\n');

      await putSections([
        { name: 'News', slug: 'news', type: 'blog-post', space: 'main', tags: ['news', 'release', 'announcement'], slot: 'latest', order: 1 },
      ]).expect(200);

      const [section] = await query.sections('main', admin);
      expect(titles(section?.items)).toEqual(['Announcement Three', 'Release Two', 'News One']);
      expect(section?.tags).toEqual(['announcement', 'news', 'release']);
    });

    it('renders a section naming a tag nobody uses as empty, and the landing drops it', async () => {
      await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
        .send({ name: 'Main', slug: 'main', presentation: 'portal' }).expect(201);
      await createRaw(`---\ntitle: A Post\ntype: Blog Post\ntopic: main\nstatus: published\npublished_at: 2026-01-01T00:00:00.000Z\n${PUBLISHABLE}tags: [news]\n---\nBody.\n`);

      await putSections([
        { name: 'News', slug: 'news', space: 'main', tags: ['news'] },
        { name: 'Ghost', slug: 'ghost', space: 'main', tags: ['no-such-tag-yet'] },
      ]).expect(200);

      const sections = await query.sections('main', admin);
      expect(sections.map((s) => s.slug)).toEqual(['ghost', 'news']);
      expect(titles(sections.find((s) => s.slug === 'ghost')?.items)).toEqual([]);

      // The landing page omits sections that resolve to nothing, so an unused tag
      // costs the curator an empty heading rather than an error.
      const landing = await query.topic('main', admin);
      expect(landing?.sections?.map((s) => s.slug)).toEqual(['news']);
    });

    it('honours the section limit, and respects the caller when it is anonymous', async () => {
      await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
        .send({ name: 'Main', slug: 'main', presentation: 'portal' }).expect(201);
      await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
        .send({ name: 'Hidden', slug: 'hidden', visibility: 'private' }).expect(201);

      for (let i = 1; i <= 3; i++) {
        await createRaw(`---\ntitle: News ${i}\ntopic: main\nstatus: published\n${CONFORMANT_YAML}published_at: 2026-0${i}-01T00:00:00.000Z\ntags: [news]\n---\nBody.\n`);
      }
      await createRaw(`---\ntitle: Private News\ntopic: hidden\nstatus: published\n${CONFORMANT_YAML}tags: [news]\n---\nBody.\n`);

      await putSections([{ name: 'News', slug: 'news', space: 'main', tags: ['news'], limit: 2 }]).expect(200);
      const [section] = await query.sections('main', admin);
      expect(titles(section?.items)).toEqual(['News 3', 'News 2']);

      await putSections([{ name: 'All News', slug: 'all-news', space: 'hidden', tags: ['news'] }]).expect(200);
      const anon = await query.sections('hidden', { userId: null, role: 'anonymous' });
      expect(titles(anon[0]?.items)).toEqual([]);
    });
  });

  it('exposes the any-of tag filter on the pages list endpoint', async () => {
    await createRaw(`---\ntitle: Tagged News\nstatus: published\n${CONFORMANT_YAML}tags: [news]\n---\nBody.\n`);
    await createRaw(`---\ntitle: Tagged Release\nstatus: published\n${CONFORMANT_YAML}tags: [release]\n---\nBody.\n`);
    await createRaw(`---\ntitle: Untagged\nstatus: published\n${CONFORMANT_YAML}---\nBody.\n`);

    const res = await request(app.getHttpServer())
      .get('/api/v1/pages?tags=news&tags=release&status=published')
      .set('Cookie', cookie)
      .expect(200);
    expect((res.body.items as { title: string }[]).map((i) => i.title).sort()).toEqual(['Tagged News', 'Tagged Release']);

    // A single value still works, and the pre-existing `tag` param is unchanged.
    const one = await request(app.getHttpServer()).get('/api/v1/pages?tags=news').set('Cookie', cookie).expect(200);
    expect((one.body.items as { title: string }[]).map((i) => i.title)).toEqual(['Tagged News']);
    const legacy = await request(app.getHttpServer()).get('/api/v1/pages?tag=release').set('Cookie', cookie).expect(200);
    expect((legacy.body.items as { title: string }[]).map((i) => i.title)).toEqual(['Tagged Release']);
  });
});
