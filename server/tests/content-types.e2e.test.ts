import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { PagesService } from '../src/pages/pages.service.js';

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ContentType {
  key: string;
  label: string;
  description: string;
  icon: string;
  group: string;
  fields: Array<{ key: string; label: string; type: string }>;
  defaultFrontmatter: Record<string, unknown>;
  template: string;
}

describe('Content types (first-class OKF concept kinds) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('serves the content-type registry with templates and domain frontmatter over HTTP', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/content-types')
      .set('Cookie', cookie)
      .expect(200);

    const types: ContentType[] = res.body.content_types;
    expect(Array.isArray(types)).toBe(true);
    const labels = types.map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining(['Concept', 'Troubleshooting Guide', 'FAQ', 'Runbook', 'Blog Post']));

    const troubleshooting = types.find((t) => t.key === 'troubleshooting-guide')!;
    expect(troubleshooting.template).toContain('## Symptom');
    expect(troubleshooting.template).toContain('## Verification');
    expect(troubleshooting.defaultFrontmatter).toMatchObject({ symptoms: [] });
    expect(troubleshooting.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['symptoms', 'severity']));
  });

  it('exposes the vocabulary to agents via the MCP list_content_types tool', async () => {
    const listed = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    const toolNames = listed.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('knowledge.list_content_types');

    const called = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'knowledge.list_content_types', arguments: {} } })
      .expect(200);
    const body = called.body as JsonRpcResponse<{ content_types: ContentType[] }>;
    expect(body.error).toBeUndefined();
    expect(body.result!.content_types.map((t) => t.label)).toEqual(expect.arrayContaining(['FAQ', 'ADR']));
  });

  it('canonicalizes a known frontmatter type into the derived type column', async () => {
    const pages = app.get(PagesService);
    // Author writes a loose spelling; the derived column collapses to the canonical label.
    const faq = await pages.create(adminId, { title: 'Reset FAQ', body: 'x', frontmatter: { type: 'faq' } });
    expect(faq.type).toBe('FAQ');

    const guide = await pages.create(adminId, { title: 'Device Guide', body: 'x', frontmatter: { type: 'Troubleshooting-Guide' } });
    expect(guide.type).toBe('Troubleshooting Guide');
  });

  it('passes unknown types through untouched (OKF stays permissive)', async () => {
    const pages = app.get(PagesService);
    const odd = await pages.create(adminId, { title: 'Odd Kind Item', body: 'x', frontmatter: { type: 'Some Bespoke Kind' } });
    expect(odd.type).toBe('Some Bespoke Kind');
  });
});
