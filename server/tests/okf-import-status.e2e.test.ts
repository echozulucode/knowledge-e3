/**
 * OKF import lifecycle-state resolution e2e.
 *
 * E3 has exactly two statuses (draft | published), but bundles are hand-authored
 * and reach for other words. Previously ONLY the exact strings 'draft' and
 * 'published' were understood and anything else was silently discarded, so a
 * concept marked `state: released` imported as a draft and never appeared — the
 * item was there, just invisible to anonymous readers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';
import { ItemsService } from '../src/items/items.service.js';

function concept(title: string, frontmatter: Record<string, string>): { path: string; content: string } {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    path: `concepts/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    content: `---\ntype: concept\ntitle: ${title}\n${fm}\n---\n\nBody of ${title}.\n`,
  };
}

describe('OKF import status resolution e2e', () => {
  let app: INestApplication;
  let importer: OkfImportService;
  let items: ItemsService;
  let actor: { id: string; role: 'admin' };

  beforeEach(async () => {
    app = await makeApp();
    const { userId } = await seedAdminAndLogin(app);
    actor = { id: userId, role: 'admin' };
    importer = app.get(OkfImportService);
    items = app.get(ItemsService);
  });
  afterEach(async () => {
    delete process.env['KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS'];
    await app.close();
  });

  async function statusOf(title: string): Promise<string | undefined> {
    const item = await items.getByTitle(title, actor);
    return item?.status;
  }

  it('reads `state: released` as published — the case that silently vanished', async () => {
    await importer.importBundleFiles(actor, [concept('Released Thing', { state: 'released' })]);
    expect(await statusOf('Released Thing')).toBe('published');
  });

  it.each([
    ['state', 'released', 'published'],
    ['state', 'Released', 'published'],
    ['state', 'LIVE', 'published'],
    ['status', 'Published', 'published'],
    ['status', 'final', 'published'],
    ['state', 'wip', 'draft'],
    ['state', 'unreleased', 'draft'],
    ['status', 'draft', 'draft'],
  ])('maps %s: %s -> %s (case-insensitive)', async (key, value, expected) => {
    const title = `Item ${key} ${value}`;
    await importer.importBundleFiles(actor, [concept(title, { [key]: value })]);
    expect(await statusOf(title)).toBe(expected);
  });

  it('honours precedence: e3_status beats status beats state', async () => {
    await importer.importBundleFiles(actor, [
      concept('Precedence One', { e3_status: 'draft', status: 'published', state: 'released' }),
    ]);
    expect(await statusOf('Precedence One')).toBe('draft');

    await importer.importBundleFiles(actor, [concept('Precedence Two', { status: 'draft', state: 'released' })]);
    expect(await statusOf('Precedence Two')).toBe('draft');
  });

  it('applies the caller default when no state is declared, and reports it', async () => {
    const res = await importer.importBundleFiles(
      actor,
      [concept('No State A', {}), concept('No State B', {}), concept('Has State', { state: 'released' })],
      { defaultStatus: 'published' },
    );
    expect(res.created).toBe(3);
    expect(res.defaulted).toBe(2); // only the two with no declared state
    expect(res.default_status).toBe('published');
    expect(await statusOf('No State A')).toBe('published');
    expect(await statusOf('Has State')).toBe('published');
  });

  it('falls back to draft instance-wide, and the env var flips it', async () => {
    await importer.importBundleFiles(actor, [concept('Fallback Draft', {})]);
    expect(await statusOf('Fallback Draft')).toBe('draft');

    process.env['KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS'] = 'published';
    const res = await importer.importBundleFiles(actor, [concept('Fallback Published', {})]);
    expect(await statusOf('Fallback Published')).toBe('published');
    expect(res.default_status).toBe('published');
  });

  it('reports an unrecognized value instead of swallowing it', async () => {
    const res = await importer.importBundleFiles(actor, [concept('Typo Thing', { status: 'pubished' })], {
      defaultStatus: 'published',
    });
    expect(res.unrecognized_status).toEqual([{ title: 'Typo Thing', value: 'pubished' }]);
    // It still imports, taking the default rather than being dropped.
    expect(await statusOf('Typo Thing')).toBe('published');
    expect(res.defaulted).toBe(1);
  });

  it('normalizes `state` into the canonical `status` key, not both', async () => {
    await importer.importBundleFiles(actor, [concept('Normalized', { state: 'released' })]);
    const item = await items.getByTitle('Normalized', actor);
    expect(item?.frontmatter['status']).toBe('published');
    // `state` must not survive alongside a generated `status` — the two would
    // silently diverge the moment someone edited only one of them.
    expect(item?.frontmatter['state']).toBeUndefined();
  });
});
