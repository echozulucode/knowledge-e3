import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Kysely, sql } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { generateLargeLibrary, LARGE_LIBRARY_MARKER, seedLargeLibrary } from '../bench/large-library.js';

describe('large-library deterministic seed harness', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });

  afterEach(async () => app.close());

  it('generates deterministic realistic item records without using Math.random', () => {
    const first = generateLargeLibrary({ count: 12, seed: 1234, bodyParagraphs: 3 });
    const second = generateLargeLibrary({ count: 12, seed: 1234, bodyParagraphs: 3 });
    const different = generateLargeLibrary({ count: 12, seed: 5678, bodyParagraphs: 3 });

    expect(first).toEqual(second);
    expect(first.map((item) => item.id)).toEqual([...new Set(first.map((item) => item.id))]);
    expect(first[0]).toMatchObject({
      id: 'scale_page_000001',
      status: 'draft',
      topic: { name: 'Product Strategy' },
    });
    expect(first[0]!.raw).toContain(LARGE_LIBRARY_MARKER);
    expect(first[0]!.body.length).toBeGreaterThan(1_000);
    expect(first.some((item, idx) => item.tags.join(',') !== different[idx]!.tags.join(','))).toBe(true);
  });

  it('loads repeatable scale rows across topics, tags, statuses, categories, groups, and FTS', async () => {
    const result = await seedLargeLibrary(db, userId, { count: 150, seed: 2468, bodyParagraphs: 4 });
    expect(result).toMatchObject({ pages: 150, topics: 24, categories: 12, groups: 16, marker: LARGE_LIBRARY_MARKER });

    const pageCount = await db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('count')).where('id', 'like', 'scale_page_%').executeTakeFirstOrThrow();
    const draftCount = await db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('count')).where('id', 'like', 'scale_page_%').where('status', '=', 'draft').executeTakeFirstOrThrow();
    const topicCount = await db.selectFrom('spaces').select((eb) => eb.fn.countAll<number>().as('count')).where('id', 'like', 'scale_topic_%').executeTakeFirstOrThrow();
    const tagCount = await db.selectFrom('page_tags').select((eb) => eb.fn.countAll<number>().as('count')).where('page_id', 'like', 'scale_page_%').executeTakeFirstOrThrow();
    const fts = await sql<{ count: number }>`SELECT count(*) AS count FROM pages_fts WHERE body LIKE ${`%${LARGE_LIBRARY_MARKER}%`}`.execute(db);

    expect(Number(pageCount.count)).toBe(150);
    expect(Number(draftCount.count)).toBeGreaterThan(0);
    expect(Number(topicCount.count)).toBe(24);
    expect(Number(tagCount.count)).toBeGreaterThan(300);
    expect(Number(fts.rows[0]?.count ?? 0)).toBeGreaterThan(100);

    await seedLargeLibrary(db, userId, { count: 25, seed: 2468, bodyParagraphs: 2 });
    const reloadedCount = await db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('count')).where('id', 'like', 'scale_page_%').executeTakeFirstOrThrow();
    expect(Number(reloadedCount.count)).toBe(25);
  });

  it('keeps server/API and MCP smoke paths usable on a large local corpus', async () => {
    await seedLargeLibrary(db, userId, { count: 300, seed: 1357, bodyParagraphs: 4 });

    const browse = await timed('initial browse', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/items?limit=50').set('Cookie', cookie).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });
    const topics = await timed('topic drawer', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
      expect(res.body.topics.length).toBeGreaterThanOrEqual(24);
    });
    const search = await timed('search', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/search?q=${encodeURIComponent(LARGE_LIBRARY_MARKER)}&limit=25`).set('Cookie', cookie).expect(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });
    const itemOpen = await timed('item open', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/items/scale_page_000001').set('Cookie', cookie).expect(200);
      expect(res.body.item.title).toContain('Product Strategy');
    });
    const createEdit = await timed('create/edit', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/items')
        .set('Cookie', cookie)
        .send({ title: 'Scale Harness Create Edit Smoke', body: 'Created during smoke.', status: 'draft', tags: ['scale-test'] })
        .expect(201);
      await request(app.getHttpServer())
        .put(`/api/v1/items/${created.body.item.id}`)
        .set('Cookie', cookie)
        .set('If-Match', String(created.body.item.version_token))
        .send({ body: 'Edited during smoke.' })
        .expect(200);
    });
    const mcpSearch = await timed('mcp search', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/mcp/jsonrpc')
        .set('Cookie', cookie)
        .send({ jsonrpc: '2.0', id: 'scale', method: 'tools/call', params: { name: 'knowledge.search', arguments: { q: LARGE_LIBRARY_MARKER, limit: 10 } } })
        .expect(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.results.length).toBeGreaterThan(0);
    });

    const timings = { browse, topics, search, itemOpen, createEdit, mcpSearch };
    // Generous CI/local smoke budgets: these catch pathological regressions while
    // avoiding flaky microbenchmark assumptions on shared runners.
    expect(timings.browse).toBeLessThan(1_500);
    expect(timings.topics).toBeLessThan(1_000);
    expect(timings.search).toBeLessThan(1_500);
    expect(timings.itemOpen).toBeLessThan(1_000);
    expect(timings.createEdit).toBeLessThan(1_500);
    expect(timings.mcpSearch).toBeLessThan(1_500);
  });
});

async function timed(_name: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
