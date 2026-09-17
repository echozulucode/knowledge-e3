/**
 * Personal access tokens e2e.
 *
 * Contract pinned here:
 *   - Tokens are minted in Profile (session auth), shown raw exactly once, and
 *     listed afterwards by name only — no prefix or any other part of the
 *     secret is ever sent back (secrets are presence-only).
 *   - `Authorization: Bearer e3_…` authenticates as the owning user. A `read`
 *     token may only GET over HTTP and only call read tools over MCP; a `write`
 *     token carries the user's own rights.
 *   - Expired and revoked tokens are 401; a valid cookie beats a bad bearer.
 *   - Admins may cap lifetimes and see / revoke every user's tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

const TOKEN_RE = /^e3_[rw][0-9A-Za-z]{40}$/;

async function mint(
  app: INestApplication,
  cookie: string,
  body: { name: string; scope: 'read' | 'write'; expires_in_days: number | null },
) {
  const res = await request(app.getHttpServer()).post('/api/v1/me/tokens').set('Cookie', cookie).send(body).expect(201);
  return res.body as { id: string; token: string; prefix?: string; scope: string; expires_at: string | null };
}

function mcp(app: INestApplication, body: unknown, bearer?: string) {
  const req = request(app.getHttpServer())
    .post('/api/v1/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (bearer) req.set('Authorization', `Bearer ${bearer}`);
  return req.send(body as object);
}

function parseRpc(text: string): any {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line!.slice('data: '.length));
}

describe('personal access tokens e2e', () => {
  let app: INestApplication;
  let adminCookie: string;
  let userCookie: string;
  let userId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie } = await seedAdminAndLogin(app));
    ({ cookie: userCookie, userId } = await seedUserAndLogin(app));
  });
  afterEach(async () => app.close());

  it('mints read and write tokens, reveals the raw token once, and never lists any part of it', async () => {
    const read = await mint(app, userCookie, { name: 'laptop', scope: 'read', expires_in_days: 30 });
    const write = await mint(app, userCookie, { name: 'agent', scope: 'write', expires_in_days: null });
    expect(read.token).toMatch(TOKEN_RE);
    expect(read.token.startsWith('e3_r')).toBe(true);
    expect(write.token.startsWith('e3_w')).toBe(true);
    expect(read.prefix).toBeUndefined();
    expect(read.expires_at).not.toBeNull();
    expect(write.expires_at).toBeNull();

    const list = await request(app.getHttpServer()).get('/api/v1/me/tokens').set('Cookie', userCookie).expect(200);
    expect(list.body.policy).toEqual({ max_days: null });
    expect(list.body.tokens.map((t: any) => t.name)).toEqual(['agent', 'laptop']);
    for (const t of list.body.tokens) {
      expect(t.token).toBeUndefined();
      expect(t.token_hash).toBeUndefined();
      expect(t.prefix).toBeUndefined();
    }
  });

  it('refuses token management over a bearer token', async () => {
    const write = await mint(app, userCookie, { name: 'agent', scope: 'write', expires_in_days: null });
    const bearer = `Bearer ${write.token}`;
    await request(app.getHttpServer()).get('/api/v1/me/tokens').set('Authorization', bearer).expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Authorization', bearer)
      .send({ name: 'escalate', scope: 'write', expires_in_days: null })
      .expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${write.id}`).set('Authorization', bearer).expect(403);
    const adminWrite = await mint(app, adminCookie, { name: 'admin-agent', scope: 'write', expires_in_days: null });
    await request(app.getHttpServer()).get('/api/v1/admin/tokens').set('Authorization', `Bearer ${adminWrite.token}`).expect(403);
  });

  it('validates the create body', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', userCookie)
      .send({ name: '', scope: 'read', expires_in_days: 30 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', userCookie)
      .send({ name: 'x', scope: 'admin', expires_in_days: 30 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', userCookie)
      .send({ name: 'x', scope: 'read', expires_in_days: 7 })
      .expect(400);
  });

  it('authenticates a bearer read token for GET and refuses writes with 403', async () => {
    const { token } = await mint(app, userCookie, { name: 'ro', scope: 'read', expires_in_days: 90 });
    const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.user.id).toBe(userId);
    expect(me.body.user.token.scope).toBe('read');

    const post = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nope', body: 'x' })
      .expect(403);
    expect(post.body.message).toBe('Token scope is read-only');
    await request(app.getHttpServer())
      .put('/api/v1/me/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'theme', value: 'dark' })
      .expect(403);
  });

  it('lets a write token create an item over REST and over MCP', async () => {
    const { token } = await mint(app, userCookie, { name: 'rw', scope: 'write', expires_in_days: 365 });
    const rest = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Via REST', body: 'hello' })
      .expect(201);
    expect(rest.body.item.title).toBe('Via REST');

    const list = await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token).expect(200);
    const names: string[] = parseRpc(list.text).result.tools.map((t: any) => t.name);
    expect(names).toContain('knowledge.create_item');

    const created = await mcp(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'knowledge.create_item', arguments: { title: 'Via MCP', body: 'hello' } },
      },
      token,
    ).expect(200);
    const rpc = parseRpc(created.text);
    expect(rpc.result.isError).toBeUndefined();
    expect(rpc.result.structuredContent.title).toBe('Via MCP');
  });

  it('hides write tools from a read token and refuses them when called directly', async () => {
    const { token } = await mint(app, userCookie, { name: 'ro', scope: 'read', expires_in_days: 30 });
    const list = await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token).expect(200);
    const names: string[] = parseRpc(list.text).result.tools.map((t: any) => t.name);
    expect(names).toContain('knowledge.search');
    expect(names).not.toContain('knowledge.create_item');
    expect(names).not.toContain('knowledge.update_item');

    const call = await mcp(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'knowledge.create_item', arguments: { title: 'Nope', body: 'x' } },
      },
      token,
    ).expect(200);
    const rpc = parseRpc(call.text);
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toContain('read-only');

    // Legacy JSON-RPC surface goes through the same gate.
    const legacy = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'knowledge.create_item', arguments: {} } })
      .expect(200);
    expect(legacy.body.error.code).toBe(-32003);
  });

  it('rejects expired, revoked, and unknown tokens with 401', async () => {
    const { id, token } = await mint(app, userCookie, { name: 'short', scope: 'read', expires_in_days: 30 });
    const db = app.get<Kysely<Database>>(KYSELY);
    await db
      .updateTable('api_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', id)
      .execute();
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(401);

    const { id: id2, token: token2 } = await mint(app, userCookie, { name: 'gone', scope: 'read', expires_in_days: 30 });
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token2}`).expect(200);
    await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${id2}`).set('Cookie', userCookie).expect(204);
    // Idempotent.
    await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${id2}`).set('Cookie', userCookie).expect(204);
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token2}`).expect(401);
    const list = await request(app.getHttpServer()).get('/api/v1/me/tokens').set('Cookie', userCookie).expect(200);
    expect(list.body.tokens.find((t: any) => t.id === id2).revoked_at).not.toBeNull();

    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer e3_r0000000000000000000000000000000000000000')
      .expect(401);
    // A read-only MCP call with a revoked token is refused at the door too.
    await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token2).expect(401);
  });

  it('records last_used_at on bearer use', async () => {
    const { id, token } = await mint(app, userCookie, { name: 'used', scope: 'read', expires_in_days: 30 });
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    const list = await request(app.getHttpServer()).get('/api/v1/me/tokens').set('Cookie', userCookie).expect(200);
    expect(list.body.tokens.find((t: any) => t.id === id).last_used_at).not.toBeNull();
  });

  it('prefers a valid cookie over a bad bearer', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', userCookie)
      .set('Authorization', 'Bearer e3_rBADBADBADBADBADBADBADBADBADBADBADBADBADBAD')
      .expect(200);
    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.token).toBeUndefined();
  });

  it('enforces the admin maximum lifetime on create', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/auth/token-policy')
      .set('Cookie', adminCookie)
      .send({ max_days: 90 })
      .expect(200)
      .expect({ max_days: 90 });
    const policy = await request(app.getHttpServer())
      .get('/api/v1/admin/auth/token-policy')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(policy.body).toEqual({ max_days: 90 });

    const list = await request(app.getHttpServer()).get('/api/v1/me/tokens').set('Cookie', userCookie).expect(200);
    expect(list.body.policy.max_days).toBe(90);

    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', userCookie)
      .send({ name: 'too long', scope: 'read', expires_in_days: 365 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', userCookie)
      .send({ name: 'forever', scope: 'read', expires_in_days: null })
      .expect(400);
    await mint(app, userCookie, { name: 'ok', scope: 'read', expires_in_days: 90 });

    await request(app.getHttpServer())
      .put('/api/v1/admin/auth/token-policy')
      .set('Cookie', adminCookie)
      .send({ max_days: null })
      .expect(200)
      .expect({ max_days: null });
    await mint(app, userCookie, { name: 'forever', scope: 'read', expires_in_days: null });
  });

  it('lets admins list and revoke every token, and keeps non-admins out', async () => {
    const { id, token } = await mint(app, userCookie, { name: 'alice-token', scope: 'write', expires_in_days: 30 });
    await mint(app, adminCookie, { name: 'admin-token', scope: 'read', expires_in_days: 30 });

    const all = await request(app.getHttpServer()).get('/api/v1/admin/tokens').set('Cookie', adminCookie).expect(200);
    const rows = all.body.tokens as Array<{ id: string; username: string; name: string; token?: string }>;
    expect(rows.map((t) => t.username).sort()).toEqual(['admin', 'alice']);
    expect(rows.find((t) => t.id === id)?.name).toBe('alice-token');
    for (const t of rows) {
      expect(t.token).toBeUndefined();
      expect((t as { prefix?: string }).prefix).toBeUndefined();
      expect((t as { token_hash?: string }).token_hash).toBeUndefined();
    }

    await request(app.getHttpServer()).get('/api/v1/admin/tokens').set('Cookie', userCookie).expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/admin/tokens/${id}`).set('Cookie', userCookie).expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/admin/auth/token-policy')
      .set('Cookie', userCookie)
      .send({ max_days: 30 })
      .expect(403);
    // A user cannot revoke someone else's token through the self-service route.
    const adminTokenId = rows.find((t) => t.username === 'admin')!.id;
    await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${adminTokenId}`).set('Cookie', userCookie).expect(404);

    await request(app.getHttpServer()).delete(`/api/v1/admin/tokens/${id}`).set('Cookie', adminCookie).expect(204);
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('flags tokens whose owner is disabled, without revoking them', async () => {
    const { id, token } = await mint(app, userCookie, { name: 'alice-agent', scope: 'read', expires_in_days: 30 });
    const ownerDisabled = async () => {
      const all = await request(app.getHttpServer()).get('/api/v1/admin/tokens').set('Cookie', adminCookie).expect(200);
      const row = (all.body.tokens as Array<Record<string, unknown>>).find((t) => t.id === id)!;
      // Presence only: the owner's deleted_at timestamp is not part of the row.
      expect(row.owner_deleted_at).toBeUndefined();
      return row;
    };
    expect((await ownerDisabled()).owner_disabled).toBe(false);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/users/${userId}`)
      .set('Cookie', adminCookie)
      .send({ disabled: true })
      .expect(200);
    const disabled = await ownerDisabled();
    expect(disabled.owner_disabled).toBe(true);
    // Not revoked: the token is stopped by the account state, not by a revoke.
    expect(disabled.revoked_at).toBeNull();
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(401);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/users/${userId}`)
      .set('Cookie', adminCookie)
      .send({ disabled: false })
      .expect(200);
    expect((await ownerDisabled()).owner_disabled).toBe(false);
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
  });
  describe('admin token list paging and filters', () => {
    const list = (query = '') =>
      request(app.getHttpServer()).get(`/api/v1/admin/tokens${query}`).set('Cookie', adminCookie);

    it('pages newest-first with a total, and clamps the limit', async () => {
      const db = app.get<Kysely<Database>>(KYSELY);
      for (let i = 0; i < 5; i += 1) {
        const { id } = await mint(app, userCookie, { name: `t${i}`, scope: 'read', expires_in_days: 30 });
        // Distinct creation instants, so "newest first" does not hang on two
        // mints landing in the same millisecond.
        await db.updateTable('api_tokens').set({ created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }).where('id', '=', id).execute();
      }
      const first = await list('?limit=2').expect(200);
      expect(first.body.total).toBe(5);
      expect(first.body.limit).toBe(2);
      expect(first.body.offset).toBe(0);
      expect(first.body.tokens.map((t: any) => t.name)).toEqual(['t4', 't3']);
      const last = await list('?limit=2&offset=4').expect(200);
      expect(last.body.tokens.map((t: any) => t.name)).toEqual(['t0']);
      expect(last.body.total).toBe(5);

      // Default 50, max 200; the unparameterised shape keeps `{ tokens }`.
      const all = await list().expect(200);
      expect(all.body.limit).toBe(50);
      expect(all.body.tokens).toHaveLength(5);
      expect((await list('?limit=5000').expect(200)).body.limit).toBe(200);

      await list('?limit=0').expect(400);
      await list('?offset=-1').expect(400);
      await list('?state=dormant').expect(400);
      await list('?scope=admin').expect(400);
    });

    it('filters by owner (username or id), scope, name and state, and counts only the matches', async () => {
      const laptop = await mint(app, userCookie, { name: 'Alice laptop', scope: 'read', expires_in_days: 30 });
      await mint(app, userCookie, { name: 'Alice CI', scope: 'write', expires_in_days: 30 });
      const stale = await mint(app, userCookie, { name: 'Alice stale', scope: 'read', expires_in_days: 30 });
      await mint(app, adminCookie, { name: 'Admin laptop', scope: 'read', expires_in_days: null });
      const db = app.get<Kysely<Database>>(KYSELY);
      await db
        .updateTable('api_tokens')
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where('id', '=', stale.id)
        .execute();
      await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${laptop.id}`).set('Cookie', userCookie).expect(204);

      const names = (res: request.Response) => res.body.tokens.map((t: any) => t.name).sort();
      const byName = await list('?owner=alice').expect(200);
      expect(byName.body.total).toBe(3);
      expect(names(await list(`?owner=${userId}`).expect(200))).toEqual(names(byName));
      expect((await list('?owner=nobody').expect(200)).body.total).toBe(0);

      expect(names(await list('?scope=write').expect(200))).toEqual(['Alice CI']);
      // Case-insensitive substring of the name.
      expect(names(await list('?q=LAPTOP').expect(200))).toEqual(['Admin laptop', 'Alice laptop']);

      expect(names(await list('?state=revoked').expect(200))).toEqual(['Alice laptop']);
      expect(names(await list('?state=expired').expect(200))).toEqual(['Alice stale']);
      expect(names(await list('?state=active').expect(200))).toEqual(['Admin laptop', 'Alice CI']);
      expect((await list('?state=all').expect(200)).body.total).toBe(4);

      // Filters combine.
      const combined = await list('?owner=alice&state=active&q=ci').expect(200);
      expect(combined.body.total).toBe(1);
      expect(combined.body.tokens[0].name).toBe('Alice CI');
    });

    it('puts a live token of a disabled owner under "owner_disabled", not "active"; revoked and expired stay what they are', async () => {
      await mint(app, userCookie, { name: 'live', scope: 'read', expires_in_days: 30 });
      const gone = await mint(app, userCookie, { name: 'gone', scope: 'read', expires_in_days: 30 });
      await request(app.getHttpServer()).delete(`/api/v1/me/tokens/${gone.id}`).set('Cookie', userCookie).expect(204);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${userId}`)
        .set('Cookie', adminCookie)
        .send({ disabled: true })
        .expect(200);

      const disabled = await list('?state=owner_disabled').expect(200);
      expect(disabled.body.tokens.map((t: any) => t.name)).toEqual(['live']);
      expect(disabled.body.tokens[0].owner_disabled).toBe(true);
      expect((await list('?state=active&owner=alice').expect(200)).body.total).toBe(0);
      expect((await list('?state=revoked').expect(200)).body.tokens.map((t: any) => t.name)).toEqual(['gone']);
    });

    it('never lists any part of a secret on a filtered page', async () => {
      const minted = await mint(app, userCookie, { name: 'secretive', scope: 'write', expires_in_days: 30 });
      const res = await list('?owner=alice&q=secret&limit=1').expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(minted.token);
      expect(text).not.toContain(minted.token.slice(0, 8));
      for (const t of res.body.tokens) {
        expect(Object.keys(t).sort()).toEqual(
          ['created_at', 'expires_at', 'id', 'last_used_at', 'name', 'owner_disabled', 'revoked_at', 'scope', 'user_id', 'username'].sort(),
        );
      }
    });

    it('is 401 without a session and 403 for a non-admin', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/tokens?state=active').expect(401);
      await request(app.getHttpServer()).get('/api/v1/admin/tokens?state=active').set('Cookie', userCookie).expect(403);
    });
  });
});
