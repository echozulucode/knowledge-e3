/**
 * Rename, write-first (plan §8.3 row 9, issue 80).
 *
 * A rename is a content change to the subject **and** to every page whose
 * inbound wiki-links it rewrites, so all of those files are rendered and
 * written before a single row moves: file(s) first, then the index + one
 * `content_outbox` row per file in ONE transaction, then the mirror (or, in a
 * `review` source, staging on the item branch). The file and the index can
 * therefore never disagree, and the next edit does not report a spurious
 * `changed_on_disk`.
 *
 * The second half of this file covers what is left of the issue-80 guard. Soft
 * delete, restore and `resyncSpace` were part of it until they were inverted
 * (issue 76): delete and restore are write-first now, so they stage onto the
 * item branch like any other edit, and a resync SKIPS a review-mode source
 * instead of failing the whole repair. Only the **topic move** is still refused
 * with 409 `review_unsupported_operation` — staging restores the working tree
 * to the base version and has no way to carry a departure onto the item branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kysely } from 'kysely';
import { digestOf } from '@echozedlabs/content-store';
import type { FetchImpl } from '@echozedlabs/repo-sync';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { actorFrom, type ServerActor } from '../src/content/actor.js';
import { ContentCommandsService } from '../src/content/content-commands.service.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { ItemsService } from '../src/items/items.service.js';
import { PagesService } from '../src/pages/pages.service.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { ReviewService } from '../src/sync/review.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

interface Ctx {
  app: INestApplication;
  cookie: string;
  db: Kysely<Database>;
  paths: ContentPathResolver;
}

async function rowOf(ctx: Ctx, pageId: string) {
  return ctx.db.selectFrom('pages').selectAll().where('id', '=', pageId).executeTakeFirstOrThrow();
}

/** Absolute path of the canonical file a row records. */
async function fileOf(ctx: Ctx, pageId: string): Promise<{ abs: string; content: string; digest: string }> {
  const row = await rowOf(ctx, pageId);
  const target = await ctx.paths.resolve(row.space_id);
  const abs = join(target.repoDir, row.file_path ?? `${target.conceptDir}/${row.slug}.md`);
  const content = readFileSync(abs, 'utf8');
  return { abs, content, digest: digestOf(content) };
}

/** The file is on disk and its digest is exactly what the row indexed. */
async function expectInStep(ctx: Ctx, pageId: string): Promise<string> {
  const row = await rowOf(ctx, pageId);
  const file = await fileOf(ctx, pageId);
  expect(existsSync(file.abs)).toBe(true);
  expect(row.file_digest).toBe(file.digest);
  return file.content;
}

async function outboxRows(db: Kysely<Database>, pageId: string) {
  return db.selectFrom('content_outbox').selectAll().where('page_id', '=', pageId).orderBy('created_at', 'asc').execute();
}

async function createPage(ctx: Ctx, body: Record<string, unknown>): Promise<{ id: string; version_token: number }> {
  // Conformant, so a fixture created published passes the publish gate (issue 98).
  const conformantBody = { ...body, frontmatter: conformant(body['frontmatter'] as Record<string, unknown> | undefined) };
  const res = await request(ctx.app.getHttpServer()).post('/api/v1/pages').set('Cookie', ctx.cookie).send(conformantBody).expect(201);
  return { id: res.body.page.id, version_token: res.body.page.version_token };
}

