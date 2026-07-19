/**
 * Anonymous read-only MCP e2e.
 *
 * MCP's Streamable HTTP transport tunnels reads over POST, so @PublicRead
 * (GET-only) can never apply to it — @PublicRpc is the narrow gate that lets an
 * anonymous visitor read over MCP when the instance is in `public` mode.
 *
 * The contract these tests pin down:
 *   - `authenticated` mode (the default) is unchanged: anonymous MCP is 401.
 *   - `public` mode: anonymous may read, sees ONLY read-only tools, and gets
 *     only published content.
 *   - Write tools are refused for anonymous callers even when called directly
 *     without listing — hiding is not enforcing.
 *   - A signed-in caller is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

const WRITE_TOOLS = ['knowledge.create_item', 'knowledge.import_okf'];

async function setReadMode(app: INestApplication, adminCookie: string, mode: 'public' | 'authenticated') {
  await request(app.getHttpServer())
    .put('/api/v1/admin/access')
    .set('Cookie', adminCookie)
    .send({ read_mode: mode })
    .expect(200);
}

/** Call the spec-compliant MCP endpoint. Omit `cookie` to call anonymously. */
function mcp(app: INestApplication, body: unknown, cookie?: string) {
  const req = request(app.getHttpServer())
    .post('/api/v1/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (cookie) req.set('Cookie', cookie);
  return req.send(body as object);
}

/** The transport replies as an SSE frame; pull the JSON payload back out. */
function parseRpc(text: string): any {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line!.slice('data: '.length));
}

describe('anonymous MCP e2e', () => {
  let app: INestApplication;
  let adminCookie: string;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie, userId: adminId } = await seedAdminAndLogin(app));
    // One published and one draft item, so visibility is observable.
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', adminCookie)
      .send({ title: 'Public Thing', body: 'findme published', status: 'published' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', adminCookie)
      .send({ title: 'Secret Thing', body: 'findme draft', status: 'draft' })
      .expect(201);
  });
  afterEach(async () => app.close());

  describe('authenticated mode (default)', () => {
    it('rejects anonymous MCP entirely', async () => {
      await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
    });

    it('still allows a signed-in caller', async () => {
      const res = await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, adminCookie).expect(200);
      expect(parseRpc(res.text).result.tools.length).toBeGreaterThan(0);
    });
  });

  describe('public mode', () => {
    beforeEach(async () => setReadMode(app, adminCookie, 'public'));

    it('lets an anonymous caller initialize and list read-only tools', async () => {
      const init = await mcp(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }).expect(200);
      expect(parseRpc(init.text).result.serverInfo.name).toBe('knowledge-e3');

      const res = await mcp(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' }).expect(200);
      const names: string[] = parseRpc(res.text).result.tools.map((t: any) => t.name);

      expect(names).toContain('knowledge.search');
      expect(names).toContain('knowledge.get_item');
      for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    });

    it('returns published content but never drafts', async () => {
      const res = await mcp(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'knowledge.search', arguments: { query: 'findme' } },
      }).expect(200);
      const text = parseRpc(res.text).result.content[0].text;
      expect(text).toContain('Public Thing');
      expect(text).not.toContain('Secret Thing');
    });

    // The important one: a client can call any name without listing first, so
    // filtering tools/list must not be the only thing standing in the way.
    it.each(WRITE_TOOLS)('refuses write tool %s called directly', async (name) => {
      const res = await mcp(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: {} },
      }).expect(200);
      const rpc = parseRpc(res.text);
      // The SDK surfaces tool failures as an isError result rather than a
      // protocol error, so assert on that shape.
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.content[0].text).toContain('requires sign-in');
    });

    it('refuses anonymous writes on the legacy jsonrpc surface too', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/mcp/jsonrpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge.create_item', arguments: {} } })
        .expect(200);
      expect(res.body.error.code).toBe(-32003); // 403 -> forbidden
      expect(res.body.error.message).toContain('requires sign-in');
    });

    it('leaves a signed-in caller fully capable', async () => {
      const list = await mcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, adminCookie).expect(200);
      const names: string[] = parseRpc(list.text).result.tools.map((t: any) => t.name);
      for (const w of WRITE_TOOLS) expect(names).toContain(w);

      const created = await mcp(
        app,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'knowledge.create_item', arguments: { title: 'Made By Admin', body: 'x', actor_id: adminId } },
        },
        adminCookie,
      ).expect(200);
      expect(parseRpc(created.text).result.isError).toBeUndefined();
    });
  });
});
