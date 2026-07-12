/**
 * MCP JSON-RPC transport behavior — covers P1-3 (create attribution) and
 * P2-10 (structured error mapping) from docs/repo-review-2026-05-30.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('MCP JSON-RPC transport (P1-3, P2-10)', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  function call(name: string, args: Record<string, unknown>, id = 1) {
    return request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  }

  it('attributes a create_item write to the authenticated caller, not the system actor', async () => {
    const res = await call('knowledge.create_item', {
      title: 'Owned By Caller',
      body: 'attributed correctly',
    }).expect(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.item.owner_id).toBe(userId);
  });

  it('maps a duplicate-title ConflictException into a structured JSON-RPC error with data', async () => {
    await call('knowledge.create_item', { title: 'Dup Title', body: 'one', client_request_id: 'a' }, 1).expect(200);
    const res = await call('knowledge.create_item', { title: 'Dup Title', body: 'two', client_request_id: 'b' }, 2).expect(200);

    expect(res.body.result).toBeUndefined();
    expect(res.body.error.code).toBe(-32009); // 409 → server-defined conflict code
    expect(res.body.error.message).toContain('already exists');
    expect(res.body.error.data.duplicate_title).toMatchObject({ duplicate: true });
  });

  it('maps a validation BadRequestException to the invalid-params code', async () => {
    const res = await call('knowledge.create_item', {
      title: 'Bad Groups',
      body: 'x',
      groups: [42],
    }).expect(200);
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('groups');
  });

  it('returns -32602 for an unknown tool name', async () => {
    const res = await call('knowledge.does_not_exist', {}).expect(200);
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('Unknown tool');
  });
});
