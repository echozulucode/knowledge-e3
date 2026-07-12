import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { CreateItemTool } from '../src/mcp/tools/create-item.tool.js';

describe('MCP create item tool e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let tool: CreateItemTool;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId } = await seedAdminAndLogin(app));
    tool = app.get(CreateItemTool);
  });

  afterEach(async () => app.close());

  it('advertises MCP create-item validation and idempotency inputs through tools/list', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);

    const createTool = res.body.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.create_item');
    expect(createTool).toBeTruthy();
    expect(createTool.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        raw: expect.objectContaining({ type: 'string' }),
        raw_markdown: expect.objectContaining({ type: 'string' }),
        client_request_id: expect.objectContaining({ type: 'string' }),
        source_fingerprint: expect.objectContaining({ type: 'string' }),
        frontmatter: expect.objectContaining({ type: 'object' }),
        client: expect.objectContaining({ type: 'object' }),
      },
    });
  });

  it('creates a draft item with validation, source diagnostics, and immediate REST/search visibility', async () => {
    await expect(
      tool.execute(userId, {
        title: 'Bad MCP Taxonomy',
        body: 'should not save',
        groups: ['valid', 42] as unknown as string[],
        client: { name: 'vitest-agent', version: '0.1.0' },
      }),
    ).rejects.toThrow('groups must be a list of strings');
    await expect(
      tool.execute(userId, {
        title: 'Bad MCP Client',
        body: 'should not save',
        client: { name: 42 } as unknown as { name: string },
      }),
    ).rejects.toThrow('client.name must be a string');
    await expect(
      tool.execute(userId, {
        title: 'Bad MCP Frontmatter',
        body: 'should not save',
        frontmatter: ['not-an-object'] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow('frontmatter must be an object');

    const created = await tool.execute(userId, {
      title: 'MCP Draft Runbook',
      body: 'Agent-authored Markdown body with searchable banana-token.',
      space: 'Agent Inbox',
      tags: ['mcp', 'agent'],
      categories: ['runbook'],
      groups: ['operators'],
      client_request_id: 'req-visible-1',
      client: { name: 'vitest-agent', version: '0.1.0' },
    });

    expect(created).toMatchObject({
      id: expect.any(String),
      title: 'MCP Draft Runbook',
      slug: 'mcp-draft-runbook',
      path: `/items/${created.id}`,
      url: `/p/${created.slug}`,
      version_token: 1,
      indexing_status: 'indexed',
      warnings: [],
      duplicate_title: { checked: true, duplicate: false, scope: 'agent-inbox' },
      idempotency: { replayed: false, key: 'client_request_id:req-visible-1' },
    });
    expect(created.item).toMatchObject({
      id: created.id,
      slug: created.slug,
      title: 'MCP Draft Runbook',
      status: 'draft',
      tags: ['agent', 'mcp'],
      categories: ['runbook'],
      groups: ['operators'],
    });
    expect(created.item.frontmatter.source).toMatchObject({
      type: 'mcp',
      tool: 'create_item',
      client: { name: 'vitest-agent', version: '0.1.0' },
      client_request_id: 'req-visible-1',
    });

    const rest = await request(app.getHttpServer())
      .get(`/api/v1/items/${created.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(rest.body.item.title).toBe('MCP Draft Runbook');

    const search = await request(app.getHttpServer())
      .get('/api/v1/search?q=banana-token&include_drafts=1')
      .set('Cookie', cookie)
      .expect(200);
    expect(search.body.results.map((r: { id: string }) => r.id)).toContain(created.id);
  });

  it('returns the existing item for a repeated client_request_id instead of creating a duplicate', async () => {
    const first = await tool.execute(userId, {
      title: 'Retry Safe Create',
      body: 'same body',
      client_request_id: 'retry-safe-1',
      client: { name: 'vitest-agent' },
    });
    const second = await tool.execute(userId, {
      title: 'Retry Safe Create',
      body: 'same body',
      client_request_id: 'retry-safe-1',
      client: { name: 'vitest-agent' },
    });

    expect(second.id).toBe(first.id);
    expect(second.idempotency).toMatchObject({ replayed: true, key: 'client_request_id:retry-safe-1' });
    expect(second.warnings).toContain('idempotent replay: returning existing MCP-created item');

    const listed = await request(app.getHttpServer())
      .get('/api/v1/items?q=Retry%20Safe%20Create')
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.body.items.filter((item: { title: string }) => item.title === 'Retry Safe Create')).toHaveLength(1);
  });

  it('scopes idempotency replays to the effective space and supports source_fingerprint replay', async () => {
    const fingerprintFirst = await tool.execute(userId, {
      title: 'Fingerprint Safe Create',
      body: 'same body',
      source_fingerprint: 'fingerprint-safe-1',
      space: 'Ops',
    });
    const fingerprintSecond = await tool.execute(userId, {
      title: 'Fingerprint Safe Create',
      body: 'same body but ignored by explicit fingerprint replay',
      source_fingerprint: 'fingerprint-safe-1',
      space: 'Ops',
    });
    expect(fingerprintSecond.id).toBe(fingerprintFirst.id);
    expect(fingerprintSecond.idempotency).toMatchObject({ replayed: true, key: 'source_fingerprint:fingerprint-safe-1' });

    const inboxFirst = await tool.execute(userId, {
      title: 'Scoped Retry Safe Create',
      body: 'same title and request id, space one',
      client_request_id: 'scoped-retry-safe-1',
      space: 'Agent Inbox A',
    });
    const inboxSecond = await tool.execute(userId, {
      title: 'Scoped Retry Safe Create',
      body: 'same title and request id, space two',
      client_request_id: 'scoped-retry-safe-1',
      space: 'Agent Inbox B',
    });
    expect(inboxSecond.id).not.toBe(inboxFirst.id);
    expect(inboxSecond.duplicate_title).toMatchObject({ duplicate: false, scope: 'agent-inbox-b' });
  });

  it('reports duplicate-title diagnostics before allowing a non-idempotent duplicate write', async () => {
    await tool.execute(userId, { title: 'Duplicate MCP Title', body: 'one', client_request_id: 'dup-1' });

    await expect(
      tool.execute(userId, { title: 'Duplicate MCP Title', body: 'two', client_request_id: 'dup-2' }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: expect.objectContaining({
        message: expect.stringContaining('already exists'),
        duplicate_title: expect.objectContaining({ duplicate: true, matches: expect.arrayContaining([expect.objectContaining({ title: 'Duplicate MCP Title' })]) }),
      }),
    });
  });
});
