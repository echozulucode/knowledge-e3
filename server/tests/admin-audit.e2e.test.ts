import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * Plan §6 D1 — the audit read surface.
 *
 * Before this endpoint the only way to answer "who changed this?" was SQL
 * against the SQLite file: `AuditService.list()` existed with zero callers.
 */
describe('GET /admin/audit', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });
  afterEach(async () => app.close());

  /** Write a row straight to the table so a test owns its own timeline. */
  async function seedRow(row: {
    occurred_at: string;
    actor_id?: string | null;
    action: string;
    page_id?: string | null;
    payload?: unknown;
  }): Promise<void> {
    await db
      .insertInto('audit_log')
      .values({
        occurred_at: row.occurred_at,
        actor_id: row.actor_id ?? null,
        action: row.action,
        page_id: row.page_id ?? null,
        version_id: null,
        payload_json: row.payload === undefined ? null : JSON.stringify(row.payload),
      })
      .execute();
  }

  async function fetchAudit(query = '', as = cookie): Promise<{ status: number; body: any }> {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/audit${query}`)
      .set('Cookie', as);
    return { status: res.status, body: res.body };
  }

  describe('authorization', () => {
    it('a non-admin gets no audit data', async () => {
      const { cookie: userCookie } = await seedUserAndLogin(app, 'mallory');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/audit')
        .set('Cookie', userCookie)
        .expect(403);
      // Not merely "no entries" — nothing about the log may reach a non-admin.
      expect(JSON.stringify(res.body)).not.toContain('auth.login');
      expect(res.body.entries).toBeUndefined();
    });

    it('an anonymous caller gets no audit data', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/audit').expect(401);
    });

    it('a read-scoped personal access token belonging to an admin is still admin', async () => {
      // Guards the inverse mistake: the endpoint must not become unreachable to
      // the admin's own tooling. A read token may read; the class-level
      // @AdminOnly is what decides, not the credential shape.
      const created = await request(app.getHttpServer())
        .post('/api/v1/me/tokens')
        .set('Cookie', cookie)
        .send({ name: 'audit-reader', scope: 'read', expires_in_days: 30 })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${created.body.token}`)
        .expect(200);
    });
  });

  describe('filters', () => {
    beforeEach(async () => {
      await seedRow({ occurred_at: '2026-01-01T00:00:00.000Z', actor_id: adminId, action: 'page.create', page_id: 'p1' });
      await seedRow({ occurred_at: '2026-02-01T00:00:00.000Z', actor_id: adminId, action: 'page.update', page_id: 'p1' });
      await seedRow({ occurred_at: '2026-03-01T00:00:00.000Z', actor_id: null, action: 'auth.login_failed' });
      await seedRow({ occurred_at: '2026-04-01T00:00:00.000Z', actor_id: adminId, action: 'page.update', page_id: 'p2' });
    });

    it('returns newest first', async () => {
      const { body } = await fetchAudit();
      const stamps = body.entries.map((e: any) => e.occurred_at);
      expect([...stamps]).toEqual([...stamps].sort().reverse());
    });

    it('filters by target item — "who changed this item"', async () => {
      const { body } = await fetchAudit('?page_id=p1');
      expect(body.entries).toHaveLength(2);
      expect(body.entries.every((e: any) => e.page_id === 'p1')).toBe(true);
    });

    it('filters by action', async () => {
      const { body } = await fetchAudit('?action=page.update');
      expect(body.entries.map((e: any) => e.page_id)).toEqual(['p2', 'p1']);
    });

    it('filters by actor, by id and by username — "what did this user do"', async () => {
      const byId = await fetchAudit(`?actor=${adminId}`);
      const byName = await fetchAudit('?actor=admin');
      expect(byId.body.entries.length).toBe(byName.body.entries.length);
      expect(byId.body.entries.every((e: any) => e.actor_id === adminId)).toBe(true);
      // The sign-in failure has no actor and must not be attributed to anyone.
      expect(byId.body.entries.some((e: any) => e.action === 'auth.login_failed')).toBe(false);
    });

    it('filters by date range — "what happened in this window"', async () => {
      const { body } = await fetchAudit('?since=2026-02-01&until=2026-03-01');
      expect(body.entries.map((e: any) => e.action)).toEqual(['auth.login_failed', 'page.update']);
    });

    it('a bare `until` date includes that whole day', async () => {
      const { body } = await fetchAudit('?since=2026-03-01&until=2026-03-01');
      expect(body.entries.map((e: any) => e.action)).toEqual(['auth.login_failed']);
    });

    it('rejects an unparseable date rather than silently ignoring it', async () => {
      const { status } = await fetchAudit('?since=last%20tuesday');
      expect(status).toBe(400);
    });

    it('an actor nobody matches returns nothing, not everything', async () => {
      const { body } = await fetchAudit('?actor=nobody-at-all');
      expect(body.entries).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });

    it('the empty case is an empty page, not an error', async () => {
      const { status, body } = await fetchAudit('?action=page.create&page_id=p2');
      expect(status).toBe(200);
      expect(body.entries).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });

    it('offers the action strings the log actually contains', async () => {
      const { body } = await fetchAudit();
      expect(body.actions).toContain('page.update');
      expect(body.actions).toContain('auth.login_failed');
      expect([...body.actions]).toEqual([...body.actions].sort());
    });

    it('paginates newest-first without dropping or repeating a row', async () => {
      const first = await fetchAudit('?limit=2');
      expect(first.body.entries).toHaveLength(2);
      expect(first.body.next_cursor).toBeTruthy();
      const second = await fetchAudit(`?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
      const ids = [...first.body.entries, ...second.body.entries].map((e: any) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      const all = await fetchAudit('?limit=200');
      expect(ids).toEqual(all.body.entries.slice(0, ids.length).map((e: any) => e.id));
    });
  });

  describe('subject — the account or thing a row acted on', () => {
    let bobId: string;

    beforeEach(async () => {
      ({ userId: bobId } = await seedUserAndLogin(app, 'bob'));
      // The admin acted ON bob in several ways, with the payload shapes the
      // server writes (auth.service.ts, users.controller.ts, tokens.controller.ts).
      await seedRow({ occurred_at: '2026-05-01T00:00:00.000Z', actor_id: adminId, action: 'user.role_change', payload: { user_id: bobId, username: 'bob', from: 'user', to: 'admin' } });
      // An older password reset, written before the payload carried a username.
      await seedRow({ occurred_at: '2026-05-02T00:00:00.000Z', actor_id: adminId, action: 'user.password_reset', payload: { user_id: bobId } });
      await seedRow({ occurred_at: '2026-05-03T00:00:00.000Z', actor_id: null, action: 'auth.login_failed', payload: { username_attempted: 'bob', ip: '10.0.0.9', throttled: false } });
      await seedRow({ occurred_at: '2026-05-04T00:00:00.000Z', actor_id: adminId, action: 'token.revoke', payload: { id: 'tok-1', token_name: 'ci-bot', owner_username: 'Bob', self: false } });
      // Bob ACTING is not bob being acted on.
      await seedRow({ occurred_at: '2026-05-05T00:00:00.000Z', actor_id: bobId, action: 'auth.logout', payload: { ip: '10.0.0.9' } });
      // Someone else, and a row whose payload is not JSON at all.
      await seedRow({ occurred_at: '2026-05-06T00:00:00.000Z', actor_id: adminId, action: 'user.disable', payload: { user_id: 'someone-else', username: 'carol', disabled: true } });
      await db
        .insertInto('audit_log')
        .values({ occurred_at: '2026-05-07T00:00:00.000Z', actor_id: null, action: 'legacy.text', page_id: null, version_id: null, payload_json: 'not json {' })
        .execute();
    });

    const actionsOf = (body: any) => body.entries.map((e: any) => e.action);

    it('matches payload user ids and usernames alike, case-insensitively, and never the actor', async () => {
      const expected = ['token.revoke', 'auth.login_failed', 'user.password_reset', 'user.role_change'];
      const byName = await fetchAudit('?subject=bob');
      expect(byName.status).toBe(200);
      expect(actionsOf(byName.body)).toEqual(expected);
      // By id: the old reset row names bob only by id, the failed sign-in only by name —
      // both still match because the id resolves to the account.
      expect(actionsOf((await fetchAudit(`?subject=${bobId}`)).body)).toEqual(expected);
      expect(actionsOf((await fetchAudit('?subject=BOB')).body)).toEqual(expected);
    });

    it('matches a name that has no account (only ever typed at the login form)', async () => {
      await seedRow({ occurred_at: '2026-05-08T00:00:00.000Z', actor_id: null, action: 'auth.login_failed', payload: { username_attempted: 'ghost', ip: null, throttled: false } });
      expect(actionsOf((await fetchAudit('?subject=ghost')).body)).toEqual(['auth.login_failed']);
    });

    it('matches a thing by its id (a token, a source)', async () => {
      expect(actionsOf((await fetchAudit('?subject=tok-1')).body)).toEqual(['token.revoke']);
    });

    it('combines with the other filters, and a subject nobody matches is empty', async () => {
      expect(actionsOf((await fetchAudit('?subject=bob&action=user.role_change')).body)).toEqual(['user.role_change']);
      expect(actionsOf((await fetchAudit('?subject=bob&actor=bob')).body)).toEqual([]);
      const none = await fetchAudit('?subject=nobody-at-all');
      expect(none.body.entries).toEqual([]);
      expect(none.body.next_cursor).toBeNull();
    });

    it('pages a subject result with the same cursor, without dropping or repeating a row', async () => {
      const first = await fetchAudit('?subject=bob&limit=3');
      expect(first.body.entries).toHaveLength(3);
      expect(first.body.next_cursor).toBeTruthy();
      const second = await fetchAudit(`?subject=bob&limit=3&cursor=${encodeURIComponent(first.body.next_cursor)}`);
      expect(second.body.next_cursor).toBeNull();
      expect([...actionsOf(first.body), ...actionsOf(second.body)]).toEqual(actionsOf((await fetchAudit('?subject=bob')).body));
    });

    it('a non-admin cannot use it, and an anonymous caller cannot either', async () => {
      const { cookie: userCookie } = await seedUserAndLogin(app, 'mallory');
      const res = await fetchAudit('?subject=bob', userCookie);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('bob');
      await request(app.getHttpServer()).get('/api/v1/admin/audit?subject=bob').expect(401);
    });
  });

  describe('one entry by id and exact date bounds', () => {
    beforeEach(async () => {
      await seedRow({ occurred_at: '2026-06-01T10:00:00.000Z', actor_id: adminId, action: 'page.create', page_id: 'p9' });
      await seedRow({ occurred_at: '2026-06-01T12:00:00.000Z', actor_id: adminId, action: 'page.update', page_id: 'p9' });
    });

    it('`entry` returns exactly that row, and a malformed id is a 400', async () => {
      const all = await fetchAudit('?page_id=p9');
      const target = all.body.entries.find((e: any) => e.action === 'page.create');
      const one = await fetchAudit(`?entry=${target.id}`);
      expect(one.body.entries.map((e: any) => e.id)).toEqual([target.id]);
      expect((await fetchAudit('?entry=abc')).status).toBe(400);
      expect((await fetchAudit('?entry=999999')).body.entries).toEqual([]);
    });

    it('an instant `since` is inclusive and an instant `until` is exclusive', async () => {
      // What the page sends: local-day starts converted to UTC instants.
      const inclusive = await fetchAudit('?page_id=p9&since=2026-06-01T10:00:00.000Z&until=2026-06-01T12:00:00.000Z');
      expect(inclusive.body.entries.map((e: any) => e.action)).toEqual(['page.create']);
      const both = await fetchAudit('?page_id=p9&since=2026-06-01T10:00:00.000Z&until=2026-06-01T12:00:00.001Z');
      expect(both.body.entries.map((e: any) => e.action)).toEqual(['page.update', 'page.create']);
    });
  });

  it('resolves the actor and the target so a row can link back to the item', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Linkable', body: 'body', status: 'draft' })
      .expect(201);
    const { body } = await fetchAudit('?action=page.create');
    const row = body.entries[0];
    expect(row.page_id).toBe(created.body.page.id);
    expect(row.page_slug).toBe(created.body.page.slug);
    expect(row.page_title).toBe('Linkable');
    expect(row.actor_username).toBe('admin');
  });
});
