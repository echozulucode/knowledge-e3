import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

/**
 * Acceptance tests for the rename flow from spec section 6.5.
 * The rewrite is AST-aware: code-block content with the same title is left untouched.
 */
describe('wiki-link rename e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  async function createPage(title: string, body: string): Promise<{ id: string; version: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body, status: 'published' })
      .expect(201);
    return { id: res.body.page.id, version: res.body.page.version_token };
  }

  it('AT-1: rename with 0 inbound links is a clean rename', async () => {
    const target = await createPage('Lonely', 'No backlinks here.');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version))
      .send({ new_title: 'Lonely Renamed', link_action: 'update_all' })
      .expect(201);
    expect(res.body.page.title).toBe('Lonely Renamed');
    expect(res.body.affected_pages).toHaveLength(1);
    expect(res.body.affected_pages[0].id).toBe(target.id);
  });

  it('AT-2: rename with N inbound links (update_all) atomically rewrites all', async () => {
    const target = await createPage('Old Target', 'Target body.');
    await createPage('Page A', 'See [[Old Target]] for details.');
    await createPage('Page B', 'And also [[Old Target]] in here.');
    await createPage('Page C', 'Plus [[Old Target]] in this list.');

    // Capture pre-rename version_tokens so we can verify each linker bumps by 1.
    const preTokens: Record<string, number> = {};
    for (const t of ['Page A', 'Page B', 'Page C']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/pages/by-title/${encodeURIComponent(t)}`)
        .set('Cookie', cookie);
      preTokens[t] = res.body.page.version_token;
    }

    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version))
      .send({ new_title: 'New Target', link_action: 'update_all' })
      .expect(201);

    // Each of A, B, C now has [[New Target]] AND its version_token bumped by exactly 1.
    for (const t of ['Page A', 'Page B', 'Page C']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/pages/by-title/${encodeURIComponent(t)}`)
        .set('Cookie', cookie);
      expect(res.body.page.body_markdown).toContain('[[New Target]]');
      expect(res.body.page.body_markdown).not.toContain('[[Old Target]]');
      expect(res.body.page.version_token).toBe(preTokens[t]! + 1);
    }
  });

  it('AT-3: code-block content with the old title is NOT rewritten', async () => {
    const target = await createPage('CodeTarget', 'Target body.');
    await createPage(
      'Has Code Block',
      'Real link: [[CodeTarget]]. \n\n```ts\nconst x = "[[CodeTarget]]"; // string literal, not a wiki link\n```\n',
    );

    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version))
      .send({ new_title: 'CodeTarget Renamed', link_action: 'update_all' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/pages/by-title/${encodeURIComponent('Has Code Block')}`)
      .set('Cookie', cookie);
    const body = res.body.page.body_markdown as string;
    expect(body).toContain('[[CodeTarget Renamed]]');
    // Inside the code block, the literal text remains "[[CodeTarget]]" — unchanged.
    expect(body).toContain('"[[CodeTarget]]"');
  });

  it('AT-4: rowversion mismatch on a linked page rolls back the entire rename', async () => {
    const target = await createPage('Old', 'Target.');
    const a = await createPage('Linker', '[[Old]] is here.');

    // Concurrently bump Linker so its version_token is now stale relative to what the rename expects.
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${a.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(a.version))
      .send({ body: '[[Old]] still here, just edited.' })
      .expect(200);

    // Rename with explicit expected_affected_versions still pinned to the OLD value.
    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version))
      .send({
        new_title: 'New',
        link_action: 'update_all',
        expected_affected_versions: { [a.id]: a.version }, // stale — must trigger 409
      })
      .expect(409);

    // Target was NOT renamed:
    const got = await request(app.getHttpServer())
      .get(`/api/v1/pages/${target.id}`)
      .set('Cookie', cookie);
    expect(got.body.page.title).toBe('Old');
    // And Linker's body still says [[Old]]:
    const linker = await request(app.getHttpServer())
      .get(`/api/v1/pages/${a.id}`)
      .set('Cookie', cookie);
    expect(linker.body.page.body_markdown).toContain('[[Old]]');
  });

  it('AT-5: rename with link_action=skip leaves inbound links broken', async () => {
    const target = await createPage('To Be Renamed', 'Target.');
    await createPage('Linker', 'A link to [[To Be Renamed]] here.');
    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version))
      .send({ new_title: 'New Name', link_action: 'skip' })
      .expect(201);

    // Linker still has [[To Be Renamed]] — broken now.
    const linker = await request(app.getHttpServer())
      .get(`/api/v1/pages/by-title/${encodeURIComponent('Linker')}`)
      .set('Cookie', cookie);
    expect(linker.body.page.body_markdown).toContain('[[To Be Renamed]]');
  });
});

describe('backlinks e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  it('returns inbound links to a page', async () => {
    const target = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Hub', body: 'Hub page.', status: 'published' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Source 1', body: 'See [[Hub]] for context.', status: 'published' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Source 2', body: 'Also [[Hub]] over here.', status: 'published' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/pages/${target.body.page.id}/backlinks`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.backlinks).toHaveLength(2);
    const sourceTitles = res.body.backlinks.map((b: { source_title: string }) => b.source_title).sort();
    expect(sourceTitles).toEqual(['Source 1', 'Source 2']);
    // Snippet should be a string with the wikilink context.
    expect(res.body.backlinks[0].snippet).toContain('[[Hub]]');
  });
});
