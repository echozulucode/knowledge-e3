/**
 * Non-OKF Markdown import (plan §8.3, "import an existing repository of
 * Markdown"): a source registered with `include` globs indexes ordinary
 * Markdown wherever it lives, assigns an id to every file on the first sync and
 * keeps that id stable — written back into the file for an `authoritative`
 * source, kept in `.e3/ids.json` beside the clone for a `reference` one, whose
 * working tree must stay clean. The lint stays in warn mode throughout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { digestOf } from '@echozedlabs/content-store';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { PagesService } from '../src/pages/pages.service.js';
import { isIndexablePath, isImportedPath, matchesGlob } from '../src/sync/inbound-index.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

const PRESET_ID = '22222222-2222-4222-8222-222222222222';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** A bare origin on `main` plus a working clone that plays "the repository we import". */
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

/** Write any file at any path in the clone (this repository has no OKF layout). */
function writeAt(clone: string, path: string, content: string): void {
  const abs = join(clone, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function doc(frontmatter: string | null, body: string): string {
  return frontmatter === null ? `${body}\n` : `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe('non-OKF import: glob matching (pure)', () => {
  const globbed = { include_globs: JSON.stringify(['docs/**/*.md']), exclude_globs: JSON.stringify(['docs/archive/**']) };
  const plain = { include_globs: null, exclude_globs: null };

  it('matches `*`, `?` and whole-segment `**`', () => {
    expect(matchesGlob('docs/guide.md', 'docs/**/*.md')).toBe(true);
    expect(matchesGlob('docs/deep/nested/guide.md', 'docs/**/*.md')).toBe(true);
    expect(matchesGlob('notes/guide.md', 'docs/**/*.md')).toBe(false);
    expect(matchesGlob('docs/guide.txt', 'docs/**/*.md')).toBe(false);
    expect(matchesGlob('docs/a/b.md', 'docs/*.md')).toBe(false);
    expect(matchesGlob('docs/a1.md', 'docs/a?.md')).toBe(true);
    expect(matchesGlob('README.md', '*.md')).toBe(true);
    expect(matchesGlob('docs/README.md', '*.md')).toBe(false);
    // A leading `**/` spans zero segments too — this is exactly the default rule.
    expect(matchesGlob('concepts/x.md', '**/concepts/*.md')).toBe(true);
    expect(matchesGlob('topic/concepts/x.md', '**/concepts/*.md')).toBe(true);
    expect(matchesGlob('docs/anything/at/all.png', 'docs/**')).toBe(true);
  });

  it('with no globs indexes exactly what it always did', () => {
    expect(isIndexablePath(plain, 'concepts/x.md')).toBe(true);
    expect(isIndexablePath(plain, 'topic/concepts/x.md')).toBe(true);
    expect(isIndexablePath(plain, 'docs/x.md')).toBe(false);
    expect(isIndexablePath(plain, 'README.md')).toBe(false);
    expect(isIndexablePath(plain, 'concepts/index.md')).toBe(false);
    expect(isIndexablePath(plain, 'concepts/log.md')).toBe(false);
    // Nothing in the canonical layout counts as an import, so nothing changes for it.
    expect(isImportedPath(plain, 'concepts/x.md')).toBe(false);
  });

  it('honours include/exclude, and never the reserved or asset files', () => {
    expect(isIndexablePath(globbed, 'docs/guide.md')).toBe(true);
    expect(isIndexablePath(globbed, 'docs/deep/thing.md')).toBe(true);
    expect(isIndexablePath(globbed, 'docs/archive/old.md')).toBe(false);
    expect(isIndexablePath(globbed, 'notes/deep/thing.md')).toBe(false);
    expect(isIndexablePath(globbed, 'README.md')).toBe(false);
    expect(isIndexablePath(globbed, 'docs/assets/logo.md')).toBe(false);
    expect(isIndexablePath(globbed, 'docs/index.md')).toBe(false);
    expect(isIndexablePath(globbed, 'docs/log.md')).toBe(false);
    // With globs, `concepts/` is no longer implied.
    expect(isIndexablePath(globbed, 'concepts/x.md')).toBe(false);
    expect(isImportedPath(globbed, 'docs/guide.md')).toBe(true);
  });
});

describe('non-OKF import: an ordinary Markdown repository e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let pages: PagesService;
  let registry: SourceRegistryService;
  let sync: SyncService;
  let spaces: SpacesService;
  let adminId: string;
  let root: string;
  let tmp: string;
  let topicId: string;
  /** Working tree the source is cloned into. */
  let workdir: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-import-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    pages = app.get(PagesService);
    registry = app.get(SourceRegistryService);
    sync = app.get(SyncService);
    spaces = app.get(SpacesService);
    // The lint requires exactly one KNOWN primary category.
    await spaces.createCategory({ name: 'Guides' });
    topicId = (await spaces.create({ name: 'Handbook' })).id;
    workdir = join(root, 'topics', 'handbook');
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(tmp, { recursive: true, force: true });
  });

  const indexedPaths = async (): Promise<string[]> => {
    const rows = await db
      .selectFrom('pages')
      .select('file_path')
      .where('source_id', '=', 'topic:handbook')
      .where('deleted_at', 'is', null)
      .orderBy('file_path')
      .execute();
    return rows.map((r) => r.file_path!);
  };

  it('indexes what the globs select, types it, keeps the tree clean and records ids in .e3/ids.json', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.'));
    writeAt(clone, 'docs/deep/advanced.md', doc('title: Advanced\ncategories: [guides]\ndescription: The deep end.', 'More.'));
    writeAt(clone, 'docs/typed.md', doc('type: FAQ\ntitle: Questions\ncategories: [guides]\ndescription: Answers.', 'Q and A.'));
    // No frontmatter at all: the title comes from the heading, and the missing
    // category/description fail the lint — in WARN mode, so it still lands.
    writeAt(clone, 'docs/plain.md', doc(null, '# Plain Notes\n\nJust prose.'));
    writeAt(clone, 'docs/archive/old.md', doc('title: Old\ncategories: [guides]\ndescription: Gone.', 'Old.'));
    writeAt(clone, 'docs/assets/logo.md', doc(null, '# Logo'));
    writeAt(clone, 'docs/index.md', doc(null, '# Docs'));
    writeAt(clone, 'notes/deep/thing.md', doc(null, '# Thing'));
    writeAt(clone, 'README.md', doc(null, '# Readme'));
    commitAndPush(clone, 'seed an ordinary markdown repo');

    await registry.upsert('topic:handbook', {
      remote_url: bare,
      branch: 'main',
      role: 'reference',
      mode: 'read-only',
      default_status: 'published',
      include_globs: ['docs/**/*.md'],
      exclude_globs: ['docs/archive/**'],
      default_type: 'How-To',
    });
    const status = await sync.runNow('topic:handbook');
    expect(status).toMatchObject({ source: 'topic:handbook', state: 'idle', last_error: null, conflicted_paths: [] });

    // Only the included, non-reserved, non-asset files are items.
    expect(await indexedPaths()).toEqual(['docs/deep/advanced.md', 'docs/guide.md', 'docs/plain.md', 'docs/typed.md']);
    for (const slug of ['old', 'logo', 'thing', 'readme', 'index']) {
      expect(await pages.getBySlug(slug)).toBeNull();
    }

    // `default_type` fills in only where the file names no type.
    const guide = (await pages.getBySlug('guide'))!;
    expect(guide).toMatchObject({ title: 'Setup Guide', type: 'How-To', status: 'published', space_id: topicId });
    expect((await pages.getBySlug('advanced'))!.type).toBe('How-To');
    expect((await pages.getBySlug('typed'))!.type).toBe('FAQ');

    // Lint failure: a draft plus a diagnostic, never a failed sync.
    const plain = (await pages.getBySlug('plain'))!;
    expect(plain).toMatchObject({ title: 'Plain Notes', type: 'How-To', status: 'draft' });
    const diagnostics = await db.selectFrom('sync_diagnostics').selectAll().where('page_id', '=', plain.id).where('cleared_at', 'is', null).execute();
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(diagnostics[0]!.diagnostics_json).map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(['category.missing']),
    );

    // A reference source is never written to: no ids in the files, clean tree.
    expect(readFileSync(join(workdir, 'docs', 'guide.md'), 'utf8')).not.toContain('e3_id');
    expect(git(workdir, 'status', '--porcelain')).toBe('');

    // The ids live beside the clone instead.
    const ids = JSON.parse(readFileSync(join(workdir, '.e3', 'ids.json'), 'utf8')) as { version: number; ids: Record<string, string> };
    expect(ids.version).toBe(1);
    expect(ids.ids['docs/guide.md']).toBe(guide.id);
    expect(ids.ids['docs/plain.md']).toBe(plain.id);
    expect(Object.keys(ids.ids).sort()).toEqual(['docs/deep/advanced.md', 'docs/guide.md', 'docs/plain.md', 'docs/typed.md']);
    expect(readFileSync(join(workdir, '.git', 'info', 'exclude'), 'utf8')).toContain('.e3/');
  });

  it('takes ids from .e3/ids.json and never mints a second one for the same file', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.'));
    commitAndPush(clone, 'seed');

    // An id assigned by an earlier run (or an earlier database): the map is the
    // record, so the item must come back with exactly that id.
    mkdirSync(join(workdir, '.e3'), { recursive: true });
    writeFileSync(join(workdir, '.e3', 'ids.json'), JSON.stringify({ version: 1, ids: { 'docs/guide.md': PRESET_ID } }), 'utf8');

    await registry.upsert('topic:handbook', {
      remote_url: bare,
      branch: 'main',
      role: 'reference',
      mode: 'read-only',
      default_status: 'published',
      include_globs: ['docs/**/*.md'],
    });
    await sync.runNow('topic:handbook');
    const first = (await pages.getById(PRESET_ID))!;
    expect(first).toMatchObject({ id: PRESET_ID, slug: 'guide', title: 'Setup Guide' });

    // Re-synced after an upstream edit: same row, same id, no duplicate.
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it, carefully.'));
    commitAndPush(clone, 'edit');
    await sync.runNow('topic:handbook');
    const second = (await pages.getById(PRESET_ID))!;
    expect(second.version_token).toBe(2);
    expect(second.body_markdown).toContain('carefully');
    expect(await indexedPaths()).toEqual(['docs/guide.md']);

    // Even with the row gone (the "rebuild" case) the id comes back from the map.
    await pages.softDelete({ id: adminId, role: 'admin' }, PRESET_ID);
    expect(await pages.getById(PRESET_ID)).toBeNull();
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it, twice.'));
    commitAndPush(clone, 'edit again');
    await sync.runNow('topic:handbook');
    expect(await pages.getById(PRESET_ID)).toMatchObject({ id: PRESET_ID, slug: 'guide' });
    expect(await indexedPaths()).toEqual(['docs/guide.md']);
  });

  it('survives an unreadable .e3/ids.json and rewrites it', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.'));
    commitAndPush(clone, 'seed');
    mkdirSync(join(workdir, '.e3'), { recursive: true });
    writeFileSync(join(workdir, '.e3', 'ids.json'), '{ this is not json', 'utf8');

    await registry.upsert('topic:handbook', {
      remote_url: bare,
      branch: 'main',
      role: 'reference',
      mode: 'read-only',
      default_status: 'published',
      include_globs: ['docs/**/*.md'],
    });
    const status = await sync.runNow('topic:handbook');
    expect(status).toMatchObject({ state: 'idle', last_error: null });
    const guide = (await pages.getBySlug('guide'))!;
    expect(guide.title).toBe('Setup Guide');
    const ids = JSON.parse(readFileSync(join(workdir, '.e3', 'ids.json'), 'utf8')) as { ids: Record<string, string> };
    expect(ids.ids['docs/guide.md']).toBe(guide.id);
  });

  it('writes assigned ids back into the files of an authoritative source, and commits them', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.\n\nThen run it.'));
    writeAt(clone, 'docs/deep/advanced.md', doc('title: Advanced\ncategories: [guides]\ndescription: The deep end.', 'More.'));
    commitAndPush(clone, 'seed');

    await registry.upsert('topic:handbook', {
      remote_url: bare,
      branch: 'main',
      role: 'authoritative',
      mode: 'direct',
      default_status: 'published',
      include_globs: ['docs/**/*.md'],
    });
    await sync.runNow('topic:handbook');

    const guide = (await pages.getBySlug('guide'))!;
    const guideFile = join(workdir, 'docs', 'guide.md');
    const local = readFileSync(guideFile, 'utf8');
    expect(local).toContain(`e3_id: ${guide.id}`);
    // The file stayed where it was — an import is not relocated into `concepts/`.
    expect(await indexedPaths()).toEqual(['docs/deep/advanced.md', 'docs/guide.md']);
    expect(existsSync(join(workdir, 'concepts'))).toBe(false);
    // The row's digest is the file as it now stands on disk.
    const row = await db.selectFrom('pages').select('file_digest').where('id', '=', guide.id).executeTakeFirstOrThrow();
    expect(row.file_digest).toBe(digestOf(local));
    // The write-back is committed, so the next merge is not blocked by it.
    expect(git(workdir, 'status', '--porcelain')).toBe('');
    expect(git(workdir, 'log', '-1', '--pretty=%s')).toContain('assign ids');
    // An authoritative source keeps its ids in the files, not in a side map.
    expect(existsSync(join(workdir, '.e3', 'ids.json'))).toBe(false);

    // Edited upstream: merged, re-indexed, still one item with the same id.
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.\n\nThen run it twice.'));
    commitAndPush(clone, 'edit');
    const status = await sync.runNow('topic:handbook');
    expect(status).toMatchObject({ state: 'idle', last_error: null, conflicted_paths: [] });
    const after = (await pages.getBySlug('guide'))!;
    expect(after.id).toBe(guide.id);
    expect(after.body_markdown).toContain('twice');
    expect(await indexedPaths()).toEqual(['docs/deep/advanced.md', 'docs/guide.md']);
  });

  it('leaves a source with no globs exactly as it was: the canonical layout only', async () => {
    const { bare, clone } = seedOrigin(tmp);
    writeAt(clone, 'concepts/quest.md', doc('type: Concept\ntitle: Quest\ncategories: [guides]\ndescription: Quests.', 'Quests.'));
    writeAt(clone, 'docs/guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How to set up.', 'Install it.'));
    commitAndPush(clone, 'seed');

    await registry.upsert('topic:handbook', {
      remote_url: bare,
      branch: 'main',
      role: 'reference',
      mode: 'read-only',
      default_status: 'published',
      default_type: 'How-To',
    });
    await sync.runNow('topic:handbook');

    expect(await indexedPaths()).toEqual(['concepts/quest.md']);
    expect(await pages.getBySlug('guide')).toBeNull();
    // No id map and no `type` default applied to a canonical file: unchanged behaviour.
    expect(existsSync(join(workdir, '.e3'))).toBe(false);
    expect((await pages.getBySlug('quest'))!.type).toBe('Concept');
    expect(git(workdir, 'status', '--porcelain')).toBe('');
  });

  it('rejects a default_type that is not in the content-type registry', async () => {
    await expect(registry.upsert('topic:handbook', { default_type: 'Not A Type' })).rejects.toThrow(/unknown content type/i);
    await expect(registry.upsert('topic:handbook', { include_globs: ['/etc/passwd'] })).rejects.toThrow(/repository-relative/i);
    const source = await registry.upsert('topic:handbook', { default_type: 'how-to', include_globs: ['docs/**/*.md'], exclude_globs: [] });
    // A key resolves to its canonical label; an empty list clears the column.
    expect(source.default_type).toBe('How-To');
    expect(source.include_globs).toBe('["docs/**/*.md"]');
    expect(source.exclude_globs).toBeNull();
  });
});
