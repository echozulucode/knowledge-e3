/**
 * Issue 45 — what a failing MCP tool is allowed to tell the client.
 *
 * Both transports (`POST /api/v1/mcp`, the spec-compliant endpoint, and the
 * legacy `POST /api/v1/mcp/jsonrpc`) share one mapping. The contract:
 *   - an unexpected error (TypeError, SQLite, git…) returns a generic
 *     "Internal error" plus a short correlation id, and never its own message;
 *     the real error is logged server-side under that same id;
 *   - a Nest HttpException keeps its public message AND its structured fields
 *     (e.g. `duplicate_title`), so an agent can dedupe without parsing prose.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Logger, type INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ListContentTypesTool } from '../src/mcp/tools/list-content-types.tool.js';

const SECRET = 'SQLITE_ERROR: no such column: pages.secret_internal_col at /srv/app/data/kp.sqlite';

/** The transport replies as an SSE frame; pull the JSON payload back out. */
function parseSse(text: string): any {
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) throw new Error(`No SSE data frame in: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]!.slice('data:'.length).trim());
}

describe('MCP tool error mapping (issue 45)', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function callStream(name: string, args: Record<string, unknown>, id = 1): Promise<any> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    return { rpc: parseSse(res.text), raw: res.text };
  }

  function callLegacy(name: string, args: Record<string, unknown>, id = 1) {
    return request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
  }

  function failWithPlainError(): void {
    const tool = app.get(ListContentTypesTool);
    vi.spyOn(tool, 'call').mockRejectedValue(new Error(SECRET));
  }

  describe('POST /api/v1/mcp', () => {
    it('hides a plain Error behind "Internal error" with a correlation id that is logged server-side', async () => {
      failWithPlainError();
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const { rpc, raw } = await callStream('knowledge.list_content_types', {});

      expect(rpc.error).toBeUndefined();
      expect(rpc.result.isError).toBe(true);
      // Nothing from the internal message anywhere in the response bytes.
      expect(raw).not.toContain('secret_internal_col');
      expect(raw).not.toContain('SQLITE_ERROR');
      expect(raw).not.toContain('kp.sqlite');

      const correlationId = rpc.result.structuredContent.error.correlation_id;
      expect(correlationId).toMatch(/^[0-9a-f]{12}$/);
      expect(rpc.result.structuredContent.error).toMatchObject({ message: 'Internal error', rpc_code: -32603 });
      expect(rpc.result.content[0].text).toBe(`Internal error (correlation id: ${correlationId})`);

      // The operator can find the real error by that id.
      const lines = logged.mock.calls.map((args) => args.map(String).join(' '));
      const line = lines.find((l) => l.includes(correlationId));
      expect(line).toBeDefined();
      expect(line).toContain('secret_internal_col');
    });

    it('keeps the structured duplicate_title payload of a ConflictException', async () => {
      const first = await callStream('knowledge.create_item', { title: 'Stream Dup', body: 'one', client_request_id: 'a' }, 1);
      expect(first.rpc.result.isError).toBeUndefined();

      const { rpc } = await callStream('knowledge.create_item', { title: 'Stream Dup', body: 'two', client_request_id: 'b' }, 2);
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.content[0].text).toContain('already exists');
      const error = rpc.result.structuredContent.error;
      expect(error.rpc_code).toBe(-32009);
      expect(error.duplicate_title).toMatchObject({ duplicate: true });
      expect(error.correlation_id).toBeUndefined();
      // Also serialized for clients that predate structuredContent.
      expect(JSON.parse(rpc.result.content[1].text).error.duplicate_title).toMatchObject({ duplicate: true });
    });

    it('keeps a not-found tool miss public rather than collapsing it into an internal error', async () => {
      const { rpc } = await callStream('knowledge.get_item', { id: 'no-such-item' });
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.content[0].text).toContain('could not find an item');
      expect(rpc.result.structuredContent.error.rpc_code).toBe(-32004);
    });
  });

  describe('legacy POST /api/v1/mcp/jsonrpc (unchanged contract)', () => {
    it('returns -32603 "Internal error" for a plain Error, now with a correlation id, and no internal message', async () => {
      failWithPlainError();
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const res = await callLegacy('knowledge.list_content_types', {});
      expect(res.body.result).toBeUndefined();
      expect(res.body.error.code).toBe(-32603);
      expect(res.body.error.message).toBe('Internal error');
      expect(res.body.error.data.correlation_id).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(res.body)).not.toContain('secret_internal_col');
    });

    it('still maps a duplicate title to -32009 with data.duplicate_title', async () => {
      await callLegacy('knowledge.create_item', { title: 'Legacy Dup', body: 'one', client_request_id: 'a' }, 1);
      const res = await callLegacy('knowledge.create_item', { title: 'Legacy Dup', body: 'two', client_request_id: 'b' }, 2);
      expect(res.body.error.code).toBe(-32009);
      expect(res.body.error.message).toContain('already exists');
      expect(res.body.error.data.duplicate_title).toMatchObject({ duplicate: true });
    });
  });
});
