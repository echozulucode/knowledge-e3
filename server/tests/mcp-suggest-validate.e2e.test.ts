/**
 * Phase 2 LLM-publishing MCP tools (plan §5.2, §12 decision 4):
 *   - `knowledge.suggest_metadata` / `knowledge.validate_item` are read-only and
 *     visible to anonymous callers on a public instance;
 *   - `knowledge.update_item` / `knowledge.publish_item` write as the
 *     authenticated user, honor version tokens, and `reviewed: true` records
 *     the user's verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';

const TROUBLESHOOTING_BODY = [
  '---',
  'title: Login timeout',
  '---',
  '## Symptom',
  '',
  'Login times out after 30 seconds.',
  '',
  '## Applies to',
  '',
  'The auth gateway.',
  '',
  '## Quick checks',
  '',
  'Check the clock skew.',
  '',
  '## Likely causes',
  '',
  'Expired certificate.',
  '',
  '## Diagnostic steps',
  '',
  'Run the probe.',
  '',
  '## Fix',
  '',
  'Rotate the certificate.',
  '',
].join('\n');

describe('MCP suggest/validate/update/publish e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => app.close());

  async function rpc(body: Record<string, unknown>, withCookie = true) {
    const req = request(app.getHttpServer()).post('/api/v1/mcp/jsonrpc');
    if (withCookie) req.set('Cookie', cookie);
    const res = await req.send(body).expect(200);
    return res.body;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const body = await rpc({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
    expect(body.error, `MCP tool ${name} should not fail`).toBeUndefined();
    return body.result;
  }

  it('suggest_metadata proposes a type from the headings and tags from a similar item', async () => {
    await curateCategories(app);
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Login timeout guide', body: 'Existing guide about the login timeout.', status: 'published', tags: ['auth', 'timeouts'], frontmatter: conformant() })
      .expect(201);

    const result = await callTool('knowledge.suggest_metadata', { raw_markdown: TROUBLESHOOTING_BODY });
    expect(result.type).toBe('Troubleshooting Guide');
    expect(result.types[0]).toMatchObject({ label: 'Troubleshooting Guide' });
    expect(result.similar_items).toEqual([
      expect.objectContaining({ id: expect.any(String), slug: 'login-timeout-guide', title: 'Login timeout guide' }),
    ]);
    expect(result.tags).toEqual(expect.arrayContaining(['auth', 'timeouts']));
    expect(result.duplicate_title).toBe(false);
  });

  it('validate_item reports category.missing as not ok, and ok for a complete document', async () => {
    const missing = await callTool('knowledge.validate_item', {
      raw_markdown: '---\ntitle: No Category\ntype: Concept\nstale_after: 2999-01-01\n---\nBody.\n',
    });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'category.missing', severity: 'error' })]),
    );
    expect(missing.counts.error).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'guides', name: 'Guides' })
      .expect(201);
    const complete = await callTool('knowledge.validate_item', {
      raw_markdown: '---\ntitle: Complete\ntype: Concept\ndescription: A complete document.\ncategories: [guides]\nstale_after: 2999-01-01\n---\nBody.\n',
      published: true,
    });
    expect(complete.ok).toBe(true);
    expect(complete.counts.error).toBe(0);
  });

  it('update_item honors version_token and publish_item with reviewed=true records a verification', async () => {
    // publish_item is gated on the content-model rules, so the agent's draft
    // carries a primary category and a `description` the way a real agent's
    // would after validate_item. The rest of the test is unchanged.
    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'guides', name: 'Guides' })
      .expect(201);

    const created = await callTool('knowledge.create_item', {
      raw_markdown: '---\ntitle: Agent Draft\ntype: Concept\ndescription: An agent draft.\ncategories: [guides]\n---\nFirst body.\n',
    });
    expect(created.version_token).toBe(1);

    const stale = await rpc({
      jsonrpc: '2.0',
      id: 'stale',
      method: 'tools/call',
      params: { name: 'knowledge.update_item', arguments: { id: created.id, body: 'stale write', version_token: 999 } },
    });
    expect(stale.error.code).toBe(-32009); // 409 conflict

    const updated = await callTool('knowledge.update_item', { id: created.id, body: 'Second body.', version_token: 1 });
    expect(updated).toMatchObject({ id: created.id, version_token: 2, diagnostics: expect.any(Array) });
    expect(updated.item.body_markdown).toContain('Second body.');

    const published = await callTool('knowledge.publish_item', { id: created.id, reviewed: true });
    expect(published.item.status).toBe('published');
    expect(published.item.frontmatter.verified).toEqual([{ by: 'human:admin', at: expect.any(String) }]);

    const rest = await request(app.getHttpServer()).get(`/api/v1/items/${created.id}`).set('Cookie', cookie).expect(200);
    expect(rest.body.item.status).toBe('published');
  });

  it('shows suggest/validate to anonymous callers on a public instance but hides the write tools', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false);
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['knowledge.suggest_metadata', 'knowledge.validate_item']));
    expect(names).not.toContain('knowledge.update_item');
    expect(names).not.toContain('knowledge.publish_item');

    const refused = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'knowledge.publish_item', arguments: { id: 'x' } } },
      false,
    );
    expect(refused.error.code).toBe(-32003);
  });
});
