/**
 * The server's HTTP MCP advertises the shared read-tool contract
 * (`@echozedlabs/mcp-tools`) — the same descriptors the stdio knowledge-mcp app
 * serves — and `knowledge.get_item` applies the same read gates as search:
 * an anonymous visitor on a public instance gets neither drafts nor items in a
 * private topic, by id, slug or title; a signed-in admin gets both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { READ_TOOL_DESCRIPTORS } from '@echozedlabs/mcp-tools';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';

function parseRpc(text: string): any {
  const line = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).pop();
  return JSON.parse(line!.slice('data:'.length).trim());
}

describe('MCP shared read-tool contract', () => {
  let app: INestApplication;
  let cookie: string;
  const ids: Record<string, { id: string; slug: string }> = {};

  function mcp(body: unknown, asCookie?: string) {
    const req = request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream');
    if (asCookie) req.set('Cookie', asCookie);
    return req.send(body as object).expect(200);
  }

  async function call(name: string, args: Record<string, unknown>, asCookie?: string) {
    const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, asCookie);
    return parseRpc(res.text).result;
  }

  async function seed(title: string, body: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body: 'contractmarker words', ...body })
      .expect(201);
    ids[title] = { id: res.body.page.id, slug: res.body.page.slug };
  }

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Closed Contract Topic', visibility: 'private' })
      .expect(201);
    await seed('Open Contract Item', { status: 'published', frontmatter: conformant() });
    await seed('Draft Contract Item', { status: 'draft' });
    await seed('Private Contract Item', { status: 'published', frontmatter: conformant({ topic: 'Closed Contract Topic' }) });
  });
  afterEach(async () => app.close());

  it('lists every shared read tool with the shared descriptor, byte for byte', async () => {
    const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, cookie);
    const tools: Array<Record<string, unknown>> = parseRpc(res.text).result.tools;
    for (const descriptor of READ_TOOL_DESCRIPTORS) {
      const listed = tools.find((t) => t['name'] === descriptor.name);
      expect(listed, descriptor.name).toBeDefined();
      expect(JSON.stringify(listed)).toBe(
        JSON.stringify({ name: descriptor.name, title: descriptor.title, description: descriptor.description, inputSchema: descriptor.inputSchema }),
      );
    }
  });

  it('gives an anonymous visitor only the published, public-topic item through get_item', async () => {
    const open = await call('knowledge.get_item', { id: ids['Open Contract Item']!.id });
    expect(open.isError).toBeUndefined();
    expect(open.structuredContent.item).toMatchObject({ title: 'Open Contract Item', status: 'published' });

    for (const title of ['Draft Contract Item', 'Private Contract Item']) {
      for (const args of [{ id: ids[title]!.id }, { slug: ids[title]!.slug }, { title }]) {
        const hidden = await call('knowledge.get_item', args);
        expect(hidden.isError, `${title} via ${JSON.stringify(args)}`).toBe(true);
        expect(hidden.structuredContent.error.rpc_code).toBe(-32004);
        expect(hidden.content[0].text).toContain('could not find an item');
      }
    }

    // Search agrees: the same two items are invisible to the same caller.
    const search = await call('knowledge.search', { q: 'contractmarker' });
    const titles = search.structuredContent.results.map((r: { title: string }) => r.title);
    expect(titles).toContain('Open Contract Item');
    expect(titles).not.toContain('Draft Contract Item');
    expect(titles).not.toContain('Private Contract Item');
  });

  it('hides a private topic and its terms from an anonymous caller of list_spaces and list_taxonomy, as REST does', async () => {
    const tagged = { status: 'published', frontmatter: conformant({ topic: 'Closed Contract Topic', tags: ['closedonlytag'] }) };
    await seed('Private Tagged Item', tagged);

    const anonSpaces = await call('knowledge.list_spaces', {});
    const anonNames = anonSpaces.structuredContent.spaces.map((s: { name: string }) => s.name);
    expect(anonNames).not.toContain('Closed Contract Topic');
    const anonTags = (await call('knowledge.list_taxonomy', {})).structuredContent.tags.map((t: { name: string }) => t.name);
    expect(anonTags).not.toContain('closedonlytag');

    const adminNames = (await call('knowledge.list_spaces', {}, cookie)).structuredContent.spaces.map((s: { name: string }) => s.name);
    expect(adminNames).toContain('Closed Contract Topic');
    const adminTags = (await call('knowledge.list_taxonomy', {}, cookie)).structuredContent.tags.map((t: { name: string }) => t.name);
    expect(adminTags).toContain('closedonlytag');
  });

  it('gives a signed-in admin the draft and the private-topic item', async () => {
    for (const title of ['Draft Contract Item', 'Private Contract Item']) {
      const got = await call('knowledge.get_item', { id: ids[title]!.id }, cookie);
      expect(got.isError, title).toBeUndefined();
      expect(got.structuredContent.item.title).toBe(title);
    }
  });
});
