/**
 * Content health e2e (plan §6.3): the admin queue view built from the existing
 * OKF audit plus E3-level work queues derived from frontmatter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { lifecycleColumnsFrom } from '../src/pages/lifecycle-columns.js';
import { PagesService } from '../src/pages/pages.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { MIRROR_STUCK_MS } from '../src/content-health/mirror-health.js';

describe('content health (/admin/health/content) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let pages: PagesService;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    pages = app.get(PagesService);
    db = app.get<Kysely<Database>>(KYSELY);

    const human = { verified: [{ by: 'human:eric', at: '2026-01-01T00:00:00.000Z' }] };
    // Healthy: typed, categorized, human-verified, fresh — in no queue.
    await pages.create(adminId, { title: 'Healthy', body: 'x', status: 'published', frontmatter: { type: 'Concept', categories: ['guides'], ...human } });
    // untyped
    await pages.create(adminId, { title: 'No Type', body: 'x', status: 'published', frontmatter: { categories: ['guides'], ...human } });
    // uncategorized (the only item without a primary category)
    await pages.create(adminId, { title: 'No Category', body: 'x', status: 'published', frontmatter: { type: 'Concept', ...human } });
    // stale, in its own Topic so the topic filter has something to isolate
    await pages.create(adminId, { title: 'Stale Runbook', body: 'x', status: 'published', frontmatter: { type: 'Runbook', topic: 'Ops', categories: ['guides'], stale_after: '2020-01-01', ...human } });
    // machine-generated and never verified
    await pages.create(adminId, { title: 'Bot Draft', body: 'x', status: 'published', frontmatter: { type: 'Concept', categories: ['guides'], generated: { by: 'process:importer', at: '2026-01-01T00:00:00.000Z' } } });
    // deprecated with no successor: E3 has no deprecated publication state, so it
    // only arrives on a stored version (e.g. rebuilt from git); simulate that,
    // including the lifecycle columns a rebuild indexes from it.
    const old = await pages.create(adminId, { title: 'Old Way', body: 'x', status: 'published', frontmatter: { type: 'Concept', categories: ['guides'], ...human } });
    const oldWay = { title: 'Old Way', type: 'Concept', status: 'deprecated', categories: ['guides'], ...human };
    await db
      .updateTable('page_versions')
      .set({ frontmatter_json: JSON.stringify(oldWay) })
      .where('id', '=', old.current_version_id!)
      .execute();
    await db.updateTable('pages').set(lifecycleColumnsFrom(oldWay, 'published')).where('id', '=', old.id).execute();
    // a draft untouched for 40 days
    const draft = await pages.create(adminId, { title: 'Forgotten Draft', body: 'x', status: 'draft', frontmatter: { type: 'Concept', categories: ['guides'], ...human } });
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await db.updateTable('pages').set({ updated_at: fortyDaysAgo }).where('id', '=', draft.id).execute();
    // a fresh draft, not old enough to queue
    await pages.create(adminId, { title: 'Fresh Draft', body: 'x', status: 'draft', frontmatter: { type: 'Concept', categories: ['guides'], ...human } });
  });
  afterEach(async () => app.close());

  it('reports totals, audit counts, signals, and one item per queue', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);

    expect(res.body.totals).toEqual({ items: 8, published: 6, drafts: 2 });
    expect(typeof res.body.audit.conformant).toBe('boolean');
    expect(typeof res.body.audit.conformance).toBe('number');
    expect(typeof res.body.audit.policy).toBe('number');
    expect(typeof res.body.audit.advisories).toBe('number');
    expect(res.body.signals.total).toBeGreaterThan(0);
    expect(res.body.signals.byTrustTier).toBeDefined();
    // Git-mirror durability (issue 88) rides along with the report; nothing is
    // stuck here, so both halves are empty — see outbox-health.e2e.test.ts.
    expect(res.body.mirror).toEqual({
      stuck_after_ms: MIRROR_STUCK_MS,
      pending: { count: 0, items: [] },
      mirror_errors: { count: 0, items: [] },
    });

    const q = res.body.queues;
    const names = (queue: { items: { title: string }[] }) => queue.items.map((i) => i.title);
    expect(q.untyped.count).toBe(1);
    expect(names(q.untyped)).toEqual(['No Type']);
    expect(q.uncategorized.count).toBe(1);
    expect(names(q.uncategorized)).toEqual(['No Category']);
    expect(q.stale.count).toBe(1);
    expect(names(q.stale)).toEqual(['Stale Runbook']);
    expect(q.superseded_without_successor.count).toBe(1);
    expect(names(q.superseded_without_successor)).toEqual(['Old Way']);
    expect(q.machine_unverified.count).toBe(1);
    expect(names(q.machine_unverified)).toEqual(['Bot Draft']);
    expect(q.drafts_older_than_30d.count).toBe(1);
    expect(names(q.drafts_older_than_30d)).toEqual(['Forgotten Draft']);

    // Queue members are item summaries with the derived signals attached.
    expect(q.stale.items[0]).toMatchObject({ slug: 'stale-runbook', type: 'Runbook', display_state: 'needs-review', stale: true });
  });

  it('narrows to a Topic', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/health/content?topic=ops').set('Cookie', cookie).expect(200);
    expect(res.body.totals).toEqual({ items: 1, published: 1, drafts: 0 });
    expect(res.body.queues.stale.count).toBe(1);
    expect(res.body.queues.untyped.count).toBe(0);
    expect(res.body.signals.total).toBe(1);
  });

  it('pages one queue past the report with offset, limit and total', async () => {
    // Twelve more untyped items, so the Untyped queue holds 13.
    for (let n = 0; n < 12; n++) {
      await pages.create(adminId, { title: `Untyped ${String(n).padStart(2, '0')}`, body: 'x', status: 'published', frontmatter: { categories: ['guides'] } });
    }
    const get = (query: string) =>
      request(app.getHttpServer()).get(`/api/v1/admin/health/content/queues/untyped${query}`).set('Cookie', cookie);

    const first = await get('?limit=5').expect(200);
    expect(first.body).toMatchObject({ queue: 'untyped', count: 13, total: 13, offset: 0, limit: 5 });
    expect(first.body.items).toHaveLength(5);

    const last = await get('?limit=5&offset=10').expect(200);
    expect(last.body).toMatchObject({ total: 13, offset: 10, limit: 5 });
    expect(last.body.items).toHaveLength(3);

    // The pages partition the queue: no member twice, none missing.
    const middle = await get('?limit=5&offset=5').expect(200);
    const ids = [...first.body.items, ...middle.body.items, ...last.body.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(13);

    // Past the end is an empty page, not an error; the default limit is the report's 50.
    const past = await get('?offset=40').expect(200);
    expect(past.body).toMatchObject({ total: 13, offset: 40, limit: 50, items: [] });

    // The same members the report counts, and the topic filter applies.
    const report = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);
    expect(report.body.queues.untyped.count).toBe(13);
    const scoped = await request(app.getHttpServer()).get('/api/v1/admin/health/content/queues/stale?topic=ops').set('Cookie', cookie).expect(200);
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.items[0]).toMatchObject({ slug: 'stale-runbook' });
  });

  it('rejects a malformed page or an unknown queue', async () => {
    const get = (path: string) => request(app.getHttpServer()).get(`/api/v1/admin/health/content/queues/${path}`).set('Cookie', cookie);
    await get('untyped?offset=-1').expect(400);
    await get('untyped?offset=abc').expect(400);
    await get('untyped?limit=0').expect(400);
    await get('untyped?limit=2.5').expect(400);
    await get('untyped?limit=201').expect(400);
    await get('untyped?limit=200').expect(200);
    await get('no_such_queue').expect(404);
  });

  it('is admin-only', async () => {
    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', alice.cookie).expect(403);
    await request(app.getHttpServer()).get('/api/v1/admin/health/content').expect(401);
    await request(app.getHttpServer()).get('/api/v1/admin/health/content/queues/untyped').set('Cookie', alice.cookie).expect(403);
    await request(app.getHttpServer()).get('/api/v1/admin/health/content/queues/untyped').expect(401);
  });
});
