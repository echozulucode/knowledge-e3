import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { seedFirstMvpCorpus } from '../src/seed.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

interface BundleFile {
  path: string;
  content: string;
}

describe('MCP export_okf tool e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    const db = app.get<Kysely<Database>>(KYSELY);
    await seedFirstMvpCorpus(db, login.userId);
  });

  afterEach(async () => app.close());

  async function callTool(name: string, args: Record<string, unknown>, sessionCookie = cookie) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', sessionCookie)
      .send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error, `MCP tool ${name} should not return a JSON-RPC error`).toBeUndefined();
    expect(res.body.result).toBeDefined();
    return res.body.result;
  }

  it('advertises the export_okf tool through tools/list', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);

    const tool = res.body.result.tools.find((t: { name: string }) => t.name === 'knowledge.export_okf');
    expect(tool).toBeTruthy();
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        ids: expect.objectContaining({ type: 'array' }),
        link_style: expect.objectContaining({ enum: ['dual', 'markdown', 'preserve'] }),
        limit: expect.objectContaining({ type: 'integer' }),
      },
    });
  });

  it('exports a conformant OKF bundle with a root index and concept files', async () => {
    const result = await callTool('knowledge.export_okf', { limit: 5 });
    expect(result.conformance.conformant).toBe(true);
    expect(result.item_count).toBeGreaterThan(0);
    expect(result.item_count).toBeLessThanOrEqual(5);

    const files: BundleFile[] = result.bundle.files;
    const index = files.find((f) => f.path === 'index.md');
    expect(index?.content).toContain('okf_version: "0.1"');
    const concepts = files.filter((f) => f.path.startsWith('concepts/'));
    expect(concepts.length).toBe(result.item_count);
    // Every concept embeds its stable E3 id and a required type.
    for (const c of concepts) {
      expect(c.content).toMatch(/^---\ntype: /);
      expect(c.content).toContain('e3_id:');
    }
  });

  it('translates wiki-links into dual links across the exported set', async () => {
    const anchor = (await callTool('knowledge.get_item', { title: 'First MVP Retrieval Anchor' })).item;
    const linked = (await callTool('knowledge.get_item', { title: 'First MVP Linked Context' })).item;

    const result = await callTool('knowledge.export_okf', {
      ids: [anchor.id, linked.id],
      link_style: 'dual',
    });
    expect(result.item_count).toBe(2);
    expect(result.conformance.conformant).toBe(true);

    const files: BundleFile[] = result.bundle.files;
    const anchorConcept = files.find((f) => f.path === `concepts/${anchor.slug}.md`);
    expect(anchorConcept).toBeTruthy();
    // Dual link: original wiki-link kept, bundle-relative markdown link appended.
    expect(anchorConcept?.content).toContain('[[First MVP Linked Context]]');
    expect(anchorConcept?.content).toContain(`(/concepts/${linked.slug}.md)`);
  });

  it('round-trips through import_okf: re-importing an export updates, not duplicates', async () => {
    const exported = await callTool('knowledge.export_okf', { limit: 5 });
    expect(exported.item_count).toBeGreaterThan(0);

    const result = await callTool('knowledge.import_okf', { files: exported.bundle.files });
    expect(result.conformance.conformant).toBe(true);
    // Every concept matched an existing item by e3_id, so all are updates.
    expect(result.created).toBe(0);
    expect(result.updated).toBe(exported.item_count);
    expect(result.ids).toHaveLength(exported.item_count);
  });

  it('space-scoped export includes only the chosen topic', async () => {
    const physics = await callTool('knowledge.create_item', {
      title: 'Quark Confinement',
      body: 'Physics note.',
      status: 'published',
      space: 'Physics',
    });
    const music = await callTool('knowledge.create_item', {
      title: 'Sonata Form',
      body: 'Music note.',
      status: 'published',
      space: 'Music',
    });

    const result = await callTool('knowledge.export_okf', { space: 'physics', limit: 200 });
    const joined: string = (result.bundle.files as BundleFile[])
      .filter((f) => f.path.startsWith('concepts/'))
      .map((f) => f.content)
      .join('\n');
    expect(joined).toContain(`e3_id: ${physics.id}`);
    expect(joined).not.toContain(`e3_id: ${music.id}`);
  });

  it('advertises the import_okf tool through tools/list', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    const tool = res.body.result.tools.find((t: { name: string }) => t.name === 'knowledge.import_okf');
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.required).toContain('files');
  });

  it('respects caller permissions — a non-admin export excludes other users\' drafts', async () => {
    // Admin creates a private draft that only the admin should see.
    const draft = await callTool('knowledge.create_item', {
      title: 'Admin Only Export Draft',
      body: 'Secret draft body.',
      status: 'draft',
    });
    const draftId = draft.item?.id ?? draft.id;
    expect(draftId).toBeTruthy();

    const alice = await seedUserAndLogin(app);
    const result = await callTool('knowledge.export_okf', { limit: 200 }, alice.cookie);

    const files: BundleFile[] = result.bundle.files;
    const exportedDraft = files.find((f) => f.content.includes(`e3_id: ${draftId}`));
    expect(exportedDraft, 'a non-admin export must not include another user\'s draft').toBeUndefined();
  });
});