describe('rename write-first: every rewritten page gets its file, digest and outbox row', () => {
  const ctx = {} as Ctx;

  beforeEach(async () => {
    ctx.app = await makeApp();
    ({ cookie: ctx.cookie } = await seedAdminAndLogin(ctx.app));
    await curateCategories(ctx.app);
    ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
    ctx.paths = ctx.app.get(ContentPathResolver);
  });
  afterEach(async () => ctx.app.close());

  it('rewrites the subject file AND every inbound linker file, keeping digests and the outbox in step', async () => {
    const target = await createPage(ctx, { title: 'Old Target', body: 'Target body.\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Linker', body: 'See [[Old Target]] for details.\n', status: 'published' });
    const untouched = await createPage(ctx, { title: 'Bystander', body: 'Nothing here.\n', status: 'published' });
    const bystanderBefore = (await fileOf(ctx, untouched.id)).digest;

    const renamed = await request(ctx.app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'New Target', link_action: 'update_all' })
      .expect(201);
    expect(renamed.body.affected_pages.map((p: { id: string }) => p.id)).toEqual([target.id, linker.id]);

    // The subject's file carries the new title — the slug (and so the path) is
    // unchanged, which is why a rename is a rewrite and never a `git mv`.
    const subjectRow = await rowOf(ctx, target.id);
    expect(subjectRow.file_path).toBe('default/concepts/old-target.md');
    const subjectFile = await expectInStep(ctx, target.id);
    expect(subjectFile).toContain('title: New Target');
    expect(subjectFile).not.toContain('title: Old Target');

    // The inbound linker's file was rewritten too, and its digest re-indexed.
    const linkerFile = await expectInStep(ctx, linker.id);
    expect(linkerFile).toContain('[[New Target]]');
    expect(linkerFile).not.toContain('[[Old Target]]');

    // A page the rename did not touch was not rewritten.
    expect((await fileOf(ctx, untouched.id)).digest).toBe(bystanderBefore);

    // One outbox row per page per write: create + rename, all processed (no repo).
    for (const id of [target.id, linker.id]) {
      const rows = await outboxRows(ctx.db, id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.processed_at !== null)).toBe(true);
      expect(rows[1]).toMatchObject({ kind: 'upsert', source_id: 'main' });
      expect(rows[1]!.file_digest).toBe((await fileOf(ctx, id)).digest);
    }
    expect(await outboxRows(ctx.db, untouched.id)).toHaveLength(1);

    // …and because the digests are in step, the next edit is not a 409.
    for (const id of [target.id, linker.id]) {
      const row = await rowOf(ctx, id);
      await request(ctx.app.getHttpServer())
        .put(`/api/v1/pages/${id}`)
        .set('Cookie', ctx.cookie)
        .set('If-Match', String(row.version_token))
        .send({ body: 'edited after the rename\n' })
        .expect(200);
      expect(await expectInStep(ctx, id)).toContain('edited after the rename');
    }
  });

  it('link_action=skip rewrites only the subject file and leaves the linker on disk alone', async () => {
    const target = await createPage(ctx, { title: 'To Be Renamed', body: 'Target.\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Linker', body: 'A link to [[To Be Renamed]] here.\n', status: 'published' });
    const linkerBefore = await fileOf(ctx, linker.id);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'New Name', link_action: 'skip' })
      .expect(201);

    expect(await expectInStep(ctx, target.id)).toContain('title: New Name');
    // The linker was never part of the rename, so neither its file nor its row moved.
    const after = await fileOf(ctx, linker.id);
    expect(after.digest).toBe(linkerBefore.digest);
    expect(after.content).toContain('[[To Be Renamed]]');
    expect((await rowOf(ctx, linker.id)).version_token).toBe(linker.version_token);
    expect(await outboxRows(ctx.db, linker.id)).toHaveLength(1);
  });

  it('a rowversion conflict rolls the rename back and leaves both files exactly as they were', async () => {
    const target = await createPage(ctx, { title: 'Old', body: 'Target.\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Linker', body: '[[Old]] is here.\n', status: 'published' });
    // Bump the linker so the pinned expected version is stale.
    await request(ctx.app.getHttpServer())
      .put(`/api/v1/pages/${linker.id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(linker.version_token))
      .send({ body: '[[Old]] still here, just edited.\n' })
      .expect(200);

    const before = { target: await fileOf(ctx, target.id), linker: await fileOf(ctx, linker.id) };
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'New', link_action: 'update_all', expected_affected_versions: { [linker.id]: linker.version_token } })
      .expect(409);

    // Nothing was written: the plan is refused before any file is touched.
    expect((await fileOf(ctx, target.id)).digest).toBe(before.target.digest);
    expect((await fileOf(ctx, linker.id)).digest).toBe(before.linker.digest);
    await expectInStep(ctx, target.id);
    await expectInStep(ctx, linker.id);
    expect(await outboxRows(ctx.db, target.id)).toHaveLength(1);
  });

  it('compensates: when the index transaction fails, every file it wrote goes back', async () => {
    const target = await createPage(ctx, { title: 'Rollback Target', body: 'body\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Rollback Linker', body: 'See [[Rollback Target]].\n', status: 'published' });
    const before = { target: await fileOf(ctx, target.id), linker: await fileOf(ctx, linker.id) };

    // Stand in for a concurrent edit landing between the plan and the index
    // transaction: the transaction refuses, so the files must not stay ahead.
    const pages = ctx.app.get(PagesService);
    const spy = vi.spyOn(pages, 'applyRename').mockRejectedValue(new ConflictException('someone else got there first'));
    await expect(
      ctx.app.get(ContentCommandsService).rename(
        actorFrom({ id: (await rowOf(ctx, target.id)).owner_id ?? 'admin', username: 'admin', role: 'admin' }, 'rest'),
        target.id,
        'Rollback Target v2',
        { ifMatch: target.version_token },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    spy.mockRestore();

    expect((await fileOf(ctx, target.id)).digest).toBe(before.target.digest);
    expect((await fileOf(ctx, linker.id)).digest).toBe(before.linker.digest);
    expect((await fileOf(ctx, target.id)).content).toContain('title: Rollback Target');
    await expectInStep(ctx, target.id);
    await expectInStep(ctx, linker.id);
    // …and the next ordinary edit still goes through (no spurious 409).
    await request(ctx.app.getHttpServer())
      .put(`/api/v1/pages/${target.id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ body: 'still editable\n' })
      .expect(200);
  });

  it('refuses a rename whose file drifted underneath the index (409 changed_on_disk), touching nothing', async () => {
    const target = await createPage(ctx, { title: 'Drifting', body: 'v1\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Points Here', body: 'See [[Drifting]].\n', status: 'published' });
    const { abs, content } = await fileOf(ctx, target.id);
    writeFileSync(abs, content.replace('v1', 'v1 edited on disk'), 'utf8');
    const linkerBefore = (await fileOf(ctx, linker.id)).digest;

    const conflict = await request(ctx.app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'Drifted', link_action: 'update_all' })
      .expect(409);
    expect(conflict.body).toMatchObject({ reason: 'changed_on_disk', file_path: 'default/concepts/drifting.md' });
    // The external edit stands and the linker was never rewritten.
    expect(readFileSync(abs, 'utf8')).toContain('v1 edited on disk');
    expect((await fileOf(ctx, linker.id)).digest).toBe(linkerBefore);
    expect((await rowOf(ctx, target.id)).title).toBe('Drifting');
  });
});

