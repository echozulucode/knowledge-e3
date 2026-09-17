/**
 * Inbound sync (plan §8.1, §12 decision 6): files pushed to a source's remote
 * by someone else are fetched, merged and indexed on the next cycle — with the
 * file's id, type and tags; updated in place; soft-deleted when removed; landed
 * as drafts (and listed in Content health) when they fail the lint; and a
 * bundle `index.md` applies its presentation to the topic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { digestOf } from '@echozedlabs/content-store';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { PagesService } from '../src/pages/pages.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

const QUEST_ID = '11111111-1111-4111-8111-111111111111';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Git may normalise line endings on checkout (Windows `core.autocrlf`); compare content, not bytes. */
function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** A bare origin on `main` plus a working clone that plays "someone else's editor". */
function seedOrigin(tmp: string): { bare: string; clone: string } {
  const bare = join(tmp, 'origin.git');
  const clone = join(tmp, 'clone');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  execFileSync('git', ['clone', '-q', bare, clone]);
  git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(clone, 'config', 'user.email', 'upstream@example.com');
  git(clone, 'config', 'user.name', 'Upstream');
  return { bare, clone };
}

function commitAndPush(clone: string, message: string): void {
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', message);
  git(clone, 'push', '-q', 'origin', 'main');
}

function writeConcept(clone: string, slug: string, frontmatter: string, body: string): string {
  const content = `---\n${frontmatter}\n---\n\n${body}\n`;
  mkdirSync(join(clone, 'concepts'), { recursive: true });
  writeFileSync(join(clone, 'concepts', `${slug}.md`), content, 'utf8');
  return content;
}

