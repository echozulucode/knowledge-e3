/**
 * Topic presentation profiles (plan §3.1) and Sections as landing-page slots
 * (§3.2): stored on the topic, readable over REST, and resolved to items through
 * the KnowledgeQuery seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };

describe('topic presentation e2e', () => {
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

  async function createTopic(body: Record<string, unknown>) {
    const res = await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send(body).expect(201);
    return res.body.topic as { id: string; slug: string };
  }

  async function createPage(title: string, type: string, topic: string, status = 'published') {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body: 'x', status, frontmatter: conformant({ type, topic }) })
      .expect(201);
  }

  it('defaults to wiki, updates via PUT, and reads back through the topics list and the query seam', async () => {
    const topic = await createTopic({ name: 'MATLAB', slug: 'matlab' });

    const before = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    expect(before.body.topics.find((t: { slug: string }) => t.slug === 'matlab')).toMatchObject({
      presentation: 'wiki',
      landing_markdown: null,
      start_here: null,
    });

    const put = await request(app.getHttpServer())
      .put(`/api/v1/topics/${topic.id}`)
      .set('Cookie', cookie)
      .send({ presentation: 'portal', landing_markdown: 'Short gateway prose.', start_here: 'use-ai' })
      .expect(200);
    expect(put.body.topic).toMatchObject({ presentation: 'portal', landing_markdown: 'Short gateway prose.', start_here: 'use-ai' });

    const after = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    expect(after.body.topics.find((t: { slug: string }) => t.slug === 'matlab')).toMatchObject({
      presentation: 'portal',
      landing_markdown: 'Short gateway prose.',
      start_here: 'use-ai',
    });

    // A partial update leaves the other presentation fields alone.
    const rename = await request(app.getHttpServer()).put(`/api/v1/topics/${topic.id}`).set('Cookie', cookie).send({ name: 'MATLAB / Simulink' }).expect(200);
    expect(rename.body.topic).toMatchObject({ name: 'MATLAB / Simulink', presentation: 'portal', start_here: 'use-ai' });

    expect(await query.topic('matlab', admin)).toMatchObject({
      presentation: 'portal',
      landing_markdown: 'Short gateway prose.',
      start_here: 'use-ai',
      sections: [],
    });
    // The list carries the profile and counts only.
    const listed = (await query.topics(admin)).find((t) => t.slug === 'matlab');
    expect(listed).toMatchObject({ presentation: 'portal', counts: { items: 0, published: 0 } });
    expect(listed).not.toHaveProperty('landing_markdown');
  });

  it('rejects an unknown presentation profile', async () => {
    const topic = await createTopic({ name: 'Docs' });
    await request(app.getHttpServer()).put(`/api/v1/topics/${topic.id}`).set('Cookie', cookie).send({ presentation: 'kiosk' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Bad', presentation: 'kiosk' }).expect(400);
  });

  it('accepts the presentation fields at creation', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Blog', presentation: 'blog', landing_markdown: 'Welcome.', start_here: 'first-post' })
      .expect(201);
    expect(created.body.topic).toMatchObject({ presentation: 'blog', landing_markdown: 'Welcome.', start_here: 'first-post' });
  });

  it('resolves a topic\'s sections to items in slot order and drops empty ones', async () => {
    await createTopic({ name: 'Portal', slug: 'portal', presentation: 'portal' });
    await createTopic({ name: 'Other', slug: 'other' });
    await createPage('How-to A', 'guide', 'portal');
    await createPage('How-to B', 'guide', 'portal');
    await createPage('How-to C', 'guide', 'portal');
    await createPage('Example 1', 'example', 'portal');
    await createPage('Draft guide', 'guide', 'portal', 'draft');
    await createPage('Elsewhere', 'guide', 'other');

    await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', cookie)
      .send({
        sections: [
          { name: 'Examples', type: 'example', space: 'portal', slot: 'examples', order: 2 },
          { name: 'Essential guidance', type: 'guide', space: 'portal', slot: 'essential', order: 1, limit: 2 },
          { name: 'Known limitations', type: 'limitation', space: 'portal', slot: 'limitations', order: 3 },
          { name: 'Other guides', type: 'guide', space: 'other', slot: 'essential' },
        ],
      })
      .expect(200);

    const topic = await query.topic('portal', admin);
    expect(topic?.sections?.map((s) => s.slug)).toEqual(['essential-guidance', 'examples']);
    const essential = topic!.sections![0]!;
    expect(essential).toMatchObject({ slot: 'essential', order: 1, limit: 2 });
    expect(essential.items).toHaveLength(2); // capped by limit; the draft is excluded
    expect(essential.items!.every((i) => i.type === 'guide' && i.status === 'published')).toBe(true);
    expect(topic!.sections![1]!.items!.map((i) => i.title)).toEqual(['Example 1']);

    // The sections query returns every section (empty ones included) with items.
    const all = await query.sections('portal', admin);
    expect(all.map((s) => s.slug)).toEqual(['essential-guidance', 'examples', 'known-limitations']);
    expect(all[2]!.items).toEqual([]);
    expect((await query.sections('space_portal', admin)).map((s) => s.slug)).toEqual(all.map((s) => s.slug));
  });

  it('keeps a private topic\'s landing page off the anonymous surface', async () => {
    const topic = await createTopic({ name: 'Secret', slug: 'secret', visibility: 'private', landing_markdown: 'Internal only.' });
    expect(await query.topic('secret', admin)).toMatchObject({ landing_markdown: 'Internal only.' });
    expect(await query.topic('secret', ANON)).toBeNull();
    expect(await query.topic(topic.id, ANON)).toBeNull();
    const anon = await request(app.getHttpServer()).get('/api/v1/topics').expect(200);
    expect(JSON.stringify(anon.body)).not.toContain('Internal only.');
  });

  it('serves the landing page over REST, 404 when missing or invisible to the viewer', async () => {
    await createTopic({ name: 'Landing', slug: 'landing', presentation: 'portal', landing_markdown: 'Gateway.', start_here: 'use-ai' });
    await createPage('How-to A', 'guide', 'landing');
    await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', cookie)
      .send({ sections: [{ name: 'Essential guidance', type: 'guide', space: 'landing', slot: 'essential', order: 1 }] })
      .expect(200);

    const res = await request(app.getHttpServer()).get('/api/v1/topics/landing/landing').expect(200);
    expect(res.body.topic).toMatchObject({ slug: 'landing', presentation: 'portal', landing_markdown: 'Gateway.', start_here: 'use-ai' });
    expect(res.body.topic.sections).toHaveLength(1);
    expect(res.body.topic.sections[0]).toMatchObject({ slot: 'essential', items: [{ title: 'How-to A' }] });

    await request(app.getHttpServer()).get('/api/v1/topics/nope/landing').expect(404);
    await createTopic({ name: 'Secret', slug: 'secret', visibility: 'private' });
    await request(app.getHttpServer()).get('/api/v1/topics/secret/landing').expect(404);
    await request(app.getHttpServer()).get('/api/v1/topics/secret/landing').set('Cookie', cookie).expect(200);
  });
});