describe('rename write-first with the git mirror: the commit carries the new title', () => {
  const ctx = {} as Ctx;
  let mirror: RoutingRevisionMirror;

  beforeEach(async () => {
    process.env['DB_URL'] = ':memory:';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REVISION_MIRROR)
      .useFactory({
        factory: (kysely: Kysely<Database>, outbox: OutboxService, resolver: ContentPathResolver) =>
          new RoutingRevisionMirror(resolver.root, kysely, {
            quietMs: 20,
            maxMs: 50,
            onCommitted: (committed, at) => outbox.markProcessed(committed.map((c) => ({ pageId: c.itemId, path: c.path })), at),
          }),
        inject: [KYSELY, OutboxService, ContentPathResolver],
      })
      .compile();
    ctx.app = moduleRef.createNestApplication();
    configureApp(ctx.app, { webDist: null });
    await ctx.app.init();
    ({ cookie: ctx.cookie } = await seedAdminAndLogin(ctx.app));
    await curateCategories(ctx.app);
    ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
    ctx.paths = ctx.app.get(ContentPathResolver);
    mirror = ctx.app.get<RoutingRevisionMirror>(REVISION_MIRROR);
  });
  afterEach(async () => ctx.app.close());

  it('commits both rewritten files and marks every outbox row processed', async () => {
    const target = await createPage(ctx, { title: 'Committed Target', body: 'body\n', status: 'published' });
    const linker = await createPage(ctx, { title: 'Committed Linker', body: 'See [[Committed Target]].\n', status: 'published' });
    await mirror.flush();

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'Committed Target v2', link_action: 'update_all' })
      .expect(201);

    // Pending until the commit lands (the mirror is the confirmation).
    const pending = [...(await outboxRows(ctx.db, target.id)), ...(await outboxRows(ctx.db, linker.id))];
    expect(pending.filter((r) => r.processed_at === null)).toHaveLength(2);

    const subjectDigest = (await fileOf(ctx, target.id)).digest;
    await mirror.flush();

    // The adapter found the bytes the command wrote and committed them as-is.
    const repoDir = (await ctx.paths.resolve((await rowOf(ctx, target.id)).space_id)).repoDir;
    const committed = execFileSync('git', ['-C', repoDir, 'show', 'HEAD:default/concepts/committed-target.md'], { encoding: 'utf8' });
    expect(committed).toContain('title: Committed Target v2');
    expect(digestOf(committed)).toBe(subjectDigest);
    expect(
      execFileSync('git', ['-C', repoDir, 'show', 'HEAD:default/concepts/committed-linker.md'], { encoding: 'utf8' }),
    ).toContain('[[Committed Target v2]]');
    expect((await fileOf(ctx, target.id)).digest).toBe(subjectDigest);
    await expectInStep(ctx, target.id);
    await expectInStep(ctx, linker.id);

    for (const id of [target.id, linker.id]) {
      expect((await outboxRows(ctx.db, id)).every((r) => r.processed_at !== null)).toBe(true);
    }
  });
});

