/**
 * REST/MCP parity (plan §9.5): both transports answer through the same
 * KnowledgeQuery seam, so an item read and a search return the same payload
 * on every shared field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { FIXTURE_CATEGORY, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

const SHARED_ITEM_FIELDS = [
  'id',
  'slug',
  'title',
  'status',
  'type',
  'tags',
  'categories',
  'groups',
  'version_token',
  'updated_at',
  'body_markdown',
  'raw_markdown',
  'frontmatter',
  'display_state',
  'lifecycle_status',
  'trust_tier',
  'stale',
  'stale_after',
  'last_verified_at',
  'generated_by',
  'superseded_by',
] as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

describe('REST / MCP parity', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app, 'operations');
  });
  afterEach(async () => app.close());

  async function mcp(name: string, args: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    return res.body.result;
  }

  it('reads the same item through GET /items/:id and knowledge.get_item', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw: '---\ntitle: Parity Runbook\ntype: Runbook\ndescription: The same runbook on both transports.\nstatus: published\ntags: [parity, mcp]\ncategories: [operations]\ngroups: [on-call]\nstale_after: 2020-01-01\ngenerated:\n  by: reference_agent/1.0\n  at: 2026-01-01T00:00:00.000Z\n---\nSame answer everywhere.\n',
      })
      .expect(201);
    const id = created.body.item.id as string;

    const rest = await request(app.getHttpServer()).get(`/api/v1/items/${id}`).set('Cookie', cookie).expect(200);
    const viaMcp = await mcp('knowledge.get_item', { id });

    const restItem = pick(rest.body.item, SHARED_ITEM_FIELDS);
    const mcpItem = pick(viaMcp.item, SHARED_ITEM_FIELDS);
    expect(mcpItem).toEqual(restItem);
    expect(restItem).toMatchObject({
      id,
      type: 'Runbook',
      status: 'published',
      tags: ['parity', 'mcp'],
      categories: ['operations'],
      groups: ['on-call'],
      display_state: 'needs-review',
      trust_tier: 'unverified',
      stale: true,
      generated_by: 'reference_agent/1.0',
    });

    // Slug lookup answers the same on both sides as well.
    const bySlug = await mcp('knowledge.get_item', { slug: created.body.item.slug });
    expect(pick(bySlug.item, SHARED_ITEM_FIELDS)).toEqual(restItem);
  });

  it('searches the same result set through GET /search and knowledge.search', async () => {
    for (const [title, type] of [
      ['Parity Alpha', 'FAQ'],
      ['Parity Beta', 'FAQ'],
      ['Parity Gamma', 'Concept'],
    ] as const) {
      await request(app.getHttpServer())
        .post('/api/v1/items')
        .set('Cookie', cookie)
        .send({ raw: `---\ntitle: ${title}\ntype: ${type}\ndescription: A parity fixture.\ncategories: [${FIXTURE_CATEGORY}]\nstatus: published\n---\nThe wombatron token.\n` })
        .expect(201);
    }
    // Another user's draft: invisible to the admin on both transports unless asked for.
    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', alice.cookie)
      .send({ raw: '---\ntitle: Parity Draft\ntype: FAQ\n---\nThe wombatron token, unpublished.\n' })
      .expect(201);

    const rest = await request(app.getHttpServer()).get('/api/v1/search?q=wombatron&limit=10').set('Cookie', cookie).expect(200);
    const viaMcp = await mcp('knowledge.search', { q: 'wombatron', limit: 10 });

    const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);
    expect(ids(rest.body.results)).toHaveLength(3);
    expect(ids(viaMcp.results)).toEqual(ids(rest.body.results));
    expect(viaMcp.total).toBe(rest.body.total);
    expect(viaMcp.facets).toEqual(rest.body.facets);
    expect(viaMcp.warnings).toEqual(rest.body.warnings);

    const groupShape = (groups: Array<{ key: string; total: number; hits: Array<{ id: string }> }>) =>
      groups.map((g) => ({ key: g.key, total: g.total, ids: ids(g.hits) }));
    expect(groupShape(viaMcp.groups)).toEqual(groupShape(rest.body.groups));
    expect(rest.body.groups.map((g: { key: string; total: number }) => [g.key, g.total]).sort()).toEqual([
      ['Concept', 1],
      ['FAQ', 2],
    ]);
  });
});
