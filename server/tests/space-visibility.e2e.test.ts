/**
 * Space visibility e2e.
 *
 * `spaces.visibility` is 'public' | 'private', where **private means "not
 * exposed to anonymous visitors"**. It is NOT a per-user ACL: signed-in users
 * are deliberately unaffected. It ANDs with the instance read mode and with
 * per-item `status`.
 *
 * Before this column existed, every published page was anonymously readable on
 * a public instance — so 'public' is the default and this is purely additive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('space visibility e2e', () => {
  let app: INestApplication;
  let adminCookie: string;
  let aliceCookie: string;
  let openId: string;
  let secretId: string;
  let openSlug: string;
  let secretSlug: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie } = await seedAdminAndLogin(app));
    ({ cookie: aliceCookie } = await seedUserAndLogin(app, 'alice', 'alice-password-123'));
    await curateCategories(app);

    const open = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', adminCookie)
      .send({ name: 'Open Topic' })
      .expect(201);
    const secret = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', adminCookie)
      .send({ name: 'Secret Topic', visibility: 'private' })
      .expect(201);

    // Both hold a PUBLISHED page, so only space visibility distinguishes them.
    const a = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', adminCookie)
      .send({ title: 'Open Doc', body: 'zebrafish open', status: 'published', frontmatter: conformant({ topic: 'Open Topic' }) })
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', adminCookie)
      .send({ title: 'Secret Doc', body: 'zebrafish secret', status: 'published', frontmatter: conformant({ topic: 'Secret Topic' }) })
      .expect(201);
    openId = a.body.id ?? a.body.page?.id;
    secretId = b.body.id ?? b.body.page?.id;
    openSlug = a.body.slug ?? a.body.page?.slug;
    secretSlug = b.body.slug ?? b.body.page?.slug;

    expect(open.body.topic.visibility).toBe('public');
    expect(secret.body.topic.visibility).toBe('private');

    await request(app.getHttpServer())
      .put('/api/v1/admin/access')
      .set('Cookie', adminCookie)
      .send({ read_mode: 'public' })
      .expect(200);
  });
  afterEach(async () => app.close());

  it('defaults existing/new topics to public (purely additive)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/spaces').expect(200);
    const names = res.body.spaces.map((s: any) => s.name);
    expect(names).toContain('Open Topic');
    // ...and never advertises a private topic's existence to anonymous callers.
    expect(names).not.toContain('Secret Topic');
  });

  it('hides private-topic items from anonymous search', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/search?q=zebrafish').expect(200);
    const titles = res.body.results.map((r: any) => r.title);
    expect(titles).toContain('Open Doc');
    expect(titles).not.toContain('Secret Doc');
  });

  it('hides private-topic items from anonymous list and direct reads', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
    const titles = (list.body.pages ?? list.body.items ?? list.body).map?.((p: any) => p.title) ?? [];
    expect(titles).toContain('Open Doc');
    expect(titles).not.toContain('Secret Doc');

    // These routes answer 200 with `page: null` when a page isn't visible,
    // rather than 404 — that's the established contract, and it leaks nothing.
    const openRead = await request(app.getHttpServer()).get(`/api/v1/pages/${openId}`).expect(200);
    expect(openRead.body.page?.title).toBe('Open Doc');
    const secretRead = await request(app.getHttpServer()).get(`/api/v1/pages/${secretId}`).expect(200);
    expect(secretRead.body.page).toBeNull();

    const openBySlug = await request(app.getHttpServer()).get(`/api/v1/pages/by-slug/${openSlug}`).expect(200);
    expect(openBySlug.body.page?.title).toBe('Open Doc');
    const secretBySlug = await request(app.getHttpServer()).get(`/api/v1/pages/by-slug/${secretSlug}`).expect(200);
    expect(secretBySlug.body.page).toBeNull();
  });

  it('hides private-topic items over anonymous MCP', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge.search', arguments: { query: 'zebrafish' } } })
      .expect(200);
    const line = res.text.split('\n').find((l) => l.startsWith('data: '))!;
    const text = JSON.parse(line.slice(6)).result.content[0].text;
    expect(text).toContain('Open Doc');
    expect(text).not.toContain('Secret Doc');
  });

  // The control narrows PUBLIC exposure only — it must not become a surprise
  // ACL that hides content from the team on a self-hosted instance.
  it('leaves signed-in non-admin users unaffected', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=zebrafish')
      .set('Cookie', aliceCookie)
      .expect(200);
    const titles = res.body.results.map((r: any) => r.title);
    expect(titles).toContain('Open Doc');
    expect(titles).toContain('Secret Doc');
    await request(app.getHttpServer()).get(`/api/v1/pages/${secretId}`).set('Cookie', aliceCookie).expect(200);
  });

  it('admin can flip a topic back and forth', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/topics/${'space_secret-topic'}`)
      .set('Cookie', adminCookie)
      .send({ visibility: 'public' })
      .expect(200);
    const opened = await request(app.getHttpServer()).get('/api/v1/search?q=zebrafish').expect(200);
    expect(opened.body.results.map((r: any) => r.title)).toContain('Secret Doc');

    await request(app.getHttpServer())
      .put(`/api/v1/topics/${'space_secret-topic'}`)
      .set('Cookie', adminCookie)
      .send({ visibility: 'private' })
      .expect(200);
    const closed = await request(app.getHttpServer()).get('/api/v1/search?q=zebrafish').expect(200);
    expect(closed.body.results.map((r: any) => r.title)).not.toContain('Secret Doc');
  });

  // Vocabulary is derived from content, so it leaks the SHAPE of private work
  // even when the content itself is gated.
  describe('derived vocabulary', () => {
    // These two carry a category that is NOT in the curated catalog, on purpose:
    // the catalog is visible to everyone, so only an uncurated term proves that
    // USAGE inside a private topic stays hidden. The publish gate refuses such a
    // document, so they are published the way legacy content is — as a draft,
    // then an admin publish over the diagnostics (`allow_lint_errors`).
    async function publishLegacy(title: string, frontmatter: Record<string, unknown>) {
      const draft = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', adminCookie)
        .send({ title, body: 'x', status: 'draft', frontmatter: conformant(frontmatter) })
        .expect(201);
      await request(app.getHttpServer())
        .put(`/api/v1/items/${draft.body.page.id}`)
        .set('Cookie', adminCookie)
        .set('If-Match', String(draft.body.version_token))
        .send({ status: 'published', allow_lint_errors: true })
        .expect(200);
    }

    beforeEach(async () => {
      await publishLegacy('Tagged Secret', { topic: 'Secret Topic', tags: ['secret-tag'], categories: ['Secret Category'] });
      await publishLegacy('Tagged Open', { topic: 'Open Topic', tags: ['open-tag'], categories: ['Open Category'] });
    });

    it('omits tags used only inside a private topic', async () => {
      const anon = await request(app.getHttpServer()).get('/api/v1/taxonomy/tags').expect(200);
      const names = anon.body.tags.map((t: any) => t.name);
      expect(names).toContain('open-tag');
      expect(names).not.toContain('secret-tag');

      // Signed-in callers are unaffected.
      const authed = await request(app.getHttpServer()).get('/api/v1/taxonomy/tags').set('Cookie', aliceCookie).expect(200);
      expect(authed.body.tags.map((t: any) => t.name)).toContain('secret-tag');
    });

    it('omits categories used only inside a private topic', async () => {
      const anon = await request(app.getHttpServer()).get('/api/v1/taxonomy/categories').expect(200);
      const names = anon.body.categories.map((c: any) => c.name);
      expect(names).toContain('Open Category');
      expect(names).not.toContain('Secret Category');
    });

    it('omits private topics from the topics list and never counts drafts', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', adminCookie)
        .send({ title: 'Open Draft', body: 'x', status: 'draft', frontmatter: { topic: 'Open Topic' } })
        .expect(201);

      const anon = await request(app.getHttpServer()).get('/api/v1/topics').expect(200);
      const names = anon.body.topics.map((t: any) => t.name);
      expect(names).toContain('Open Topic');
      expect(names).not.toContain('Secret Topic');

      // The count itself must not reveal how much unpublished work exists.
      const open = anon.body.topics.find((t: any) => t.name === 'Open Topic');
      expect(open.counts.draft).toBe(0);
      expect(open.counts.items).toBe(open.counts.published);

      const authed = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', aliceCookie).expect(200);
      expect(authed.body.topics.find((t: any) => t.name === 'Open Topic').counts.draft).toBe(1);
    });

    it('hides a group scoped to a private topic but keeps empty public groups', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/groups')
        .set('Cookie', adminCookie)
        .send({ name: 'Secret Group', space_id: 'space_secret-topic' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/taxonomy/groups')
        .set('Cookie', adminCookie)
        .send({ name: 'Open Group', space_id: 'space_open-topic' })
        .expect(201);

      const anon = await request(app.getHttpServer()).get('/api/v1/taxonomy/groups').expect(200);
      const names = anon.body.groups.map((g: any) => g.name);
      expect(names).not.toContain('Secret Group');
      // An empty PUBLIC group must survive — the count join must stay a LEFT join.
      expect(names).toContain('Open Group');
    });
  });

  /**
   * The control is a security control, so it is reachable only by an admin and
   * it leaves a trace. `config.read_access_change` set the precedent for the
   * INSTANCE-wide toggle; narrowing or opening one topic is the same question
   * asked about a smaller blast radius, and deserves the same answer.
   */
  describe('admin surface', () => {
    async function auditActions(action: string) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/audit?action=${action}`)
        .set('Cookie', adminCookie)
        .expect(200);
      return res.body.entries as { action: string; actor_id: string | null; payload: any }[];
    }

    it('is admin-only: a signed-in non-admin and an anonymous caller cannot flip a topic', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .set('Cookie', aliceCookie)
        .send({ visibility: 'private' })
        .expect(403);
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .send({ visibility: 'private' })
        .expect(401);

      // ...and the refusal actually refused: the topic is still public.
      const anon = await request(app.getHttpServer()).get('/api/v1/topics').expect(200);
      expect(anon.body.topics.map((t: any) => t.name)).toContain('Open Topic');
    });

    it('audits a visibility change with the actor and both values', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .set('Cookie', adminCookie)
        .send({ visibility: 'private' })
        .expect(200);

      const closed = await auditActions('space.visibility_change');
      expect(closed).toHaveLength(1);
      // Both values, or the row cannot answer "what did this change?".
      expect(closed[0]!.payload).toMatchObject({
        space_id: 'space_open-topic',
        slug: 'open-topic',
        from: 'public',
        to: 'private',
      });
      expect(closed[0]!.actor_id).toBeTruthy();

      // Opening one back up is just as much a security event as closing it.
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .set('Cookie', adminCookie)
        .send({ visibility: 'public' })
        .expect(200);
      const reopened = await auditActions('space.visibility_change');
      expect(reopened).toHaveLength(2);
      expect(reopened[0]!.payload).toMatchObject({ from: 'private', to: 'public' });
    });

    it('does not record a row for a rename or a no-op flip', async () => {
      // A log that says "visibility changed" when it did not is worse than no
      // log: it costs an admin a real investigation every time someone renames.
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .set('Cookie', adminCookie)
        .send({ name: 'Open Topic Renamed' })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/topics/space_open-topic')
        .set('Cookie', adminCookie)
        .send({ visibility: 'public' })
        .expect(200);

      expect(await auditActions('space.visibility_change')).toHaveLength(0);
    });
  });

  it('rejects a bogus visibility value', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/topics/space_open-topic')
      .set('Cookie', adminCookie)
      .send({ visibility: 'sort-of-public' })
      .expect(400);
  });
});
