import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

describe('MCP taxonomy and search parity e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  async function createItem(raw_markdown: string) {
    return request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ raw_markdown })
      .expect(201);
  }

  async function callTool<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } })
      .expect(200);
    const body = res.body as JsonRpcResponse<T>;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    return body.result as T;
  }

  it('lists spaces and taxonomy with stable ids, display names, counts, and scope metadata', async () => {
    await createItem('---\ntitle: MCP Taxonomy A\ntopic: Research Lab\ntags: [ai, mcp]\ncategories: [architecture]\ngroups: [roadmap]\nstatus: published\n---\nReusable search context.');
    await createItem('---\ntitle: MCP Taxonomy B\ntopic: Research Lab\ntags: [ai]\ncategories: [design]\ngroups: [roadmap]\nstatus: draft\n---\nDraft search context.');

    const listed = await callTool<{
      spaces: Array<{ id: string; slug: string; name: string; description: string | null; color: string | null; icon: string | null; counts: { items: number; published: number; draft: number } }>;
      total: number;
    }>('knowledge.list_spaces');

    expect(listed.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'space_research-lab',
          slug: 'research-lab',
          name: 'Research Lab',
          description: null,
          color: null,
          icon: null,
          counts: { items: 2, published: 1, draft: 1 },
        }),
      ]),
    );
    expect(listed.total).toBe(listed.spaces.length);

    const taxonomy = await callTool<{
      tags: Array<{ id: string; slug: string; name: string; count: number; scope: { type: string; space_id: string | null; space_slug: string | null } }>;
      categories: Array<{ id: string; slug: string; name: string; count: number; scope: { type: string; space_id: string | null; space_slug: string | null } }>;
      groups: Array<{ id: string; slug: string; name: string; count: number; scope: { type: string; space_id: string | null; space_slug: string | null } }>;
    }>('knowledge.list_taxonomy');

    expect(taxonomy.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tag_ai', slug: 'ai', name: 'ai', count: 2, scope: { type: 'global', space_id: null, space_slug: null } }),
      expect.objectContaining({ id: 'tag_mcp', slug: 'mcp', name: 'mcp', count: 1 }),
    ]));
    expect(taxonomy.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'category_architecture', slug: 'architecture', name: 'architecture', count: 1 }),
      expect.objectContaining({ id: 'category_design', slug: 'design', name: 'design', count: 1 }),
    ]));
    expect(taxonomy.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'group_roadmap', slug: 'roadmap', name: 'roadmap', count: 2, scope: { type: 'space', space_id: 'space_default', space_slug: 'default' } }),
    ]));
  });

  it('MCP search filters by topic, tag, category, group, status, and limit with REST DTO parity', async () => {
    await createItem('---\ntitle: Research Published Runbook\ntopic: Research Lab\ntags: [ai, runbook]\ncategories: [architecture]\ngroups: [roadmap]\nstatus: published\n---\nMCP parity needle.');
    await createItem('---\ntitle: Research Draft Runbook\ntopic: Research Lab\ntags: [ai, runbook]\ncategories: [architecture]\ngroups: [roadmap]\nstatus: draft\n---\nMCP parity needle.');
    await createItem('---\ntitle: Design Published Runbook\ntopic: Design Lab\ntags: [ai, runbook]\ncategories: [design]\ngroups: [roadmap]\nstatus: published\n---\nMCP parity needle.');
    await createItem('---\ntitle: Research Other Group\ntopic: Research Lab\ntags: [ai, runbook]\ncategories: [architecture]\ngroups: [archive]\nstatus: published\n---\nMCP parity needle.');

    const query = 'q=needle&space=research-lab&tag=runbook&category=architecture&group=roadmap&status=published&limit=1';
    const rest = await request(app.getHttpServer())
      .get(`/api/v1/search?${query}`)
      .set('Cookie', cookie)
      .expect(200);

    const mcp = await callTool<{ results: Array<Record<string, unknown>>; total: number; facets: Record<string, unknown> }>('knowledge.search', {
      q: 'needle',
      space: 'research-lab',
      tag: 'runbook',
      category: 'architecture',
      group: 'roadmap',
      status: 'published',
      limit: 1,
    });

    expect(rest.body.results.map(({ score: _score, ...hit }: Record<string, unknown>) => hit)).toEqual(
      mcp.results.map(({ score: _score, ...hit }: Record<string, unknown>) => hit),
    );
    expect(mcp.results[0].score).toBeCloseTo(rest.body.results[0].score, 6);
    expect(mcp.results).toHaveLength(1);
    expect(mcp.results[0]).toMatchObject({
      id: expect.any(String),
      slug: 'research-published-runbook',
      title: 'Research Published Runbook',
      status: 'published',
      topic: 'Research Lab',
      tags: ['ai', 'runbook'],
      categories: ['architecture'],
      groups: ['roadmap'],
      snippet: expect.stringContaining('needle'),
      updated_at: expect.any(String),
      score: expect.any(Number),
      reasons: expect.arrayContaining(['Body match']),
      path: `/items/${mcp.results[0].id}`,
      url: '/p/research-published-runbook',
    });
    expect(mcp.results[0]).not.toHaveProperty('space');
    expect(mcp.total).toBe(1);
    expect(mcp.facets).toEqual(rest.body.facets);
    expect(rest.body.facets).toMatchObject({
      topics: [expect.objectContaining({ label: 'Research Lab', count: 1, active: true })],
      statuses: [expect.objectContaining({ value: 'published', label: 'Published', count: 1, active: true })],
      tags: expect.arrayContaining([expect.objectContaining({ value: 'runbook', label: 'runbook', count: 1, active: true })]),
    });
  });

  it('keeps draft status filters admin-only for REST and MCP search', async () => {
    await createItem('---\ntitle: Private Draft Runbook\ntopic: Research Lab\ntags: [ai]\ncategories: [architecture]\ngroups: [roadmap]\nstatus: draft\n---\nprivate draft needle.');
    const { cookie: userCookie } = await seedUserAndLogin(app);

    const rest = await request(app.getHttpServer())
      .get('/api/v1/search?q=needle&status=draft')
      .set('Cookie', userCookie)
      .expect(200);
    expect(rest.body.results).toEqual([]);

    const mcp = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', userCookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge.search', arguments: { q: 'needle', status: 'draft' } } })
      .expect(200);
    expect(mcp.body.error).toBeUndefined();
    expect(mcp.body.result.results).toEqual([]);
  });

  it('advertises clear LLM-facing metadata for taxonomy and filtered search tools', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);

    const toolNames = res.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['knowledge.list_spaces', 'knowledge.list_taxonomy', 'knowledge.search']));

    const searchTool = res.body.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.search');
    expect(searchTool.description).toContain('space');
    expect(searchTool.description).toContain('tag');
    expect(searchTool.description).toContain('category');
    expect(searchTool.description).toContain('group');
    expect(searchTool.description).toContain('status');
    expect(Object.keys(searchTool.inputSchema.properties)).toEqual(expect.arrayContaining(['q', 'space', 'tag', 'category', 'group', 'status', 'limit']));
  });
});