/**
 * A review source: the same temp-bare-origin + injected-`fetchImpl` harness as
 * `sync-review.e2e.test.ts`. A rename must behave like any other edit here —
 * staged on the item branch, base branch untouched.
 */
describe('rename in a review-mode source stages onto the item branch', () => {
  const GITHUB_REMOTE = 'https://github.com/acme/kb.git';
  const PR_URL = 'https://github.com/acme/kb/pull/12';
  const TOKEN_ENV = 'E3_TEST_RENAME_REVIEW_TOKEN';

  let app: INestApplication;
  let db: Kysely<Database>;
  let cookie: string;
  let tmp: string;
  let root: string;
  let bare: string;
  let local: string;
  let openCalls: number;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  const fileOnRef = (dir: string, ref: string, path: string): string | null => {
    try {
      return execFileSync('git', ['-C', dir, 'show', `${ref}:${path}`], { encoding: 'utf8' });
    } catch {
      return null;
    }
  };

  const fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/pulls')) {
      openCalls++;
      return new Response(JSON.stringify({ number: 12, html_url: PR_URL, state: 'open', merged: false }), { status: 201 });
    }
    if (method === 'GET' && /\/pulls\/12$/.test(url)) {
      return new Response(JSON.stringify({ number: 12, html_url: PR_URL, state: 'open', merged: false }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-rename-review-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    process.env[TOKEN_ENV] = 'test-token';
    openCalls = 0;

    bare = join(tmp, 'origin.git');
    const seed = join(tmp, 'seed');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['clone', '-q', bare, seed]);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(seed, 'config', 'user.email', 'upstream@example.com');
    git(seed, 'config', 'user.name', 'Upstream');
    writeFileSync(join(seed, 'README.md'), '# Ops\n', 'utf8');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'main');

    local = join(root, 'topics', 'ops');
    mkdirSync(local, { recursive: true });
    execFileSync('git', ['init', '-q', '--initial-branch=main', local]);
    git(local, 'config', 'user.email', 'knowledge-e3@localhost');
    git(local, 'config', 'user.name', 'Knowledge E3');
    git(local, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, GITHUB_REMOTE);
    git(local, 'remote', 'add', 'origin', GITHUB_REMOTE);
    git(local, 'fetch', '-q', 'origin');
    git(local, 'reset', '--hard', 'origin/main');

    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    app.get(ReviewService).fetchImpl = fetchImpl;
    await app.get(SpacesService).create({ name: 'Ops' });
    await app.get(SourceRegistryService).upsert('topic:ops', {
      remote_url: GITHUB_REMOTE,
      branch: 'main',
      role: 'authoritative',
      mode: 'review',
      host_kind: 'github',
      host_base_url: 'https://api.github.test',
      host_token_env: TOKEN_ENV,
    });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    delete process.env[TOKEN_ENV];
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stages the subject and the rewritten linker, and never touches the base branch', async () => {
    const create = async (title: string, body: string) => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', cookie)
        .send({ title, body, status: 'draft', frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'] } })
        .expect(201);
      return res.body.page as { id: string; slug: string; version_token: number; review: { branch: string } };
    };
    const target = await create('Checklist', 'draft one\n');
    const linker = await create('Runbook', 'Follow [[Checklist]] first.\n');
    expect(openCalls).toBe(2);

    await request(app.getHttpServer())
      .post(`/api/v1/pages/${target.id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(target.version_token))
      .send({ new_title: 'Checklist v2', link_action: 'update_all' })
      .expect(201);

    // Both files are on their item branches, with the rename applied…
    expect(fileOnRef(bare, target.review.branch, 'concepts/checklist.md')).toContain('title: Checklist v2');
    expect(fileOnRef(bare, linker.review.branch, 'concepts/runbook.md')).toContain('[[Checklist v2]]');
    // …and no second change request was opened for either item.
    expect(openCalls).toBe(2);

    // The base branch never saw any of it: no files, a clean working tree.
    expect(fileOnRef(bare, 'main', 'concepts/checklist.md')).toBeNull();
    expect(fileOnRef(bare, 'main', 'concepts/runbook.md')).toBeNull();
    expect(existsSync(join(local, 'concepts', 'checklist.md'))).toBe(false);
    expect(existsSync(join(local, 'concepts', 'runbook.md'))).toBe(false);
    expect(git(local, 'status', '--porcelain')).toBe('');
    expect(git(local, 'log', '--oneline', '--', 'concepts')).toBe('');

    // The index kept the renamed content, and every outbox row is processed by
    // the branch push.
    const renamed = await request(app.getHttpServer()).get(`/api/v1/items/${target.id}`).set('Cookie', cookie).expect(200);
    expect(renamed.body.item).toMatchObject({ title: 'Checklist v2', status: 'draft', display_state: 'in-review' });
    expect(renamed.body.item.review).toMatchObject({ state: 'open', branch: target.review.branch });
    const linked = await request(app.getHttpServer()).get(`/api/v1/items/${linker.id}`).set('Cookie', cookie).expect(200);
    expect(linked.body.item.body_markdown).toContain('[[Checklist v2]]');
    for (const id of [target.id, linker.id]) {
      const rows = await outboxRows(db, id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.processed_at !== null)).toBe(true);
    }
  });
});

/**
 * Issue 80: the not-yet-inverted doors refuse to run in a `review` source
 * rather than committing to its base branch behind the change request's back.
 */
describe('issue 80 guard: base-branch writes are refused in a review source', () => {
  const ctx = {} as Ctx;
  let actor: ServerActor;
  let commands: ContentCommandsService;
  let items: ItemsService;
  let registry: SourceRegistryService;

  // A `review` source is only coherent with somewhere to push and a host to open
  // the change request on, and the registry now rejects it otherwise. These cases
  // never reach git — every guarded door refuses first — so the remote only has to
  // be well-formed, not reachable. Cleared again on the way back to `direct` so
  // those cases do not attempt a push.
  const GUARD_REMOTE = 'https://github.com/acme/guard.git';
  const GUARD_TOKEN_ENV = 'E3_TEST_GUARD_TOKEN';
  const setMode = (mode: 'direct' | 'review') =>
    mode === 'review'
      ? registry.upsert('topic:ops', {
          mode,
          remote_url: GUARD_REMOTE,
          branch: 'main',
          host_kind: 'github',
          host_base_url: 'https://api.github.test',
          host_token_env: GUARD_TOKEN_ENV,
        })
      : registry.upsert('topic:ops', { mode, remote_url: null });

  beforeEach(async () => {
    ctx.app = await makeApp();
    const login = await seedAdminAndLogin(ctx.app);
    ctx.cookie = login.cookie;
    ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
    ctx.paths = ctx.app.get(ContentPathResolver);
    actor = actorFrom({ id: login.userId, username: 'admin', role: 'admin' }, 'rest');
    commands = ctx.app.get(ContentCommandsService);
    items = ctx.app.get(ItemsService);
    registry = ctx.app.get(SourceRegistryService);
    await ctx.app.get(SpacesService).create({ name: 'Ops' });
    // A dedicated source for the Ops topic, `direct` while the fixture content
    // is created; the guard cases flip it to `review` afterwards.
    await registry.upsert('topic:ops', { mode: 'direct' });
  });
  afterEach(async () => ctx.app.close());

  /** An item in the Ops topic (source `topic:ops`) and one in the default topic. */
  async function seedItems(): Promise<{ ops: string; plain: string }> {
    const ops = await commands.create(actor, { title: 'Ops Item', body: 'in ops\n', frontmatter: { topic: 'Ops' } }, 'rest');
    const plain = await commands.create(actor, { title: 'Plain Item', body: 'in default\n' }, 'rest');
    expect((await rowOf(ctx, ops.item.id)).source_id).toBe('topic:ops');
    expect((await rowOf(ctx, plain.item.id)).source_id).toBe('main');
    return { ops: ops.item.id, plain: plain.item.id };
  }

  const expectRefusal = async (op: Promise<unknown>, operation: string): Promise<void> => {
    await op.then(
      () => {
        throw new Error(`expected ${operation} to be refused`);
      },
      (err: { status?: number; response?: Record<string, unknown> }) => {
        expect(err.status).toBe(409);
        expect(err.response).toMatchObject({ reason: 'review_unsupported_operation', operation, source_id: 'topic:ops' });
        expect(String(err.response!['message'])).toContain('not yet supported in a review-mode source');
      },
    );
  };

  it('refuses a topic move — and changes nothing', async () => {
    const { ops, plain } = await seedItems();
    const before = { ops: await fileOf(ctx, ops), plain: await fileOf(ctx, plain) };
    await setMode('review');

    // Moving an item OUT of the review source…
    const opsRow = await rowOf(ctx, ops);
    await expectRefusal(
      commands.update(actor, ops, { frontmatter: { topic: 'Default' } }, opsRow.version_token, 'rest'),
      'topic move',
    );
    // …and INTO it.
    const plainRow = await rowOf(ctx, plain);
    await expectRefusal(
      commands.update(actor, plain, { frontmatter: { topic: 'Ops' } }, plainRow.version_token, 'rest'),
      'topic move',
    );

    // Nothing moved: rows, files and the outbox are exactly as they were.
    expect((await rowOf(ctx, ops)).version_token).toBe(opsRow.version_token);
    expect((await rowOf(ctx, ops)).deleted_at).toBeNull();
    expect((await fileOf(ctx, ops)).digest).toBe(before.ops.digest);
    expect((await fileOf(ctx, plain)).digest).toBe(before.plain.digest);
    expect(await outboxRows(ctx.db, ops)).toHaveLength(1);
    expect(await outboxRows(ctx.db, plain)).toHaveLength(1);
  });

  /**
   * Issues 76 + 80: soft delete, restore and resync are no longer refused here.
   * Delete is write-first now, so it unlinks the file and soft-deletes the row
   * and then STAGES the removal; this fixture has no usable change-request host
   * (no token in the env), so the attempt ends in the same 503 the create path
   * answers — after the file and the index were written. The staging itself is
   * proved against a real origin in `content-delete.e2e.test.ts`.
   */
  it('stages remove instead of refusing it, and skips a review source on resync', async () => {
    const { ops } = await seedItems();
    const file = await fileOf(ctx, ops);
    await setMode('review');

    // Resync: the review-mode source is counted out, the call still succeeds.
    expect(await items.resyncSpace('space_ops')).toEqual({ items: 0, skipped: 1 });

    await commands.remove(actor, ops).then(
      () => {
        throw new Error('expected the staging attempt to fail with no host configured');
      },
      (err: { status?: number; response?: Record<string, unknown> }) => {
        expect(err.status).toBe(503);
        expect(err.response).toMatchObject({ reason: 'review_host_unconfigured', source_id: 'topic:ops' });
      },
    );

    // The delete itself landed: the file is gone, the row is soft-deleted, and
    // the `delete` outbox row is what keeps the commit outstanding.
    expect(existsSync(file.abs)).toBe(false);
    expect((await rowOf(ctx, ops)).deleted_at).not.toBeNull();
    expect((await outboxRows(ctx.db, ops)).map((r) => r.kind)).toEqual(['upsert', 'delete']);
  });

  // "rename is not refused in a review source" is proved far better by
  // 'stages the subject and the rewritten linker, and never touches the base
  // branch' above, which shows the rename actually staging against a real
  // origin rather than merely not raising the guard.

  it('the same operations still work in a `direct` source', async () => {
    const { ops, plain } = await seedItems();

    // Topic move: the file lands in the new source and the row follows.
    const plainRow = await rowOf(ctx, plain);
    const moved = await commands.update(actor, plain, { frontmatter: { topic: 'Ops' } }, plainRow.version_token, 'rest');
    expect(moved.item.space_id).toBe('space_ops');
    expect((await rowOf(ctx, plain)).source_id).toBe('topic:ops');
    await expectInStep(ctx, plain);

    // Resync, soft delete and restore all go through.
    expect(await items.resyncSpace('space_ops')).toEqual({ items: 2, skipped: 0 });
    await commands.remove(actor, ops);
    expect((await rowOf(ctx, ops)).deleted_at).not.toBeNull();
    const restored = await commands.restore(actor, ops);
    expect(restored.item.id).toBe(ops);
    expect((await rowOf(ctx, ops)).deleted_at).toBeNull();
  });
});
