/**
 * `server` sources against a local stub HTTP server: GET only, the bearer token
 * from the named environment variable, 401/403/network failures as tool errors
 * that name the source — and the token nowhere in results, errors or logs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolErrorResult, mapKnownToolError } from '@echozedlabs/mcp-tools';
import { MultiSourceBackend } from '../src/backend.js';
import type { ServerSourceConfig } from '../src/config.js';
import { Redactor } from '../src/log.js';
import { RemoteSource } from '../src/sources/remote.js';
import { captureLogger, json, stubServer, type StubServer } from './helpers.js';

const TOKEN = 'kp_pat_remote_TOKEN_abcdef0123456789';
const READ_ONLY_TOKEN = 'kp_pat_forbidden_TOKEN_9876543210';

const HIT = {
  id: 'r1',
  slug: 'remote-runbook',
  title: 'Remote Runbook',
  path: '/items/r1',
  url: '/p/remote-runbook',
  updated_at: '2026-09-01T00:00:00.000Z',
  status: 'published',
  type: 'Runbook',
  score: 7.5,
  topic: 'Ops',
};

const ITEM = {
  id: 'r1',
  slug: 'remote-runbook',
  title: 'Remote Runbook',
  status: 'published',
  type: 'Runbook',
  space_id: 'space_ops',
  tags: ['pumps'],
  categories: [],
  groups: [],
  updated_at: '2026-09-01T00:00:00.000Z',
  version_token: 4,
  body_markdown: 'Remote body.',
  raw_markdown: '---\ntitle: Remote Runbook\n---\nRemote body.',
  frontmatter: { title: 'Remote Runbook', topic: 'Ops' },
  owner_id: 'u1',
  created_at: '2026-01-01T00:00:00.000Z',
  current_version_id: 'v4',
  trust_tier: 'unverified',
};

describe('server source', () => {
  let stub: StubServer;

  beforeEach(async () => {
    stub = await stubServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth === `Bearer ${READ_ONLY_TOKEN}`) return json(res, 403, { statusCode: 403, message: 'Forbidden resource' });
      if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { statusCode: 401, message: 'Unauthorized' });
      const url = new URL(req.url ?? '/', 'http://stub');
      if (req.method !== 'GET') return json(res, 405, { message: 'no' });
      if (url.pathname === '/api/v1/search') {
        return json(res, 200, { results: [HIT], total: 1, offset: 0, limit: 25, facets: {}, warnings: [], query: {}, groups: [{ key: 'Runbook', label: 'Runbook', hits: [HIT], total: 1 }] });
      }
      if (url.pathname === '/api/v1/items/r1' || url.pathname === '/api/v1/items/remote-runbook') return json(res, 200, { item: ITEM, version_token: 4 });
      if (url.pathname.startsWith('/api/v1/items/')) return json(res, 200, { item: null });
      if (url.pathname === '/api/v1/topics') {
        return json(res, 200, {
          topics: [
            { id: 'space_ops', slug: 'ops', name: 'Ops', description: null, visibility: 'public', counts: { items: 1, published: 1, draft: 0 } },
            { id: 'space_hr', slug: 'hr', name: 'HR', description: null, visibility: 'private', counts: { items: 2, published: 2, draft: 0 } },
          ],
        });
      }
      if (url.pathname === '/api/v1/taxonomy/tags') return json(res, 200, { tags: [{ id: 'pumps', name: 'pumps', slug: 'pumps', count: 1 }] });
      if (url.pathname === '/api/v1/taxonomy/categories') return json(res, 200, { categories: [] });
      if (url.pathname === '/api/v1/taxonomy/groups') return json(res, 200, { groups: [] });
      return json(res, 404, { message: 'not found' });
    });
  });
  afterEach(async () => stub.close());

  function source(env: Record<string, string>, extra: Partial<ServerSourceConfig> = {}) {
    const capture = captureLogger(new Redactor());
    const config: ServerSourceConfig = { id: 'intranet', type: 'server', url: `${stub.url}/api/v1`, token_env: 'KB_TOKEN', timeout_ms: 5000, ...extra };
    const remote = new RemoteSource(config, capture.logger, { env, redactor: capture.redactor });
    return { remote, backend: new MultiSourceBackend([remote], capture.logger), lines: capture.lines };
  }

  it('searches with the bearer token from the named variable and labels every hit with its source', async () => {
    const { remote, backend } = source({ KB_TOKEN: TOKEN });
    await remote.load();
    const r = await backend.search({ q: 'runbook', tag: 'pumps', sort: 'relevance', include_drafts: false });
    expect(stub.requests.every((q) => q.method === 'GET')).toBe(true);
    expect(stub.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stub.requests[0]!.url).toBe('/api/v1/search?q=runbook&tag=pumps&sort=relevance');
    const group = r.sources[0] as { source: string; source_type: string; results: Record<string, unknown>[]; groups: { hits: Record<string, unknown>[] }[] };
    expect(group).toMatchObject({ source: 'intranet', source_type: 'server', total: 1 });
    expect(group.results[0]).toMatchObject({ source: 'intranet', ref: 'intranet:r1', title: 'Remote Runbook', score: 7.5 });
    expect(group.groups[0]!.hits[0]).toBe(group.results[0]);

    const got = await backend.getItem({ id: 'intranet:r1' });
    expect(got.item).toMatchObject({ source: 'intranet', ref: 'intranet:r1', body_markdown: 'Remote body.', space: 'Ops', url: `${stub.url}/p/remote-runbook` });
    await expect(backend.getItem({ id: 'intranet:missing' })).rejects.toMatchObject({ status: 404 });

    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(got)).not.toContain(TOKEN);
    expect(JSON.stringify(backend.listSources())).not.toContain(TOKEN);
    expect(backend.listSources().sources[0]).toEqual({
      id: 'intranet',
      type: 'server',
      status: 'ready',
      url: `${stub.url}/api/v1`,
      token_env: 'KB_TOKEN',
      token_present: true,
    });
  });

  it('narrows to configured topics: search space, list_spaces and get_item', async () => {
    const { backend } = source({ KB_TOKEN: TOKEN }, { topics: ['ops'] });
    await backend.search({ sort: 'newest', include_drafts: false });
    expect(stub.requests.at(-1)!.url).toBe('/api/v1/search?space=ops&sort=newest');
    const outside = await backend.search({ space: 'HR', sort: 'relevance', include_drafts: false });
    expect(outside.sources[0]).toMatchObject({ total: 0, warnings: [expect.stringContaining('outside the topics')] });
    expect((await backend.listSpaces()).spaces.map((s) => (s as { slug: string }).slug)).toEqual(['ops']);

    const hrOnly = source({ KB_TOKEN: TOKEN }, { topics: ['hr'] });
    await expect(hrOnly.backend.getItem({ id: 'intranet:r1' })).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['a missing token variable', {}, 401, 'KB_TOKEN is not set'],
    ['a rejected token', { KB_TOKEN: 'kp_pat_wrong_TOKEN_000000000' }, 401, 'was not accepted'],
    ['a read-only token hitting a forbidden resource', { KB_TOKEN: READ_ONLY_TOKEN }, 403, 'forbidden'],
  ])('turns %s into a tool error naming the source, never the token', async (_label, env, status, text) => {
    const { remote, backend, lines } = source(env as Record<string, string>);
    await remote.load();
    let caught: unknown;
    try {
      await backend.search({ q: 'x', sort: 'relevance', include_drafts: false }, { source: 'intranet' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status });
    const mapped = mapKnownToolError(caught)!;
    expect(mapped.message).toContain('Source "intranet"');
    expect(mapped.message).toContain(text);
    const rendered = JSON.stringify(toolErrorResult(mapped));
    const everything = rendered + lines.join('');
    for (const secret of [TOKEN, READ_ONLY_TOKEN, 'kp_pat_wrong_TOKEN_000000000']) expect(everything).not.toContain(secret);

    // Without an explicit source the failure is one group among the answers, not a failed call.
    const all = await backend.search({ q: 'x', sort: 'relevance', include_drafts: false });
    expect(all.sources[0]).toMatchObject({ source: 'intranet', error: { rpc_code: status === 401 ? -32001 : -32003 } });
    expect(JSON.stringify(all)).not.toMatch(/kp_pat_/);
  });

  it('reports an unreachable server as a tool error naming the source', async () => {
    const url = stub.url;
    await stub.close();
    stub = await stubServer((_req, res) => json(res, 500, {}));
    const capture = captureLogger(new Redactor());
    const remote = new RemoteSource({ id: 'gone', type: 'server', url: `${url}/api/v1`, token_env: 'KB_TOKEN', timeout_ms: 2000 }, capture.logger, {
      env: { KB_TOKEN: TOKEN },
      redactor: capture.redactor,
    });
    const backend = new MultiSourceBackend([remote], capture.logger);
    await expect(backend.search({ sort: 'relevance', include_drafts: false }, { source: 'gone' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('Source "gone" is unreachable'),
    });
    expect(capture.lines.join('')).not.toContain(TOKEN);
  });

  it('redacts the token even if a server echoes it in an error message', async () => {
    await stub.close();
    stub = await stubServer((req, res) => json(res, 400, { message: `bad request for ${req.headers.authorization}` }));
    const { backend, lines } = source({ KB_TOKEN: TOKEN });
    const err = await backend.search({ q: 'x', sort: 'relevance', include_drafts: false }, { source: 'intranet' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(JSON.stringify(toolErrorResult(mapKnownToolError(err)!))).not.toContain(TOKEN);
    expect((err as Error).message).toContain('[redacted]');
    expect(lines.join('')).not.toContain(TOKEN);
  });
});
