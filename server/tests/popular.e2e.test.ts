/**
 * `GET /popular` (home plan R3): the most-read published items in a window,
 * site-wide or in one topic, counted as DISTINCT signed-in readers.
 *
 * The load-bearing cases are the ones a naive `COUNT(*)` over `page_views`
 * would get wrong: one reader opening an item ten times is one reader, a view
 * from last year is not this month's popularity, a draft is never popular, and
 * a private topic's item must not rank for an anonymous visitor while still
 * ranking for the signed-in readers who can open it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { conformant, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { newId } from '../src/common/ids.js';

describe('popular e2e', () => {
  let app: INestApplication;
  let admin: string;
  let readers: string[];
  let db: Kysely<Database>;

  const http = () => request(app.getHttpServer());

  async function seed(title: string, fm: Record<string, unknown>, status: 'published' | 'draft' = 'published'): Promise<string> {
    const res = await http()
      .post('/api/v1/pages')
      .set('Cookie', admin)
      // Conformant, so a published fixture passes the publish gate (issue 98).
      .send({ title, body: 'Some words here.', status, frontmatter: conformant(fm) })
      .expect(201);
    return res.body.page.id as string;
  }

  /** One page-view event per cookie, through the real telemetry endpoint. */
  async function view(pageId: string, cookies: string[]) {
    for (const c of cookies) {
      await http().post('/api/v1/events/page-view').set('Cookie', c).send({ page_id: pageId }).expect(204);
    }
  }

  const titles = (res: request.Response) => res.body.items.map((i: { title: string }) => i.title);

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: admin } = await seedAdminAndLogin(app));
    readers = [];
    for (const name of ['ann', 'ben', 'cat', 'dan']) {
      readers.push((await seedUserAndLogin(app, name, `${name}-password-123`)).cookie);
    }
    db = app.get<Kysely<Database>>(KYSELY);
    await curateCategories(app);
    await http().post('/api/v1/topics').set('Cookie', admin).send({ name: 'Alpha', slug: 'alpha' }).expect(201);
    await http().post('/api/v1/topics').set('Cookie', admin).send({ name: 'Beta', slug: 'beta' }).expect(201);
    await http().post('/api/v1/topics').set('Cookie', admin).send({ name: 'Secret', slug: 'secret', visibility: 'private' }).expect(201);
  });
  afterEach(async () => app.close());

  it('counts distinct readers once each and orders by readers, then newest publish date', async () => {
    const one = await seed('One Reader', { topic: 'alpha', published_at: '2026-01-01T00:00:00.000Z' });
    const three = await seed('Three Readers', { topic: 'alpha', published_at: '2026-01-02T00:00:00.000Z' });
    const twoOld = await seed('Two Readers Older', { topic: 'beta', published_at: '2026-01-03T00:00:00.000Z' });
    const twoNew = await seed('Two Readers Newer', { topic: 'beta', published_at: '2026-01-04T00:00:00.000Z' });

    // Ann opens "One Reader" five times: still one reader.
    await view(one, [readers[0]!, readers[0]!, readers[0]!, readers[0]!, readers[0]!]);
    await view(three, [readers[0]!, readers[1]!, readers[2]!, readers[2]!]);
    await view(twoOld, [readers[0]!, readers[1]!]);
    await view(twoNew, [readers[2]!, readers[3]!]);

    const res = await http().get('/api/v1/popular').expect(200);
    expect(res.body.window_days).toBe(30);
    expect(titles(res)).toEqual(['Three Readers', 'Two Readers Newer', 'Two Readers Older', 'One Reader']);
    expect(res.body.items.map((i: { views: number }) => i.views)).toEqual([3, 2, 2, 1]);

    // Shaped as a feed entry, with the topic filled in, and never who read it.
    const top = res.body.items[0];
    expect(top).toMatchObject({ slug: 'three-readers', topic: 'alpha', topic_name: 'Alpha', reading_time_minutes: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/user_id|"ann"|"ben"/);
  });

  it('excludes items with no views, and views outside the window', async () => {
    const fresh = await seed('Fresh', { topic: 'alpha' });
    const stale = await seed('Stale', { topic: 'alpha' });
    await seed('Never Opened', { topic: 'alpha' });
    await view(fresh, [readers[0]!]);
    // Forty days ago, written directly: the telemetry endpoint only records "now".
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const users = await db.selectFrom('users').select('id').where('role', '=', 'user').execute();
    for (const u of users) {
      await db.insertInto('page_views').values({ id: newId(), page_id: stale, user_id: u.id, session_id: null, viewed_at: old, dwell_ms: null }).execute();
    }

    expect(titles(await http().get('/api/v1/popular').expect(200))).toEqual(['Fresh']);
    const wide = await http().get('/api/v1/popular?days=60').expect(200);
    expect(wide.body.window_days).toBe(60);
    expect(titles(wide)).toEqual(['Stale', 'Fresh']);
  });

  it('filters to one topic by slug', async () => {
    const a = await seed('Alpha Item', { topic: 'alpha' });
    const b = await seed('Beta Item', { topic: 'beta' });
    await view(a, [readers[0]!]);
    await view(b, [readers[0]!, readers[1]!]);

    expect(titles(await http().get('/api/v1/popular?topic=alpha').expect(200))).toEqual(['Alpha Item']);
    expect(titles(await http().get('/api/v1/popular?topic=beta').expect(200))).toEqual(['Beta Item']);
    expect(titles(await http().get('/api/v1/popular?topic=no-such-topic').expect(200))).toEqual([]);
  });

  it('never ranks a draft or a deleted item', async () => {
    const pub = await seed('Published', { topic: 'alpha' });
    const later = await seed('Later Unpublished', { topic: 'alpha' });
    const gone = await seed('Deleted', { topic: 'alpha' });
    await view(pub, [readers[0]!]);
    await view(later, [readers[0]!, readers[1]!]);
    await view(gone, [readers[0]!, readers[1]!, readers[2]!]);
    // Views recorded while published; the item is then a draft or deleted.
    await db.updateTable('pages').set({ status: 'draft' }).where('id', '=', later).execute();
    await db.updateTable('pages').set({ deleted_at: new Date().toISOString() }).where('id', '=', gone).execute();

    expect(titles(await http().get('/api/v1/popular').expect(200))).toEqual(['Published']);
    // Not even for an admin, who may read drafts everywhere else.
    expect(titles(await http().get('/api/v1/popular').set('Cookie', admin).expect(200))).toEqual(['Published']);
  });

  it('hides a private topic from anonymous visitors but not from signed-in readers or admins', async () => {
    const open = await seed('Open Item', { topic: 'alpha' });
    const secret = await seed('Secret Item', { topic: 'secret' });
    await view(open, [readers[0]!]);
    await view(secret, [readers[0]!, readers[1]!, readers[2]!]);

    const anon = await http().get('/api/v1/popular').expect(200);
    expect(titles(anon)).toEqual(['Open Item']);
    expect(JSON.stringify(anon.body)).not.toContain('Secret');
    expect(titles(await http().get('/api/v1/popular?topic=secret').expect(200))).toEqual([]);

    // Hidden items do not eat the limit: the anonymous list still fills from what it may see.
    expect(titles(await http().get('/api/v1/popular?limit=1').expect(200))).toEqual(['Open Item']);

    expect(titles(await http().get('/api/v1/popular').set('Cookie', readers[3]!).expect(200))).toEqual(['Secret Item', 'Open Item']);
    const asAdmin = await http().get('/api/v1/popular?topic=secret').set('Cookie', admin).expect(200);
    expect(asAdmin.body.items[0]).toMatchObject({ title: 'Secret Item', views: 3, topic: 'secret', topic_name: 'Secret' });
  });

  it('defaults limit to 5, caps limit at 20 and days at 365, and rejects garbage', async () => {
    for (let i = 0; i < 22; i++) {
      const id = await seed(`Item ${String(i).padStart(2, '0')}`, { topic: 'alpha' });
      await view(id, [readers[0]!]);
    }
    expect((await http().get('/api/v1/popular').expect(200)).body.items).toHaveLength(5);
    expect((await http().get('/api/v1/popular?limit=3').expect(200)).body.items).toHaveLength(3);
    expect((await http().get('/api/v1/popular?limit=500').expect(200)).body.items).toHaveLength(20);
    expect((await http().get('/api/v1/popular?days=9999').expect(200)).body.window_days).toBe(365);

    for (const bad of ['limit=0', 'limit=-1', 'limit=abc', 'limit=2.5', 'limit=5x', 'days=0', 'days=soon', 'limit=1&limit=2']) {
      await http().get(`/api/v1/popular?${bad}`).expect(400);
    }
  });
});
