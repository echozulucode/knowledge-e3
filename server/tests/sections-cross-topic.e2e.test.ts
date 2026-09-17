/**
 * Cross-topic Sections: a Section that names NO topic draws from every topic and
 * belongs to the front page alone.
 *
 * This is the first surface that pulls items out of every topic onto the most
 * public page in the product, so the load-bearing test here is the private-topic
 * one. `visibility: 'private'` means "not exposed to anonymous visitors", and
 * signed-in non-admins are deliberately unaffected by that rule — both halves are
 * asserted, because a test that only checked the anonymous half would also pass
 * if the section returned nothing to anyone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { CONFORMANT_YAML, FIXTURE_CATEGORY, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };

/** The publish-time frontmatter for a raw fixture that already names its `type` (issue 98). */
const PUBLISHABLE = `description: A test fixture.\ncategories: [${FIXTURE_CATEGORY}]\nauthors: [admin]\n`;

describe('Cross-topic sections', () => {
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
    return request(app.getHttpServer()).put('/api/v1/sections').set('Cookie', cookie).send({ sections }).expect(200);
  }

  function makeTopic(slug: string, extra: Record<string, unknown> = {}) {
    return request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie)
      .send({ name: slug, slug, ...extra }).expect(201);
  }

  function titles(items: { title: string }[] | undefined) {
    return (items ?? []).map((i) => i.title);
  }

  it('draws from every topic, newest first, and still ANDs with tags and type', async () => {
    await makeTopic('alpha');
    await makeTopic('beta');

    // Each carries its own `type`, so only the rest of what the publish gate
    // asks for is added: a description, a curated category, and the author a
    // published Blog Post needs (the FAQ tolerates it).
    const post = (title: string, fm: string) =>
      createRaw(`---\ntitle: ${title}\nstatus: published\n${PUBLISHABLE}${fm}---\nBody.\n`);
    await post('Alpha News', 'type: Blog Post\ntopic: alpha\npublished_at: 2026-01-01T00:00:00.000Z\ntags: [news]\n');
    await post('Beta Release', 'type: Blog Post\ntopic: beta\npublished_at: 2026-02-01T00:00:00.000Z\ntags: [release]\n');
    // Each of these fails exactly one filter, none of them the topic.
    await post('Beta Untagged', 'type: Blog Post\ntopic: beta\npublished_at: 2026-03-01T00:00:00.000Z\n');
    await post('Alpha Tagged FAQ', 'type: FAQ\ntopic: alpha\npublished_at: 2026-03-01T00:00:00.000Z\ntags: [news]\n');

    await putSections([{ name: 'Company news', slug: 'company-news', type: 'Blog Post', tags: ['news', 'release'], slot: 'latest' }]);

    const [section] = await query.crossTopicSections(admin);
    expect(titles(section?.items)).toEqual(['Beta Release', 'Alpha News']);
    expect(section?.space).toBeUndefined();
  });

  it('does not appear on any topic landing, while a topiced section still does', async () => {
    await makeTopic('alpha', { presentation: 'portal' });
    await makeTopic('beta', { presentation: 'portal' });
    await createRaw(`---\ntitle: Alpha News\nstatus: published\n${CONFORMANT_YAML}topic: alpha\ntags: [news]\n---\nBody.\n`);
    await createRaw(`---\ntitle: Beta News\nstatus: published\n${CONFORMANT_YAML}topic: beta\ntags: [news]\n---\nBody.\n`);

    await putSections([
      { name: 'Everywhere news', slug: 'everywhere-news', tags: ['news'] },
      { name: 'Alpha only', slug: 'alpha-only', space: 'alpha', tags: ['news'] },
    ]);

    // The untopiced section must not become noise on every topic landing.
    expect((await query.sections('alpha', admin)).map((s) => s.slug)).toEqual(['alpha-only']);
    expect((await query.sections('beta', admin)).map((s) => s.slug)).toEqual([]);
    expect((await query.topic('alpha', admin))?.sections?.map((s) => s.slug)).toEqual(['alpha-only']);
    expect((await query.topic('beta', admin))?.sections ?? []).toEqual([]);

    // It is the front page's, and it spans both topics.
    const cross = await query.crossTopicSections(admin);
    expect(cross.map((s) => s.slug)).toEqual(['everywhere-news']);
    expect(titles(cross[0]?.items).sort()).toEqual(['Alpha News', 'Beta News']);

    // The catalog listing (no topic argument) is unchanged: it still returns all.
    expect((await query.sections(undefined, admin)).map((s) => s.slug)).toEqual(['alpha-only', 'everywhere-news']);
  });

  it('keeps a private topic out of the front page for an anonymous visitor, and shows it to a signed-in one', async () => {
    await makeTopic('open');
    await makeTopic('secret', { visibility: 'private' });
    await createRaw(`---\ntitle: Public News\nstatus: published\n${CONFORMANT_YAML}topic: open\npublished_at: 2026-01-01T00:00:00.000Z\ntags: [news]\n---\nBody.\n`);
    await createRaw(`---\ntitle: Private News\nstatus: published\n${CONFORMANT_YAML}topic: secret\npublished_at: 2026-02-01T00:00:00.000Z\ntags: [news]\n---\nBody.\n`);

    await putSections([{ name: 'Company news', slug: 'company-news', tags: ['news'] }]);

    // The rule being enforced: private = "not exposed to anonymous visitors".
    const anon = await query.crossTopicSections(ANON);
    expect(titles(anon[0]?.items)).toEqual(['Public News']);

    // And the other half — a signed-in NON-admin is deliberately unaffected by
    // that rule, so this proves the gate is the visibility rule rather than a
    // blanket "return nothing from other topics".
    const { userId } = await seedUserAndLogin(app);
    const signedIn = await query.crossTopicSections({ userId, role: 'user' });
    expect(titles(signedIn[0]?.items)).toEqual(['Private News', 'Public News']);

    const asAdmin = await query.crossTopicSections(admin);
    expect(titles(asAdmin[0]?.items)).toEqual(['Private News', 'Public News']);
  });

  it('drops a cross-topic section that resolves to no items, exactly as a topic landing does', async () => {
    await makeTopic('alpha');
    await createRaw(`---\ntitle: Alpha News\nstatus: published\n${CONFORMANT_YAML}topic: alpha\ntags: [news]\n---\nBody.\n`);

    await putSections([
      { name: 'Company news', slug: 'company-news', tags: ['news'] },
      // Configured, and matching nothing — the NORMAL first state of a
      // cross-topic section, because tags here are emergent rather than
      // curated. It must not put a heading over an empty list on the front
      // page, which is the first thing a fresh tenant would see.
      { name: 'Announcements', slug: 'announcements', tags: ['no-such-tag'] },
      // A section whose TYPE filter matches nothing, so the emptiness is not
      // only a tag story.
      { name: 'Ghost type', slug: 'ghost-type', type: 'No Such Type' },
    ]);

    const cross = await query.crossTopicSections(admin);
    expect(cross.map((s) => s.slug)).toEqual(['company-news']);

    // The catalog is untouched: the curator's definitions all still exist, they
    // simply have nothing to show yet.
    expect((await query.sections(undefined, admin)).map((s) => s.slug).sort()).toEqual([
      'announcements',
      'company-news',
      'ghost-type',
    ]);

    const over = await request(app.getHttpServer()).get('/api/v1/sections/cross-topic').set('Cookie', cookie).expect(200);
    expect(over.body.sections.map((s: { slug: string }) => s.slug)).toEqual(['company-news']);

    // And it is per viewer, not global: the one item lives in a public topic,
    // so an anonymous visitor sees the same single section...
    const anon = await request(app.getHttpServer()).get('/api/v1/sections/cross-topic').expect(200);
    expect(anon.body.sections.map((s: { slug: string }) => s.slug)).toEqual(['company-news']);
  });

  it('drops a section for the viewer it is empty FOR, while keeping it for one it is not', async () => {
    await makeTopic('secret', { visibility: 'private' });
    await createRaw(`---\ntitle: Private News\nstatus: published\n${CONFORMANT_YAML}topic: secret\ntags: [news]\n---\nBody.\n`);
    await putSections([{ name: 'Company news', slug: 'company-news', tags: ['news'] }]);

    // The only matching item is in a private topic. A signed-in reader gets the
    // section; an anonymous visitor gets no section at all rather than an empty
    // heading that advertises content they may not read.
    expect((await query.crossTopicSections(admin)).map((s) => s.slug)).toEqual(['company-news']);
    expect(await query.crossTopicSections(ANON)).toEqual([]);
  });

  it('serves cross-topic sections over HTTP, resolved for the caller', async () => {
    await makeTopic('open');
    await makeTopic('secret', { visibility: 'private' });
    await createRaw(`---\ntitle: Public News\nstatus: published\n${CONFORMANT_YAML}topic: open\ntags: [news]\n---\nBody.\n`);
    await createRaw(`---\ntitle: Private News\nstatus: published\n${CONFORMANT_YAML}topic: secret\ntags: [news]\n---\nBody.\n`);

    await putSections([
      { name: 'Company news', slug: 'company-news', tags: ['news'] },
      { name: 'Open only', slug: 'open-only', space: 'open', tags: ['news'] },
    ]);

    const asAdmin = await request(app.getHttpServer()).get('/api/v1/sections/cross-topic').set('Cookie', cookie).expect(200);
    expect(asAdmin.body.sections.map((s: { slug: string }) => s.slug)).toEqual(['company-news']);
    expect(titles(asAdmin.body.sections[0].items).sort()).toEqual(['Private News', 'Public News']);

    // The route reads as the caller, so an anonymous request gets the gated set.
    const anon = await request(app.getHttpServer()).get('/api/v1/sections/cross-topic').expect(200);
    expect(titles(anon.body.sections[0].items)).toEqual(['Public News']);

    // `GET /sections` is untouched: it is still the whole catalog of definitions.
    const all = await request(app.getHttpServer()).get('/api/v1/sections').set('Cookie', cookie).expect(200);
    expect(all.body.sections.map((s: { slug: string }) => s.slug)).toEqual(['company-news', 'open-only']);
  });
});