describe('sync: inbound files (git → index) e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let pages: PagesService;
  let registry: SourceRegistryService;
  let sync: SyncService;
  let spaces: SpacesService;
  let cookie: string;
  let root: string;
  let tmp: string;
  let topicId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-sync-inbound-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    pages = app.get(PagesService);
    registry = app.get(SourceRegistryService);
    sync = app.get(SyncService);
    spaces = app.get(SpacesService);
    // The lint requires exactly one KNOWN primary category.
    await spaces.createCategory({ name: 'Guides' });
    topicId = (await spaces.create({ name: 'Game Dev' })).id;
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(tmp, { recursive: true, force: true });
  });

  it('indexes, updates, deletes and quarantines files pushed upstream; applies index.md to the topic', async () => {
    const { bare, clone } = seedOrigin(tmp);
    const v1 = writeConcept(
      clone,
      'quest-system',
      `type: Concept\ntitle: Quest System\ne3_id: ${QUEST_ID}\nstatus: published\ntags: [design, rpg]\ncategories: [guides]\ndescription: How quests work.`,
      'Quests v1.',
    );
    writeFileSync(
      join(clone, 'index.md'),
      '---\nokf_version: "0.2"\ntitle: Game Dev\npresentation: portal\nstart_here: quest-system\n---\n# Game Dev\n\nGateway prose for the topic.\n\n## Concepts\n- [Quest System](/concepts/quest-system.md)\n',
      'utf8',
    );
    commitAndPush(clone, 'seed');

    await registry.upsert('topic:game-dev', { remote_url: bare, branch: 'main', role: 'authoritative', mode: 'direct', default_status: 'published' });
    const first = await sync.runNow('topic:game-dev');
    expect(first).toMatchObject({ source: 'topic:game-dev', state: 'idle', last_error: null, conflicted_paths: [] });

    // Indexed with the file's id, type, tags — and filed under the bound topic.
    const quest = (await pages.getById(QUEST_ID))!;
    expect(quest).toMatchObject({ id: QUEST_ID, slug: 'quest-system', title: 'Quest System', type: 'Concept', status: 'published', space_id: topicId, version_token: 1 });
    expect(quest.tags).toEqual(['design', 'rpg']);
    expect(quest.categories).toEqual(['guides']);
    expect(quest.body_markdown).toContain('Quests v1.');
    // `file_digest` is the checked-out bytes.
    const localFile = join(root, 'topics', 'game-dev', 'concepts', 'quest-system.md');
    const row = await db.selectFrom('pages').selectAll().where('id', '=', QUEST_ID).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ source_id: 'topic:game-dev', file_path: 'concepts/quest-system.md', file_digest: digestOf(readFileSync(localFile, 'utf8')) });
    expect(lf(readFileSync(localFile, 'utf8'))).toBe(v1);
    // Nothing to push for an inbound file: no outbox row, no local commit ahead of origin.
    expect(await db.selectFrom('content_outbox').selectAll().where('page_id', '=', QUEST_ID).execute()).toEqual([]);
    expect(git(join(root, 'topics', 'game-dev'), 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));

    // index.md presentation landed on the topic.
    expect(await spaces.getById(topicId)).toMatchObject({ presentation: 'portal', start_here: 'quest-system' });

    // Modified upstream → updated in place, version bumped, digest is the file on disk.
    const v2 = writeConcept(
      clone,
      'quest-system',
      `type: Concept\ntitle: Quest System\ne3_id: ${QUEST_ID}\nstatus: published\ntags: [design, rpg, loot]\ncategories: [guides]\ndescription: How quests work.`,
      'Quests v2 with loot.',
    );
    commitAndPush(clone, 'edit quest');
    await sync.runNow('topic:game-dev');
    const updated = (await pages.getById(QUEST_ID))!;
    expect(updated.version_token).toBe(2);
    expect(updated.body_markdown).toContain('Quests v2 with loot.');
    expect(updated.tags).toEqual(['design', 'loot', 'rpg']);
    const local = readFileSync(localFile, 'utf8');
    expect(lf(local)).toBe(v2);
    const row2 = await db.selectFrom('pages').select('file_digest').where('id', '=', QUEST_ID).executeTakeFirstOrThrow();
    expect(row2.file_digest).toBe(digestOf(local));

    // A published file with no type and no primary category fails the lint: it
    // lands anyway, as a draft, and shows up in the `lint_failed_inbound` queue.
    writeConcept(clone, 'loose-notes', 'title: Loose Notes\nstatus: published', 'Untyped and uncategorized.');
    commitAndPush(clone, 'add loose notes');
    await sync.runNow('topic:game-dev');
    const loose = (await pages.getBySlug('loose-notes'))!;
    expect(loose).toMatchObject({ title: 'Loose Notes', status: 'draft', space_id: topicId });
    const health = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);
    expect(health.body.queues.lint_failed_inbound.items.map((i: { id: string }) => i.id)).toEqual([loose.id]);
    expect(health.body.sync).toEqual({ conflicts: 0, sources_in_conflict: [] });
    const diagnostics = await db.selectFrom('sync_diagnostics').selectAll().where('page_id', '=', loose.id).where('cleared_at', 'is', null).execute();
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(diagnostics[0]!.diagnostics_json).map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining(['type.missing', 'category.missing']));

    // Deleted upstream → soft-deleted here.
    git(clone, 'rm', '-q', 'concepts/quest-system.md');
    commitAndPush(clone, 'remove quest');
    await sync.runNow('topic:game-dev');
    expect(await pages.getById(QUEST_ID)).toBeNull();
    expect(await pages.getById(QUEST_ID, { includeDeleted: true })).toMatchObject({ id: QUEST_ID });

    // Renamed upstream → same row, new path, no duplicate.
    git(clone, 'mv', 'concepts/loose-notes.md', 'concepts/field-notes.md');
    commitAndPush(clone, 'rename notes');
    await sync.runNow('topic:game-dev');
    const renamed = await db.selectFrom('pages').select(['id', 'file_path']).where('deleted_at', 'is', null).where('space_id', '=', topicId).execute();
    expect(renamed).toEqual([{ id: loose.id, file_path: 'concepts/field-notes.md' }]);

    const listed = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
    expect(listed.body.sources[0]).toMatchObject({ id: 'topic:game-dev', managed: true, status: { state: 'idle' } });
    expect(listed.body.sources[0].last_synced_at).toBeTruthy();
  });

  it('writes a fresh id back into a new file of an authoritative source, never into a reference one', async () => {
    const { bare, clone } = seedOrigin(tmp);
    const original = writeConcept(clone, 'save-format', 'type: Concept\ntitle: Save Format\ncategories: [guides]\ndescription: On disk.', 'Bytes.');
    commitAndPush(clone, 'seed');

    await registry.upsert('topic:game-dev', { remote_url: bare, branch: 'main', role: 'authoritative', mode: 'direct', default_status: 'published' });
    await sync.runNow('topic:game-dev');
    const item = (await pages.getBySlug('save-format'))!;
    expect(item).toMatchObject({ title: 'Save Format', status: 'published', space_id: topicId });
    const localFile = join(root, 'topics', 'game-dev', 'concepts', 'save-format.md');
    const local = readFileSync(localFile, 'utf8');
    expect(local).toContain(`e3_id: ${item.id}`);
    const row = await db.selectFrom('pages').select(['file_digest', 'file_path']).where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ file_path: 'concepts/save-format.md', file_digest: digestOf(local) });

    // A reference (read-only) source is indexed but its files are never touched.
    const vendor = await spaces.create({ name: 'Vendor Docs' });
    const other = seedOrigin(join(tmp, 'vendor'));
    writeConcept(other.clone, 'sdk-setup', 'type: Concept\ntitle: SDK Setup\ncategories: [guides]\ndescription: Install.', 'Steps.');
    commitAndPush(other.clone, 'seed');
    await registry.upsert('topic:vendor-docs', { remote_url: other.bare, branch: 'main', role: 'reference', mode: 'read-only', default_status: 'published' });
    await sync.runNow('topic:vendor-docs');
    const sdk = (await pages.getBySlug('sdk-setup'))!;
    expect(sdk).toMatchObject({ title: 'SDK Setup', space_id: vendor.id });
    const vendorFile = join(root, 'topics', 'vendor-docs', 'concepts', 'sdk-setup.md');
    expect(existsSync(vendorFile)).toBe(true);
    expect(readFileSync(vendorFile, 'utf8')).not.toContain('e3_id');
    expect(git(join(root, 'topics', 'vendor-docs'), 'status', '--porcelain')).toBe('');
    expect(original).not.toContain('e3_id');
  });

  /**
   * Plan §8.3's own example configures an `include` glob naming the concept
   * layout on a source that is already canonical. Globs must narrow what is
   * indexed without changing how a `concepts/` file is treated — same id
   * write-back, no `.e3/ids.json`, nothing relocated.
   */
  it('indexes a concepts/ file the same way when include globs name that layout', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeConcept(clone, 'save-format', 'type: Concept\ntitle: Save Format\ncategories: [guides]\ndescription: On disk.', 'Bytes.');
    writeFileSync(join(clone, 'CONTRIBUTING.md'), '---\ntitle: Contributing\n---\n\nHow to help.\n', 'utf8');
    commitAndPush(clone, 'seed');

    await registry.upsert('topic:game-dev', {
      remote_url: bare,
      branch: 'main',
      role: 'authoritative',
      mode: 'direct',
      default_status: 'published',
      include_globs: ['concepts/**/*.md'],
    });
    await sync.runNow('topic:game-dev');

    const item = (await pages.getBySlug('save-format'))!;
    expect(item).toMatchObject({ title: 'Save Format', type: 'Concept', status: 'published', space_id: topicId });
    const local = readFileSync(join(root, 'topics', 'game-dev', 'concepts', 'save-format.md'), 'utf8');
    expect(local).toContain(`e3_id: ${item.id}`);
    // The glob excludes everything outside `concepts/`, and the canonical path
    // keeps its existing id write-back — no side map is created for it.
    expect(await pages.getBySlug('contributing')).toBeNull();
    expect(existsSync(join(root, 'topics', 'game-dev', '.e3'))).toBe(false);
  });
});
