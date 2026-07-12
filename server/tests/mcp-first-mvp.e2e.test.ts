import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { FIRST_MVP_SEED_CATEGORIES, FIRST_MVP_SEED_GROUPS, FIRST_MVP_SEED_SPACES, seedFirstMvpCorpus } from '../src/seed.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

describe('first MVP MCP happy path', () => {
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

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error, `MCP tool ${name} should not return a low-level JSON-RPC error`).toBeUndefined();
    expect(res.body.result, `MCP tool ${name} should return a product-level result`).toBeDefined();
    return res.body.result;
  }

  it('starts from the deterministic first-MVP seed corpus', async () => {
    const db = app.get<Kysely<Database>>(KYSELY);
    const [spaces, categories, tags, groups, linkedItems, pages] = await Promise.all([
      db.selectFrom('spaces').select('slug').where('slug', 'in', FIRST_MVP_SEED_SPACES.map((space) => space.slug)).execute(),
      db.selectFrom('page_categories').select('category').distinct().execute(),
      db.selectFrom('page_tags').select('tag').distinct().execute(),
      db.selectFrom('groups').select('slug').where('slug', 'in', FIRST_MVP_SEED_GROUPS.map((group) => group.slug)).execute(),
      db.selectFrom('item_links').selectAll().execute(),
      db.selectFrom('pages').select('title').where('deleted_at', 'is', null).execute(),
    ]);

    expect(spaces.map((space) => space.slug).sort(), 'seed must provide the configured example topic collection').toEqual(
      FIRST_MVP_SEED_SPACES.map((space) => space.slug).sort(),
    );
    expect(spaces.length, 'seed should provide exactly 20 topics for scaled topic navigation').toBe(20);
    expect(categories.map((category) => category.category).sort(), 'seed must provide the configured item category collection').toEqual(
      FIRST_MVP_SEED_CATEGORIES.map((category) => category.slug).sort(),
    );
    expect(categories.length, 'seed should have enough categories to make category selection meaningful').toBeGreaterThanOrEqual(6);
    expect(tags.map((tag) => tag.tag).sort(), 'seed must provide the core first-MVP tags and varied demo tags').toEqual(expect.arrayContaining(['first-mvp', 'linked', 'searchable', 'decision', 'operations']));
    expect(groups.map((group) => group.slug).sort(), 'seed must provide the configured collaborative groups').toEqual(
      FIRST_MVP_SEED_GROUPS.map((group) => group.slug).sort(),
    );
    expect(groups.length, 'seed should have enough groups to demonstrate cross-cutting workstreams').toBeGreaterThanOrEqual(6);
    expect(pages.length, 'seed should include exactly 100 items for scaled browse QA').toBe(100);
    expect(linkedItems.length, 'seeded retrieval item must contain an indexed link for backlink checks').toBeGreaterThanOrEqual(1);
  });

  it('searches seeded corpus, gets an item by id, creates a draft, and finds it immediately', async () => {
    const listed = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(['knowledge.search', 'knowledge.get_item', 'knowledge.create_item']),
    );

    const search = await callTool('knowledge.search', { q: 'first mvp retrieval anchor', tag: 'first-mvp', limit: 10 });
    expect(search.results.length, 'Seeded search must return the retrieval item, proving the MCP path sees the same first-MVP corpus').toBeGreaterThanOrEqual(1);
    const retrieval = search.results.find((item: { title: string }) => item.title === 'First MVP Retrieval Anchor');
    expect(retrieval, `Search results were ${JSON.stringify(search.results)}`).toBeTruthy();
    expect(retrieval).toMatchObject({
      status: 'published',
      topic: 'Product',
      path: `/items/${retrieval.id}`,
      url: `/p/${retrieval.slug}`,
    });
    expect(retrieval).not.toHaveProperty('space');
    expect(retrieval.tags).toContain('first-mvp');
    expect(retrieval.categories).toContain('research-notes');
    expect(retrieval.groups).toContain('agent-flow');

    const got = await callTool('knowledge.get_item', { id: retrieval.id });
    expect(got.item).toMatchObject({ id: retrieval.id, title: 'First MVP Retrieval Anchor' });
    expect(got.item.body_markdown).toContain('[[First MVP Linked Context]]');

    const created = await callTool('knowledge.create_item', {
      title: 'MCP Draft Happy Path',
      body: 'Draft created through MCP and immediately discoverable. Links back to [[First MVP Retrieval Anchor]].',
      space: 'Agent Notes',
      tags: ['first-mvp', 'mcp-created'],
      categories: ['draft-capture'],
      groups: ['agent-flow'],
    });
    expect(created.item).toMatchObject({ title: 'MCP Draft Happy Path', status: 'draft' });
    expect(created.item.frontmatter.space).toBe('Agent Notes');
    expect(created).toMatchObject({
      id: created.item.id,
      slug: created.item.slug,
      title: 'MCP Draft Happy Path',
      path: `/items/${created.item.id}`,
      url: `/p/${created.item.slug}`,
    });

    const foundDraft = await callTool('knowledge.search', { q: 'MCP Draft Happy Path', status: 'draft', limit: 5 });
    expect(foundDraft.results.map((item: { id: string }) => item.id)).toContain(created.item.id);
  });
});
