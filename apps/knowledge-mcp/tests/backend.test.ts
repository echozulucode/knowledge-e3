/**
 * The multi-source backend and the app's tool list: per-source result groups
 * (never one merged ranking), source-qualified refs, ambiguity, the optional
 * `source` argument, validation, and the absence of any write tool.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_TOOL_DESCRIPTORS } from '@echozedlabs/mcp-tools';
import { createKnowledgeMcp, type KnowledgeMcp } from '../src/server.js';
import { captureLogger, CORPUS, tempDir, writeFiles } from './helpers.js';

describe('multi-source backend and tools', () => {
  let a: ReturnType<typeof tempDir>;
  let b: ReturnType<typeof tempDir>;
  let mcp: KnowledgeMcp;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool(name, args);
    return { result, data: (result as { structuredContent?: Record<string, any> }).structuredContent as Record<string, any> };
  };

  beforeEach(async () => {
    a = tempDir();
    b = tempDir();
    writeFiles(a.dir, CORPUS);
    writeFiles(b.dir, {
      'pump-notes.md': '---\ntitle: Pump Notes\ntags: [pumps]\n---\n\nPersonal pump notes: pump pump pump pump.\n',
      'deploy.md': '---\ntitle: Deploy Guide\n---\n\nMy own deploy guide.\n',
    });
    mcp = await createKnowledgeMcp(
      {
        sources: [
          { id: 'handbook', type: 'folder', path: a.dir, default_status: 'published' },
          { id: 'mine', type: 'folder', path: b.dir, default_status: 'published' },
        ],
      },
      captureLogger().logger,
    );
  });
  afterEach(() => {
    a.cleanup();
    b.cleanup();
  });

  it('lists the shared read tools (same names and base arguments) plus list_sources and refresh, and no write tool', () => {
    const names = mcp.tools.map((t) => t.descriptor.name);
    expect(names).toEqual([...READ_TOOL_DESCRIPTORS.map((d) => d.name), 'knowledge.list_sources', 'knowledge.refresh']);
    for (const shared of READ_TOOL_DESCRIPTORS) {
      const local = mcp.tools.find((t) => t.descriptor.name === shared.name)!.descriptor;
      expect(Object.keys(local.inputSchema.properties)).toEqual(expect.arrayContaining(Object.keys(shared.inputSchema.properties)));
      expect(local.inputSchema.required).toEqual(shared.inputSchema.required);
      expect(local.write).toBeUndefined();
    }
    for (const write of ['create_item', 'update_item', 'publish_item', 'import_okf', 'export_okf', 'suggest_metadata']) {
      expect(names).not.toContain(`knowledge.${write}`);
    }
    const search = mcp.tools.find((t) => t.descriptor.name === 'knowledge.search')!.descriptor;
    expect(search.description).toContain('PER SOURCE');
    expect(search.inputSchema.properties['source']).toMatchObject({ enum: ['handbook', 'mine'] });
    const text = JSON.stringify(mcp.tools.map((t) => t.descriptor)).toLowerCase();
    for (const word of ['semantic', 'vector', 'embedding', 'fuzzy']) expect(text).not.toContain(word);
  });

  it('returns one group per source, each in its own rank order, never a merged list', async () => {
    const { data } = await call('knowledge.search', { q: 'pump' });
    expect(data['result_order']).toBe('per-source');
    expect(data['results']).toBeUndefined();
    expect(data['sources'].map((g: any) => [g.source, g.source_type, g.total])).toEqual([
      ['handbook', 'folder', 2],
      ['mine', 'folder', 1],
    ]);
    expect(data['total']).toBe(3);
    for (const group of data['sources']) {
      for (const hit of group.results) {
        expect(hit.source).toBe(group.source);
        expect(hit.ref).toBe(`${group.source}:${hit.id}`);
      }
      const scores = group.results.map((h: any) => h.score);
      expect([...scores].sort((x: number, y: number) => y - x)).toEqual(scores);
    }

    const only = (await call('knowledge.search', { q: 'pump', source: 'mine' })).data;
    expect(only['sources'].map((g: any) => g.source)).toEqual(['mine']);
    const bad = await call('knowledge.search', { q: 'pump', source: 'nope' });
    expect(bad.result).toMatchObject({ isError: true });
    expect((bad.result as any).content[0].text).toContain('Unknown source "nope"');
  });

  it('resolves source-qualified refs, refuses ambiguous plain ones, and honours `source`', async () => {
    const hit = (await call('knowledge.search', { q: 'modbus' })).data['sources'][0].results[0];
    const got = await call('knowledge.get_item', { id: hit.ref });
    expect(got.data['item']).toMatchObject({ source: 'handbook', ref: 'handbook:item-pump', title: 'Pump Restart Runbook', path: 'ops/concepts/pump-restart.md' });
    expect(got.data['item'].url).toBeUndefined();

    expect((await call('knowledge.get_item', { slug: 'mine:pump-notes' })).data['item'].title).toBe('Pump Notes');
    expect((await call('knowledge.get_item', { id: 'item-valve' })).data['item'].source).toBe('handbook');

    const ambiguous = await call('knowledge.get_item', { title: 'Deploy Guide' });
    expect(ambiguous.result).toMatchObject({ isError: true, structuredContent: { error: { rpc_code: -32009, matches: ['handbook:item-deploy', 'mine:deploy'] } } });
    expect((await call('knowledge.get_item', { title: 'Deploy Guide', source: 'mine' })).data['item'].ref).toBe('mine:deploy');

    const missing = await call('knowledge.get_item', { id: 'handbook:nope' });
    expect(missing.result).toMatchObject({ isError: true, structuredContent: { error: { rpc_code: -32004 } } });
    const conflict = await call('knowledge.get_item', { id: 'handbook:item-pump', source: 'mine' });
    expect(conflict.result).toMatchObject({ isError: true, structuredContent: { error: { rpc_code: -32602 } } });
  });

  it('lists topics and taxonomy labelled by source, and content types from the shared registry', async () => {
    const spaces = (await call('knowledge.list_spaces')).data;
    expect(spaces['spaces'].map((s: any) => `${s.source}:${s.slug}`)).toEqual(['handbook:ops', 'handbook:platform']);
    const taxonomy = (await call('knowledge.list_taxonomy', { source: 'mine' })).data;
    expect(taxonomy['tags']).toEqual([expect.objectContaining({ source: 'mine', slug: 'pumps', count: 1 })]);
    const types = (await call('knowledge.list_content_types')).data;
    expect(types['content_types'].map((t: any) => t.label)).toEqual(expect.arrayContaining(['Runbook', 'FAQ']));
  });

  it('validates a draft against local vocabulary without writing anything', async () => {
    const draft = '---\ntitle: New\ntype: Runbook\ncategories: [runbooks]\ntags: [pumps, brand-new-tag]\n---\n\nSee [[Valve Checklist]] and [[Nowhere Page]].\n';
    const { data } = await call('knowledge.validate_item', { raw_markdown: draft, published: true });
    const codes = data['diagnostics'].map((d: any) => d.code);
    expect(data['ok']).toBe(false); // publish rules: description is required
    expect(codes).toEqual(expect.arrayContaining(['description.missing']));
    expect(JSON.stringify(data['diagnostics'])).toContain('brand-new-tag');
    expect(JSON.stringify(data['diagnostics'])).toContain('Nowhere Page');
    expect(JSON.stringify(data['diagnostics'])).not.toContain('Valve Checklist');

    const bundle = await call('knowledge.validate_okf_bundle', { files: [{ path: 'concepts/x.md', content: '---\ntitle: X\n---\nbody' }] });
    expect(bundle.data['summary']).toMatchObject({ conformant: false });
    expect(bundle.data['summary_line']).toContain('Not an OKF bundle');
  });

  it('lists sources and refreshes a local source from disk', async () => {
    const listed = (await call('knowledge.list_sources')).data;
    expect(listed['sources']).toEqual([
      expect.objectContaining({ id: 'handbook', type: 'folder', status: 'ready', items: 4, path: a.dir }),
      expect.objectContaining({ id: 'mine', type: 'folder', status: 'ready', items: 2 }),
    ]);
    writeFileSync(join(b.dir, 'fresh.md'), '# Freshly Added\n\nfreshword\n');
    expect((await call('knowledge.search', { q: 'freshword' })).data['total']).toBe(0);
    const refreshed = (await call('knowledge.refresh', { source: 'mine' })).data;
    expect(refreshed['sources']).toEqual([expect.objectContaining({ id: 'mine', items: 3 })]);
    expect((await call('knowledge.search', { q: 'freshword' })).data['total']).toBe(1);
  });

  it('answers an unknown tool with a public error and hides unexpected failures behind a correlation id', async () => {
    const unknown = await mcp.callTool('knowledge.create_item', { title: 'x' });
    expect(unknown).toMatchObject({ isError: true, structuredContent: { error: { rpc_code: -32004 } } });
    const failing = mcp.tools.find((t) => t.descriptor.name === 'knowledge.list_spaces')!;
    failing.call = async () => {
      throw new Error('EACCES: internal path C:/secret/place');
    };
    const hidden = await mcp.callTool('knowledge.list_spaces', {});
    expect(JSON.stringify(hidden)).not.toContain('secret/place');
    expect((hidden as any).content[0].text).toMatch(/^Internal error \(correlation id: [0-9a-f]{12}\)$/);
  });
});
