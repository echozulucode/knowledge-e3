import { describe, expect, it } from 'vitest';
import {
  callReadTool,
  createReadTools,
  GET_ITEM_TOOL,
  internalToolError,
  isReadToolName,
  KnowledgeToolError,
  mapKnownToolError,
  normalizeBundleFiles,
  normalizeItemRef,
  normalizeSearchInput,
  normalizeValidateItemInput,
  normalizeValidateOkfBundleInput,
  READ_TOOL_DESCRIPTORS,
  rpcCodeForStatus,
  sanitizeErrorData,
  SEARCH_TOOL,
  toMcpItem,
  toolErrorResult,
  toolSuccessResult,
  validationResult,
  type KnowledgeReadBackend,
} from '../src/index.js';

describe('read tool descriptors', () => {
  it('declares exactly the seven read tools, none of them a write', () => {
    expect(READ_TOOL_DESCRIPTORS.map((d) => d.name)).toEqual([
      'knowledge.list_spaces',
      'knowledge.list_taxonomy',
      'knowledge.list_content_types',
      'knowledge.search',
      'knowledge.validate_okf_bundle',
      'knowledge.validate_item',
      'knowledge.get_item',
    ]);
    for (const d of READ_TOOL_DESCRIPTORS) {
      expect(d.write, d.name).toBeUndefined();
      expect(d.inputSchema.type).toBe('object');
      expect(d.inputSchema.additionalProperties).toBe(false);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });

  it('keeps the search and get_item schemas the server has always advertised', () => {
    expect(Object.keys(SEARCH_TOOL.inputSchema.properties)).toEqual([
      'q',
      'space',
      'tag',
      'category',
      'group',
      'type',
      'status',
      'limit',
      'sort',
      'include_drafts',
    ]);
    expect(SEARCH_TOOL.inputSchema.properties['sort']).toMatchObject({ enum: ['relevance', 'newest', 'oldest', 'az', 'verified'] });
    expect(Object.keys(GET_ITEM_TOOL.inputSchema.properties)).toEqual(['id', 'slug', 'title']);
  });

  it('says nothing about semantic, vector, embedding or fuzzy search', () => {
    const text = JSON.stringify(READ_TOOL_DESCRIPTORS).toLowerCase();
    for (const word of ['semantic', 'vector', 'embedding', 'fuzzy']) expect(text).not.toContain(word);
  });
});

describe('input normalization', () => {
  it('drops wrong-typed search arguments instead of coercing them', () => {
    expect(
      normalizeSearchInput({ q: 42, tag: 'ops', status: 'archived', sort: 'random', include_drafts: 'yes', limit: '5' }),
    ).toEqual({
      q: undefined,
      space: undefined,
      tag: 'ops',
      category: undefined,
      group: undefined,
      type: undefined,
      status: undefined,
      include_drafts: false,
      sort: 'relevance',
      limit: undefined,
    });
    expect(normalizeSearchInput({ status: 'draft', sort: 'verified', include_drafts: true, limit: 3 })).toMatchObject({
      status: 'draft',
      sort: 'verified',
      include_drafts: true,
      limit: 3,
    });
  });

  it('trims item refs and ignores blanks', () => {
    expect(normalizeItemRef({ id: '  abc ', slug: '   ', title: 7 })).toEqual({ id: 'abc' });
  });

  it('normalizes validate inputs', () => {
    expect(normalizeValidateItemInput({})).toEqual({ raw_markdown: '' });
    expect(normalizeValidateItemInput({ raw_markdown: '# x', topic: ' ops ', published: true })).toEqual({
      raw_markdown: '# x',
      topic: 'ops',
      published: true,
    });
    expect(normalizeBundleFiles([{ path: 'a.md', content: 'x' }, { path: 1 }, null, 'nope'])).toEqual([{ path: 'a.md', content: 'x' }]);
    expect(normalizeValidateOkfBundleInput({ files: 'x', topic: '' })).toEqual({ files: [] });
  });
});

describe('call routing', () => {
  const calls: string[] = [];
  const backend: KnowledgeReadBackend<{ who: string }> = {
    search: async (input, ctx) => {
      calls.push(`search:${input.q}:${input.sort}:${ctx.who}`);
      return { results: [] };
    },
    getItem: async (ref) => {
      calls.push(`get:${ref.id ?? ref.slug}`);
      return { item: null };
    },
    listSpaces: async () => ({ spaces: [], total: 0 }),
    listTaxonomy: async () => ({ tags: [], categories: [], groups: [] }),
    listContentTypes: async () => ({ content_types: [] }),
    validateItem: async (input) =>
      validationResult(input.raw_markdown ? [] : [{ code: 'x', severity: 'error', message: 'empty' }]),
    validateOkfBundle: async () => {
      throw new Error('not used');
    },
  };

  it('normalizes then dispatches to the backend with the host context', async () => {
    await callReadTool('knowledge.search', backend, { q: 'pump', sort: 'nope' }, { who: 'eric' });
    await callReadTool('knowledge.get_item', backend, { slug: ' pump-guide ' }, { who: 'eric' });
    expect(calls).toEqual(['search:pump:relevance:eric', 'get:pump-guide']);
    expect(await callReadTool('knowledge.validate_item', backend, {}, { who: 'eric' })).toEqual({
      ok: false,
      diagnostics: [{ code: 'x', severity: 'error', message: 'empty' }],
      counts: { error: 1, warning: 0, info: 0 },
    });
  });

  it('builds the tool list in canonical order and allows a same-name descriptor override only', () => {
    const tools = createReadTools(backend, { descriptors: { 'knowledge.search': { ...SEARCH_TOOL, description: 'local' } } });
    expect(tools.map((t) => t.descriptor.name)).toEqual(READ_TOOL_DESCRIPTORS.map((d) => d.name));
    expect(tools.find((t) => t.descriptor.name === 'knowledge.search')!.descriptor.description).toBe('local');
    expect(() => createReadTools(backend, { descriptors: { 'knowledge.search': { ...SEARCH_TOOL, name: 'other' } } })).toThrow(/renames/);
    expect(isReadToolName('knowledge.search')).toBe(true);
    expect(isReadToolName('knowledge.create_item')).toBe(false);
  });
});

describe('results', () => {
  it('maps an item view to the MCP item shape, preferring frontmatter space, then topic, then space_id', () => {
    const base = {
      id: 'i1',
      slug: 'pump',
      title: 'Pump',
      status: 'published' as const,
      type: 'Runbook',
      space_id: 's1',
      tags: ['a'],
      categories: ['c'],
      groups: [],
      updated_at: '2026-01-01T00:00:00Z',
      version_token: 3,
      body_markdown: 'body',
      raw_markdown: '---\n---\nbody',
      frontmatter: { topic: 'Ops' },
      trust_tier: 'unverified' as const,
    };
    const item = toMcpItem(base);
    expect(item).toMatchObject({ id: 'i1', space: 'Ops', path: '/items/i1', url: '/p/pump', trust_tier: 'unverified' });
    expect(Object.keys(item).slice(0, 6)).toEqual(['id', 'slug', 'title', 'status', 'type', 'space']);
    expect(toMcpItem({ ...base, frontmatter: {} }).space).toBe('s1');
    expect(toMcpItem({ ...base, frontmatter: { space: 'Eng', topic: 'Ops' } }).space).toBe('Eng');
  });
});

describe('errors', () => {
  it('maps statuses to the JSON-RPC server range', () => {
    expect([400, 401, 403, 404, 409, 500].map(rpcCodeForStatus)).toEqual([-32602, -32001, -32003, -32004, -32009, -32000]);
  });

  it('maps a KnowledgeToolError publicly and leaves anything else to the host', () => {
    const mapped = mapKnownToolError(new KnowledgeToolError(401, 'source "intranet" refused the request', { source: 'intranet' }));
    expect(mapped).toEqual({
      code: -32001,
      message: 'source "intranet" refused the request',
      data: { message: 'source "intranet" refused the request', source: 'intranet' },
    });
    expect(mapKnownToolError(new Error('SQLITE_ERROR secret'))).toBeNull();
  });

  it('sanitizes nested errors and internals out of structured data', () => {
    expect(
      sanitizeErrorData({ a: 1, stack: 'x', cause: new Error('secret'), nested: { e: new Error('boom'), ok: true }, at: new Date(0) }),
    ).toEqual({ a: 1, nested: { ok: true }, at: '1970-01-01T00:00:00.000Z' });
  });

  it('renders the isError envelope with rpc_code and the correlation id in the text', () => {
    const env = toolErrorResult(internalToolError('abc123abc123'));
    expect(env.isError).toBe(true);
    expect(env.content[0]!.text).toBe('Internal error (correlation id: abc123abc123)');
    expect(env.structuredContent).toEqual({ error: { correlation_id: 'abc123abc123', message: 'Internal error', rpc_code: -32603 } });
    expect(JSON.parse(env.content[1]!.text).error.rpc_code).toBe(-32603);
  });

  it('renders a success with structuredContent only for objects', () => {
    expect(toolSuccessResult({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }], structuredContent: { a: 1 } });
    expect(toolSuccessResult([1])).toEqual({ content: [{ type: 'text', text: '[\n  1\n]' }] });
  });
});
