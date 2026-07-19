/**
 * published_at — stable, git-of-record publish dates for chronological feeds
 * (demo-wave plan Phase 4.1).
 *
 * Distinct from updated_at so editing a published post does not re-date or
 * reorder it. Stamped on the first draft->published transition, settable from
 * frontmatter, and — because it is written INTO frontmatter — it survives a
 * rebuild-from-git.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { PagesService } from '../src/pages/pages.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';

describe('published_at e2e', () => {
  let app: INestApplication;
  let pages: PagesService;
  let rebuild: IndexRebuildService;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    pages = app.get(PagesService);
    rebuild = app.get(IndexRebuildService);
  });
  afterEach(async () => app.close());

  it('is null for a draft and stamped on first publish', async () => {
    const draft = await pages.create(adminId, { title: 'Draft Post', body: 'x', status: 'draft' });
    expect(draft.published_at).toBeNull();

    const published = await pages.update({ id: adminId, role: 'admin' }, draft.id, draft.version_token, {
      status: 'published',
    });
    expect(published.published_at).not.toBeNull();
    // The stamp is written into frontmatter (the git-of-record source of truth).
    expect(published.frontmatter['published_at']).toBe(published.published_at);
  });

  it('does not change the publish date on a later edit', async () => {
    const p = await pages.create(adminId, { title: 'Stable Date', body: 'v1', status: 'published' });
    const firstDate = p.published_at;
    expect(firstDate).not.toBeNull();

    const edited = await pages.update({ id: adminId, role: 'admin' }, p.id, p.version_token, {
      body: 'v2 — a typo fix should not re-date the post',
    });
    expect(edited.published_at).toBe(firstDate);
    // updated_at DID move; published_at did not.
    expect(edited.updated_at).not.toBe(edited.published_at);
  });

  it('honours an explicit publish date from frontmatter', async () => {
    const p = await pages.create(adminId, {
      title: 'Backdated',
      body: 'x',
      status: 'published',
      frontmatter: { published_at: '2020-01-15T00:00:00.000Z' },
    });
    expect(p.published_at).toBe('2020-01-15T00:00:00.000Z');
  });

  it('preserves the original date when unpublished and re-published', async () => {
    const p = await pages.create(adminId, { title: 'Toggle', body: 'x', status: 'published' });
    const original = p.published_at;

    const back = await pages.update({ id: adminId, role: 'admin' }, p.id, p.version_token, { status: 'draft' });
    expect(back.published_at).toBe(original); // kept, not cleared

    const again = await pages.update({ id: adminId, role: 'admin' }, back.id, back.version_token, { status: 'published' });
    expect(again.published_at).toBe(original); // not re-stamped
  });

  it('orders a feed by publish date, newest first', async () => {
    await pages.create(adminId, { title: 'Old', body: 'x', status: 'published', frontmatter: { published_at: '2021-01-01T00:00:00.000Z' } });
    await pages.create(adminId, { title: 'New', body: 'x', status: 'published', frontmatter: { published_at: '2024-01-01T00:00:00.000Z' } });
    await pages.create(adminId, { title: 'Mid', body: 'x', status: 'published', frontmatter: { published_at: '2022-06-01T00:00:00.000Z' } });

    const feed = await pages.list({ status: 'published', sort: 'published' }, { id: adminId, role: 'admin' });
    expect(feed.map((p) => p.title)).toEqual(['New', 'Mid', 'Old']);
  });

  it('survives a rebuild-from-git (the date is in frontmatter, not just the DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-pubdate-'));
    try {
      const concept = {
        path: 'concepts/dated.md',
        content: [
          '---',
          'type: blog-post',
          'title: Dated Post',
          'e3_id: page_dated',
          'e3_status: published',
          "published_at: '2023-03-03T00:00:00.000Z'",
          '---',
          '',
          'Body.',
          '',
        ].join('\n'),
      };
      const report = await rebuild.rebuildFromFiles([concept], { actorId: adminId });
      expect(report.pages).toBe(1);
      const page = await pages.getById('page_dated', { actor: { id: adminId, role: 'admin' } });
      expect(page?.published_at).toBe('2023-03-03T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
