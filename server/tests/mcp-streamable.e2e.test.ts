import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';

/**
 * Spec-compliance for the Streamable HTTP MCP endpoint (POST /api/v1/mcp): the
 * `initialize` lifecycle, capability advertisement, and tools/resources/prompts,
 * all framed as SSE by the SDK transport.
 */
function parseSse(text: string): any {
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) throw new Error(`No SSE data frame in: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]!.slice('data:'.length).trim());
}

describe('MCP Streamable HTTP (spec-compliant) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  async function rpc(body: Record<string, unknown>): Promise<any> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(body)
      .expect(200);
    return parseSse(res.text);
  }

  it('completes the initialize handshake advertising tools/resources/prompts', async () => {
    const r = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    expect(r.result.serverInfo).toMatchObject({ name: 'knowledge-e3' });
    expect(r.result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(typeof r.result.protocolVersion).toBe('string');
  });

  it('lists tools and calls one, returning MCP content + structuredContent', async () => {
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['knowledge.search', 'knowledge.create_item', 'knowledge.list_content_types']),
    );

    const called = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'knowledge.list_content_types', arguments: {} },
    });
    expect(called.result.content[0]).toMatchObject({ type: 'text' });
    expect(called.result.structuredContent.content_types.length).toBeGreaterThan(0);
  });

  it('lists and reads a concept as an okf:// resource', async () => {
    const items = app.get(ItemsService);
    const created = await items.create(adminId, { title: 'MCP Resource Doc', body: '# Body\n\nHello from MCP.', status: 'published' });

    const list = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    const uris: string[] = list.result.resources.map((r: any) => r.uri);
    expect(uris).toContain(`okf://concept/${created.id}`);

    const read = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: `okf://concept/${created.id}` } });
    expect(read.result.contents[0]).toMatchObject({ uri: `okf://concept/${created.id}`, mimeType: 'text/markdown' });
    expect(read.result.contents[0].text).toContain('Hello from MCP.');
  });

  it('lists prompts and renders one with arguments', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 6, method: 'prompts/list' });
    expect(list.result.prompts.map((p: any) => p.name)).toEqual(expect.arrayContaining(['troubleshoot', 'create-faq']));

    const got = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'prompts/get',
      params: { name: 'troubleshoot', arguments: { symptom: 'device offline', product: 'controller-a' } },
    });
    expect(got.result.messages[0].role).toBe('user');
    expect(got.result.messages[0].content.text).toContain('device offline');
  });
});
