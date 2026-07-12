import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, sql } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { WikiService } from '../src/wiki/wiki.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';
import type { RevisionMirrorEvent } from '../src/storage/revision-mirror.port.js';

/**
 * The Phase B index-rebuild drill (ADR-0001): take a live store, mirror it to a
 * git working tree of OKF files, then drop and rebuild the entire derived index
 * from those files alone — proving the database is genuinely disposable.
 */
describe('IndexRebuildService (Phase B) rebuild-from-git drill', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let items: ItemsService;
  let wiki: WikiService;
  let rebuild: IndexRebuildService;
  let adminId: string;
  let dir: string;
  let adapter: GitRevisionMirrorAdapter;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    items = app.get(ItemsService);
    wiki = app.get(WikiService);
    rebuild = app.get(IndexRebuildService);
    dir = mkdtempSync(join(tmpdir(), 'e3-rebuild-'));
    adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function eventFrom(item: ItemView, actorId: string = adminId): RevisionMirrorEvent {
    return {
      itemId: item.id,
      versionId: item.current_version_id ?? 'unknown',
      versionToken: item.version_token,
      actorId,
      title: item.title,
      slug: item.slug,
      rawMarkdown: item.raw_markdown,
      status: item.status,
      spaceId: item.space_id,
      ownerId: item.owner_id,
      tags: item.tags,
      categories: item.categories,
      groups: item.groups,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  async function mirror(...all: ItemView[]): Promise<void> {
    for (const it of all) await adapter.afterItemVersionPersisted(eventFrom(it));
    await adapter.flush();
  }

  async function mirrorAs(actorId: string, item: ItemView): Promise<void> {
    await adapter.afterItemVersionPersisted(eventFrom(item, actorId));
    await adapter.flush();
  }

  async function ftsHits(term: string): Promise<string[]> {
    const rows = await sql<{ page_id: string }>`
      SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${term}
    `.execute(db);
    return rows.rows.map((r) => r.page_id);
  }

  it('reconstructs content, identity, taxonomy, links, and search from git alone', async () => {
    const customers = await items.create(adminId, {
      title: 'Customers',
      body: 'Referenced by orders.',
      status: 'published',
      tags: ['sales'],
      frontmatter: { topic: 'Sales', categories: ['concept'], groups: ['revenue'] },
    });
    const orders = await items.create(adminId, {
      title: 'Orders',
      body: 'Joined with [[Customers]] every morning.',
      status: 'published',
      tags: ['sales', 'ops'],
      frontmatter: { topic: 'Sales', categories: ['concept'], groups: ['revenue'] },
    });

    await mirror(customers, orders);

    // Snapshot the live store before wiping it.
    const before = (await items.getById(orders.id))!;
    const backlinksBefore = await wiki.backlinks({
      id: customers.id,
      slug: customers.slug,
      title: customers.title,
    });
    expect(backlinksBefore.map((b) => b.source_page_id)).toContain(orders.id);
    expect(await ftsHits('morning')).toContain(orders.id);

    // Wipe and rebuild the entire derived index from the git working tree.
    const report = await rebuild.rebuildFromDir(dir, { actorId: adminId });
    expect(report.pages).toBe(2);

    // Identity is preserved — same ids come back.
    const after = await items.getById(orders.id);
    expect(after).toBeTruthy();
    expect(after!.id).toBe(orders.id);
    expect(after!.slug).toBe(before.slug);
    expect(after!.title).toBe('Orders');
    expect(after!.status).toBe('published');
    expect(after!.owner_id).toBe(adminId);
    expect(after!.space_id).toBe(before.space_id);
    expect(after!.body_markdown).toContain('[[Customers]]');
    expect(after!.tags).toEqual(before.tags);
    expect(after!.categories).toEqual(['concept']);
    expect(after!.groups).toEqual(['revenue']);

    // The whole library is back.
    const all = await items.list();
    expect(all.map((i) => i.id).sort()).toEqual([customers.id, orders.id].sort());

    // Derived graph and search are rebuilt too.
    const backlinksAfter = await wiki.backlinks({
      id: customers.id,
      slug: customers.slug,
      title: customers.title,
    });
    expect(backlinksAfter.map((b) => b.source_page_id)).toContain(orders.id);
    expect(await ftsHits('morning')).toContain(orders.id);

    // A clean rebuild leaves no dangling references (asserted internally, but be explicit).
    const fkCheck = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
    expect(fkCheck.rows).toHaveLength(0);
  });

  it('replays the version chain from git and attributes each edit to its author', async () => {
    // A second admin who will make one of the edits — proving created_by tracks
    // the real editor, distinct from the page owner.
    const { userId: editorId } = await seedAdminAndLogin(app, 'editor', 'editor-password-123');

    const created = await items.create(adminId, {
      title: 'Changelog',
      body: 'First revision.',
      status: 'published',
    });
    await mirror(created); // authored by admin (the owner)

    const v2 = await items.update({ id: editorId, role: 'admin' }, created.id, created.version_token, {
      body: 'Second revision.',
    });
    await mirrorAs(editorId, v2); // authored by the second admin

    const v3 = await items.update({ id: adminId, role: 'admin' }, created.id, v2.version_token, {
      body: 'Third revision.',
    });
    await mirror(v3); // authored by admin again

    const report = await rebuild.rebuildFromDir(dir, { actorId: adminId, replayHistory: true });
    expect(report.pages).toBe(1);
    expect(report.versions).toBe(3); // one page_versions row per commit

    // The version chain is reconstructed parent-linked. Walk it from the root
    // rather than trusting timestamps (commits can share a one-second tick).
    const versions = await db
      .selectFrom('page_versions')
      .select(['id', 'body_markdown', 'created_by', 'parent_version_id'])
      .where('page_id', '=', created.id)
      .execute();
    expect(versions).toHaveLength(3);

    const ordered: typeof versions = [];
    let cursor = versions.find((v) => v.parent_version_id === null);
    while (cursor) {
      ordered.push(cursor);
      cursor = versions.find((v) => v.parent_version_id === cursor!.id);
    }
    expect(ordered.map((v) => v.body_markdown.trim())).toEqual([
      'First revision.',
      'Second revision.',
      'Third revision.',
    ]);
    // Each version is attributed to whoever made that edit (from the commit author).
    expect(ordered.map((v) => v.created_by)).toEqual([adminId, editorId, adminId]);

    // The current page reflects the latest revision; the owner stays the creator.
    const after = (await items.getById(created.id))!;
    expect(after.body_markdown).toContain('Third revision.');
    expect(after.version_token).toBe(3);
    expect(after.owner_id).toBe(adminId);
  });

  it('is idempotent — rebuilding twice yields the same store', async () => {
    const note = await items.create(adminId, {
      title: 'Solo Note',
      body: 'No links here.',
      status: 'published',
    });
    await mirror(note);

    await rebuild.rebuildFromDir(dir, { actorId: adminId });
    const first = (await items.getById(note.id))!;
    await rebuild.rebuildFromDir(dir, { actorId: adminId });
    const second = (await items.getById(note.id))!;

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(second.title).toBe(first.title);
    expect(second.body_markdown).toBe(first.body_markdown);
    const all = await items.list();
    expect(all).toHaveLength(1);
  });
});
