/**
 * knowledge:// resources and resource templates on the spec-compliant MCP
 * endpoint (plan §5.2): templates, taxonomy, item alias, topic — additive to
 * the okf://concept/<id> resources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';

function parseSse(text: string): any {
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) throw new Error(`No SSE data frame in: ${text.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]!.slice('data:'.length).trim());
}

describe('MCP knowledge:// resources e2e', () => {
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

  async function read(uri: string) {
    const r = await rpc({ jsonrpc: '2.0', id: uri, method: 'resources/read', params: { uri } });
    expect(r.error, `reading ${uri}`).toBeUndefined();
    return r.result.contents[0];
  }

  it('lists the static knowledge:// resources next to the concept resources', async () => {
    const items = app.get(ItemsService);
    const created = await items.create(adminId, { title: 'Listed Concept', body: 'Body.', status: 'published' });

    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    const uris: string[] = list.result.resources.map((r: any) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(['knowledge://templates', 'knowledge://taxonomy', `okf://concept/${created.id}`]));
  });

  it('advertises the resource templates', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' });
    const templates: string[] = list.result.resourceTemplates.map((t: any) => t.uriTemplate);
    expect(templates).toEqual(
      expect.arrayContaining(['knowledge://templates/{content-type-key}', 'knowledge://item/{id}', 'knowledge://topic/{slug}']),
    );
  });

  it('reads the template index and one content-type template', async () => {
    const index = JSON.parse((await read('knowledge://templates')).text);
    expect(index).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'troubleshooting-guide', uri: 'knowledge://templates/troubleshooting-guide' })]),
    );

    const guide = await read('knowledge://templates/troubleshooting-guide');
    expect(guide.mimeType).toBe('application/json');
    const parsed = JSON.parse(guide.text);
    expect(parsed).toMatchObject({ key: 'troubleshooting-guide', label: 'Troubleshooting Guide' });
    expect(parsed.template).toContain('## Symptom');
    expect(parsed.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['title', 'description', 'symptoms']));

    const unknown = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'knowledge://templates/no-such-type' } });
    expect(unknown.error).toBeDefined();
  });

  it('reads the taxonomy, the item alias, and a topic', async () => {
    const items = app.get(ItemsService);
    const created = await items.create(adminId, {
      title: 'Aliased Concept',
      body: 'Hello from the alias.',
      status: 'published',
      tags: ['alias-tag'],
      frontmatter: { space: 'Ops' },
    });

    const taxonomy = JSON.parse((await read('knowledge://taxonomy')).text);
    expect(taxonomy.topics).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'ops', name: 'Ops' })]));
    expect(taxonomy.tags.map((t: { slug: string }) => t.slug)).toContain('alias-tag');
    expect(taxonomy).toHaveProperty('categories');
    expect(taxonomy).toHaveProperty('groups');

    const alias = await read(`knowledge://item/${created.id}`);
    const concept = await read(`okf://concept/${created.id}`);
    expect(alias.mimeType).toBe('text/markdown');
    expect(alias.text).toBe(concept.text);
    expect(alias.text).toContain('Hello from the alias.');

    const topic = JSON.parse((await read('knowledge://topic/ops')).text);
    expect(topic).toMatchObject({ slug: 'ops', name: 'Ops', counts: { items: 1, published: 1 } });
  });
});
