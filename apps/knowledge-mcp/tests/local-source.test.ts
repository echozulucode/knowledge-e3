/**
 * Local folder sources: how files become items (the server's mapping), and
 * keyword search parity on a small corpus — query syntax, filters, drafts,
 * excerpts and highlights, grouping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeSearchInput } from '@echozedlabs/mcp-tools';
import type { FolderSourceConfig } from '../src/config.js';
import { FolderSource, loadLocalIndex } from '../src/sources/folder.js';
import { captureLogger, CORPUS, tempDir, writeFiles } from './helpers.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');

function config(path: string, extra: Partial<FolderSourceConfig> = {}): FolderSourceConfig {
  return { id: 'notes', type: 'folder', path, default_status: 'published', ...extra };
}

describe('local folder source', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    writeFiles(dir, CORPUS);
  });
  afterEach(() => cleanup());

  const search = async (args: Record<string, unknown>) => {
    const { index } = loadLocalIndex(config(dir), captureLogger().logger, () => NOW);
    return index.search(normalizeSearchInput(args));
  };
  const titles = (r: { results: { title: string }[] }) => r.results.map((h) => h.title);

  describe('mapping files to items', () => {
    it('reads the OKF layout the way the server rebuild does', () => {
      const { index } = loadLocalIndex(config(dir), captureLogger().logger, () => NOW);
      expect(index.size).toBe(4); // index.md is presentation, not an item
      const pump = index.find('item-pump')!;
      expect(pump).toMatchObject({
        id: 'item-pump',
        slug: 'pump-restart',
        title: 'Pump Restart Runbook',
        status: 'published',
        type: 'Runbook',
        space_id: 'ops',
        topic_name: 'ops',
        description: 'How to restart the modbus pump controller.',
        tags: ['modbus', 'pumps'],
        categories: ['runbooks'],
        groups: ['plant-operators'],
        updated_at: '2026-09-01T10:00:00.000Z',
        file: 'ops/concepts/pump-restart.md',
      });
      expect(pump.body_markdown.startsWith('Stop the line')).toBe(true);
      expect(index.find('item-deploy')!.trust_tier).toBe('human-reviewed');
      expect(index.find('pump-restart')!.id).toBe('item-pump'); // slug lookup
    });

    it('reads a plain notes folder as every *.md, titled from the heading or file name', () => {
      const plain = tempDir();
      try {
        writeFiles(plain.dir, {
          'README.md': '# Team Notes\n\nWelcome.\n',
          'how-to/reset_password.md': 'Use the portal to reset a password.\n',
          'index.md': '# not an item\n',
          '.git/config': '[core]\n',
          '.obsidian/workspace.md': '# editor state\n',
          'node_modules/pkg/readme.md': '# dependency\n',
        });
        const { index } = loadLocalIndex(config(plain.dir, { topic: 'Team' }), captureLogger().logger, () => NOW);
        expect(index.items.map((i) => [i.id, i.title, i.space_id, i.status]).sort()).toEqual([
          ['README', 'Team Notes', 'team', 'published'],
          ['how-to/reset_password', 'Reset Password', 'team', 'published'],
        ]);
      } finally {
        plain.cleanup();
      }
    });

    it('honours default_status, include/exclude globs and the ids the server recorded in .e3/ids.json', () => {
      const plain = tempDir();
      try {
        writeFiles(plain.dir, {
          'docs/a.md': '# A\n',
          'docs/skip/b.md': '# B\n',
          'other/c.md': '# C\n',
          '.e3/ids.json': JSON.stringify({ version: 1, ids: { 'docs/a.md': 'server-id-a' } }),
        });
        const { index } = loadLocalIndex(
          config(plain.dir, { include: ['docs/**/*.md'], exclude: ['docs/skip/**'], default_status: 'draft' }),
          captureLogger().logger,
          () => NOW,
        );
        expect(index.items.map((i) => [i.id, i.status])).toEqual([['server-id-a', 'draft']]);
      } finally {
        plain.cleanup();
      }
    });

    it('presents topics with counts and the index.md presentation', async () => {
      const source = new FolderSource(config(dir), captureLogger().logger);
      await source.load();
      const spaces = (await source.listSpaces()) as Record<string, unknown>[];
      expect(spaces.map((s) => s['slug'])).toEqual(['ops', 'platform']);
      expect(spaces[0]).toMatchObject({ source: 'notes', presentation: 'docs', start_here: 'pump-restart', counts: { items: 3, published: 2, draft: 1 } });
      const taxonomy = await source.listTaxonomy();
      expect(taxonomy.groups).toEqual([expect.objectContaining({ source: 'notes', slug: 'plant-operators', name: 'plant-operators', count: 1 })]);
    });
  });

  describe('keyword search parity', () => {
    it('requires every term (implicit AND) and ranks the title match first', async () => {
      const r = await search({ q: 'pump restart' });
      expect(titles(r)).toEqual(['Pump Restart Runbook']);
      expect((await search({ q: 'pump' })).results.map((h) => h.title)).toEqual(['Pump Restart Runbook', 'Valve Checklist']);
    });

    it('never returns drafts unless asked, by flag, status or is:draft', async () => {
      expect(titles(await search({ q: 'pump' }))).not.toContain('Draft Pump Idea');
      expect(titles(await search({ q: 'pump', include_drafts: true }))).toContain('Draft Pump Idea');
      expect(titles(await search({ q: 'pump', status: 'draft' }))).toEqual(['Draft Pump Idea']);
      expect(titles(await search({ q: 'pump is:draft' }))).toEqual(['Draft Pump Idea']);
    });

    it('applies key:value filters (OR within a key, AND across keys) and exclusions', async () => {
      expect(titles(await search({ q: 'type:runbook' })).sort()).toEqual(['Deploy Guide', 'Pump Restart Runbook']);
      expect(titles(await search({ q: 'type:runbook topic:ops' }))).toEqual(['Pump Restart Runbook']);
      expect(titles(await search({ q: 'tag:valves tag:deploy', sort: 'az' }))).toEqual(['Deploy Guide', 'Valve Checklist']);
      expect(titles(await search({ q: 'pump -controller' }))).toEqual(['Valve Checklist']);
      expect(titles(await search({ q: 'type:runbook -tag:deploy' }))).toEqual(['Pump Restart Runbook']);
      expect(titles(await search({ type: 'Checklist' }))).toEqual(['Valve Checklist']);
      expect(titles(await search({ space: 'platform' }))).toEqual(['Deploy Guide']);
      expect(titles(await search({ category: 'runbooks' }))).toEqual(['Pump Restart Runbook']);
      expect(titles(await search({ group: 'plant-operators' }))).toEqual(['Pump Restart Runbook']);
    });

    it('supports author:, updated:, is:verified, phrases, prefixes and aliases', async () => {
      expect(titles(await search({ q: 'author:"grace hopper"' }))).toEqual(['Valve Checklist']);
      expect(titles(await search({ q: 'updated:<2026-01-01' }))).toEqual(['Valve Checklist']);
      expect(titles(await search({ q: 'is:verified' }))).toEqual(['Deploy Guide']);
      expect(titles(await search({ q: '"pump controller"' }))).toEqual(['Pump Restart Runbook']);
      expect(titles(await search({ q: '"pump contr"' }))).toEqual([]);
      expect(titles(await search({ q: 'modb' }))).toEqual(['Pump Restart Runbook']);
      expect(titles(await search({ q: 'mbpc' }))).toEqual(['Pump Restart Runbook']);
    });

    it('is lexical only: no stemming, no approximate matches', async () => {
      expect(titles(await search({ q: 'restarted' }))).toEqual([]);
      expect(titles(await search({ q: 'pumpp' }))).toEqual([]);
    });

    it('returns plain-text excerpts with highlight ranges into the returned strings', async () => {
      const r = await search({ q: 'modbus' });
      const hit = r.results[0]!;
      expect(hit.snippet).toBe('Stop the line, then restart the modbus pump controller from the panel. See Valve Checklist before restarting.');
      expect(hit.snippet).not.toContain('**');
      expect(hit.snippet).not.toContain('[[');
      const [start, end] = hit.highlights!.snippet![0]!;
      expect(hit.snippet!.slice(start, end)).toBe('modbus');
      expect(hit).toMatchObject({ source: 'notes', ref: 'notes:item-pump', path: 'ops/concepts/pump-restart.md', topic: 'ops' });
      expect(hit.matched_fields).toEqual(expect.arrayContaining(['description', 'body', 'tags']));
      const titleHit = (await search({ q: 'checklist' })).results.find((h) => h.title === 'Valve Checklist')!;
      const [ts, te] = titleHit.highlights!.title![0]!;
      expect(titleHit.title.slice(ts, te)).toBe('Checklist');
    });

    it('counts every match, caps the page, facets and groups by type, and explains an empty result', async () => {
      const r = await search({ q: 'type:runbook', limit: 1, sort: 'az' });
      expect(r.total).toBe(2);
      expect(r.results).toHaveLength(1);
      expect(r.facets.types).toEqual([{ value: 'runbook', label: 'Runbook', count: 2, active: true }]);
      expect(r.groups.map((g) => [g.label, g.total])).toEqual([['Runbook', 1]]);
      const empty = await search({ q: 'nothingmatchesthis tag:pumps' });
      expect(empty.results).toEqual([]);
      expect(empty.empty_state?.guidance[0]).toContain('Tag');
      expect((await search({ q: 'is:bogus pump' })).warnings.length).toBeGreaterThan(0);
    });
  });
});
