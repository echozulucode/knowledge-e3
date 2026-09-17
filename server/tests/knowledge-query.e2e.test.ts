/**
 * KnowledgeQuery seam (plan §9.3, Phase 1): delegation over today's services
 * plus derived lifecycle/trust signals. Exercised directly through the service
 * so the contract is pinned independently of any one transport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { CONFORMANT_YAML, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };

describe('KnowledgeQuery seam', () => {
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
    // Every published fixture below files itself under a curated category: a
    // create that lands published is gated like any other publish (issue 98).
    await curateCategories(app, 'guides');
  });
  afterEach(async () => app.close());

  async function createRaw(raw: string, asCookie = cookie) {
    const res = await request(app.getHttpServer()).post('/api/v1/items').set('Cookie', asCookie).send({ raw }).expect(201);
    return res.body.item as { id: string; slug: string; updated_at: string; current_version_id: string };
  }

  /**
   * Plan §3.5 item 3. This assertion exists because the policy it checks was
   * written, unit-tested and then never called from anywhere for two phases:
   * `applyLifecyclePolicy` had a full test suite in `packages/search` and zero
   * non-test consumers, so search rendered trust and freshness labels while
   * ranking as though they did not exist. A unit test on a pure function cannot
   * notice that nobody calls it — only an end-to-end assertion through the seam
   * can, which is what this is.
   */
  it('ranks a stale item below a current one even when the stale one matches harder', async () => {
    const current = await createRaw('---\ntitle: Retry Budget Current\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: The current guidance.\nstale_after: 2999-01-01\n---\nRetry budget guidance, current.\n');
    // Deliberately the better lexical match: the term appears three times in the
    // body against once. Without the lifecycle policy this outranks `current`.
    const legacy = await createRaw('---\ntitle: Retry Budget Legacy\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: The old guidance.\nstale_after: 2020-01-01\n---\nRetry budget guidance, retry budget, retry budget.\n');

    const hits = (await query.search({ q: 'retry budget' }, admin)).results as unknown as {
      id: string;
      stale?: boolean;
      reasons?: string[];
    }[];
    const order = hits.map((h) => h.id);
    expect(order).toContain(current.id);
    expect(order).toContain(legacy.id);
    expect(order.indexOf(current.id)).toBeLessThan(order.indexOf(legacy.id));

    // The demotion is explained on the row, not applied invisibly.
    const demoted = hits.find((h) => h.id === legacy.id)!;
    expect(demoted.reasons?.some((r) => /stale/i.test(r))).toBe(true);
  });

  it('does not apply the lifecycle demotion under an explicit non-relevance sort', async () => {
    // `sort: 'recent'` is the caller asking for a specific order; silently
    // reordering it by lifecycle would override what they asked for.
    await createRaw('---\ntitle: Retry Budget Current\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: The current guidance.\nstale_after: 2999-01-01\n---\nRetry budget guidance, current.\n'.replace('Retry Budget Current', 'Sort Probe Current'));
    const legacy = await createRaw('---\ntitle: Retry Budget Legacy\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: The old guidance.\nstale_after: 2020-01-01\n---\nRetry budget guidance, retry budget, retry budget.\n'.replace('Retry Budget Legacy', 'Sort Probe Legacy'));

    const hits = (await query.search({ q: 'sort probe', sort: 'recent' }, admin)).results as unknown as {
      id: string;
      reasons?: string[];
    }[];
    const demoted = hits.find((h) => h.id === legacy.id);
    expect(demoted?.reasons?.some((r) => /score ×/.test(r))).toBeFalsy();
  });

  it('resolves an item by id and by slug with display-state signals', async () => {
    const fresh = await createRaw('---\ntitle: Fresh Concept\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\nstale_after: 2999-01-01\n---\nStill current.\n');
    const stale = await createRaw('---\ntitle: Stale Runbook\ntype: Runbook\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\nstale_after: 2020-01-01\n---\nPast its review date.\n');
    const draft = await createRaw('---\ntitle: Draft Note\ntype: Concept\n---\nNot published.\n');

    const byId = await query.item(fresh.id, admin);
    const bySlug = await query.item(fresh.slug, admin);
    expect(byId?.id).toBe(fresh.id);
    expect(bySlug?.id).toBe(fresh.id);
    // YAML dates are stored as ISO strings in frontmatter; the signal carries that string.
    expect(byId).toMatchObject({ display_state: 'published', lifecycle_status: 'stable', trust_tier: 'unverified', stale: false, stale_after: expect.stringContaining('2999-01-01') });

    expect(await query.item(stale.id, admin)).toMatchObject({ display_state: 'needs-review', stale: true, stale_after: expect.stringContaining('2020-01-01') });
    expect(await query.item(draft.id, admin)).toMatchObject({ display_state: 'draft', lifecycle_status: 'draft' });

    // Draft visibility is the existing rule: anonymous sees published only.
    expect(await query.item(draft.id, ANON)).toBeNull();
    expect((await query.item(fresh.slug, ANON))?.id).toBe(fresh.id);
    expect(await query.item('no-such-item', admin)).toBeNull();
  });

  it('derives superseded for a deprecated item with a successor', async () => {
    // E3 has no deprecated publication state, so an OKF `status: deprecated`
    // only arrives on a stored version (e.g. rebuilt from git); simulate that.
    const old = await createRaw('---\ntitle: Old Way\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nReplaced.\n');
    const db = app.get<Kysely<Database>>(KYSELY);
    await db
      .updateTable('page_versions')
      .set({ frontmatter_json: JSON.stringify({ title: 'Old Way', type: 'Concept', status: 'deprecated', superseded_by: 'new-way' }) })
      .where('id', '=', old.current_version_id)
      .execute();

    expect(await query.item(old.id, admin)).toMatchObject({ display_state: 'superseded', lifecycle_status: 'deprecated', superseded_by: 'new-way' });
  });

  it('lists topics with the anonymous visibility rule and a wiki presentation', async () => {
    await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Public Topic', slug: 'public-topic' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Secret Topic', slug: 'secret-topic', visibility: 'private' }).expect(201);

    const adminSlugs = (await query.topics(admin)).map((t) => t.slug);
    const anonSlugs = (await query.topics(ANON)).map((t) => t.slug);
    expect(adminSlugs).toEqual(expect.arrayContaining(['public-topic', 'secret-topic']));
    expect(anonSlugs).toContain('public-topic');
    expect(anonSlugs).not.toContain('secret-topic');

    expect(await query.topic('secret-topic', admin)).toMatchObject({ slug: 'secret-topic', visibility: 'private', presentation: 'wiki', counts: { items: 0, published: 0 } });
    expect(await query.topic('secret-topic', ANON)).toBeNull();
    expect(await query.topic('space_public-topic', admin)).toMatchObject({ slug: 'public-topic' });
  });

  it('filters curated sections by topic', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', cookie)
      .send({ sections: [{ name: 'Blog', type: 'blog-post', space: 'default' }, { name: 'FAQ', type: 'faq', space: 'other' }] })
      .expect(200);

    expect((await query.sections()).map((s) => s.slug)).toEqual(['blog', 'faq']);
    expect((await query.sections('default')).map((s) => s.slug)).toEqual(['blog']);
    expect(await query.sections('nowhere')).toEqual([]);
  });

  it('feeds published posts newest first with blog metadata', async () => {
    await createRaw('---\ntitle: Second Post\ntype: Blog Post\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\npublished_at: 2026-02-01T00:00:00.000Z\nauthors: [Ada, Grace]\nseries: launch\nseries_order: 2\ncover: assets/two.png\n---\n' + Array.from({ length: 450 }, () => 'word').join(' ') + '\n');
    await createRaw('---\ntitle: First Post\ntype: Blog Post\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\npublished_at: 2026-01-01T00:00:00.000Z\nauthor: Ada\nseries: launch\nseries_order: 1\n---\nShort.\n');
    await createRaw('---\ntitle: Third Post\ntype: Blog Post\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\npublished_at: 2026-03-01T00:00:00.000Z\nauthors: [Grace]\n---\nLatest.\n');
    await createRaw('---\ntitle: Unpublished Post\ntype: Blog Post\npublished_at: 2026-04-01T00:00:00.000Z\n---\nDraft, must not appear.\n');
    await createRaw('---\ntitle: Not A Post\ntype: FAQ\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nWrong type.\n');

    const page = await query.feed({ types: ['Blog Post'] }, admin);
    expect(page.items.map((e) => e.title)).toEqual(['Third Post', 'Second Post', 'First Post']);
    expect(page.total).toBe(3);
    expect(page.next_cursor).toBeNull();
    expect(page.items[1]).toMatchObject({
      authors: ['Ada', 'Grace'],
      cover: 'assets/two.png',
      series: 'launch',
      series_order: 2,
      reading_time_minutes: 2,
      display_state: 'published',
      published_at: '2026-02-01T00:00:00.000Z',
    });
    expect(page.items[2]).toMatchObject({ authors: ['Ada'], cover: null, series_order: 1, reading_time_minutes: 1 });

    // A series request is reading order (`series_order` asc), not newest first.
    const series = await query.feed({ series: 'launch', author: 'Ada' }, admin);
    expect(series.items.map((e) => e.title)).toEqual(['First Post', 'Second Post']);

    const first = await query.feed({ types: ['Blog Post'], limit: 2 }, admin);
    expect(first.items.map((e) => e.title)).toEqual(['Third Post', 'Second Post']);
    expect(first.next_cursor).toBe('2');
    const rest = await query.feed({ types: ['Blog Post'], limit: 2, cursor: first.next_cursor! }, admin);
    expect(rest.items.map((e) => e.title)).toEqual(['First Post']);
    expect(rest.next_cursor).toBeNull();
  });

  it('groups search hits by content type with a per-group cap and keeps the flat result set', async () => {
    for (let i = 1; i <= 7; i++) {
      await createRaw(`---\ntitle: Zebracorn FAQ ${i}\ntype: FAQ\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nAbout the zebracorn.\n`);
    }
    await createRaw('---\ntitle: Zebracorn Concept\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nThe zebracorn concept.\n');

    const result = await query.search({ q: 'zebracorn', limit: 50 }, admin);
    expect(result.results).toHaveLength(8);
    expect(result.total).toBe(8);
    expect(result.facets).toBeDefined();
    expect(result.warnings).toEqual([]);
    const faq = result.groups.find((g) => g.key === 'FAQ');
    expect(faq).toMatchObject({ label: 'FAQ', total: 7 });
    expect(faq!.hits).toHaveLength(5);
    expect(result.groups.find((g) => g.key === 'Concept')).toMatchObject({ total: 1 });
    // Groups reference the same hit objects as the flat list.
    expect(result.results).toContain(faq!.hits[0]);
  });

  it("applies the draft-visibility rule to search: others' drafts only when asked for and admin", async () => {
    const alice = await seedUserAndLogin(app);
    await createRaw('---\ntitle: Hidden Quokka\n---\nquokka draft body.\n', alice.cookie);
    await createRaw(`---\ntitle: Visible Quokka\nstatus: published\n${CONFORMANT_YAML}---\nquokka published body.\n`);

    const plain = await query.search({ q: 'quokka' }, admin);
    expect(plain.results.map((h) => h.title)).toEqual(['Visible Quokka']);
    const withDrafts = await query.search({ q: 'quokka', include_drafts: true }, admin);
    expect(withDrafts.results.map((h) => h.title).sort()).toEqual(['Hidden Quokka', 'Visible Quokka']);
    const anon = await query.search({ q: 'quokka', include_drafts: true }, ANON);
    expect(anon.results.map((h) => h.title)).toEqual(['Visible Quokka']);
  });

  it('returns related items from inbound wiki-links', async () => {
    const target = await createRaw('---\ntitle: Link Target\ntype: Concept\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nTarget body.\n');
    const source = await createRaw('---\ntitle: Link Source\ntype: How-To\nstatus: published\ncategories: [guides]\ndescription: A published fixture.\n---\nSee [[Link Target]] for details.\n');
    await createRaw(`---\ntitle: Unrelated\nstatus: published\n${CONFORMANT_YAML}---\nNo links here.\n`);

    const related = await query.related(target.id, admin);
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ id: source.id, slug: source.slug, title: 'Link Source', status: 'published', type: 'How-To', display_state: 'published' });
    expect(await query.related('no-such-item', admin)).toEqual([]);
  });

  it('lists published items changed since a timestamp, oldest first', async () => {
    const older = await createRaw(`---\ntitle: Older Change\nstatus: published\n${CONFORMANT_YAML}---\nA.\n`);
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createRaw(`---\ntitle: Newer Change\nstatus: published\n${CONFORMANT_YAML}---\nB.\n`);
    await createRaw('---\ntitle: Draft Change\n---\nC.\n');

    const all = await query.changedSince(older.updated_at, admin);
    expect(all.items.map((i) => i.id)).toEqual([older.id, newer.id]);
    expect(all.total).toBe(2);
    const later = await query.changedSince(newer.updated_at, admin);
    expect(later.items.map((i) => i.id)).toEqual([newer.id]);
  });
});
