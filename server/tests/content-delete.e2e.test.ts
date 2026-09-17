/**
 * Soft delete and restore, write-first (issues 76 and 80).
 *
 * Before this, a delete was DB-only: the concept file stayed in the working
 * tree, so a drop-and-rebuild resurrected the item — and because the door was
 * not inverted it could not stage onto a change-request branch either, so a
 * `review` source refused it outright.
 *
 * What this suite pins:
 *  - the file leaves the working tree BEFORE the row is soft-deleted, the repo
 *    commits the removal (with the item id in the message), and the `delete`
 *    outbox row settles on that commit;
 *  - restore is the mirror image: the file is re-rendered and re-written, and
 *    committed;
 *  - the one the feature exists for: a drop-and-rebuild after a delete does NOT
 *    bring the item back, and after a restore it sees it exactly once;
 *  - the guards are the same ones an edit gets: `read-only` is a 403, a file
 *    that drifted underneath the index is a 409 and nothing is removed;
 *  - in a `review` source the removal is proposed on the item branch and the
 *    base branch keeps the file until the change request merges;
 *  - and the inbound path — a file deleted UPSTREAM — still soft-deletes with
 *    no file removal and no outbox row: there is nothing to push back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import type { FetchImpl } from '@echozedlabs/repo-sync';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { OutboxReplayService } from '../src/content/outbox-replay.service.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { InboundIndexService } from '../src/sync/inbound-index.service.js';
import { ReviewService } from '../src/sync/review.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** Every commit message in the repo, subjects and bodies. */
function log(dir: string): string {
  return git(dir, 'log', '--format=%B');
}

function tracked(dir: string, ref = 'HEAD'): string[] {
  return git(dir, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
}

function fileOnRef(dir: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${ref}:${path}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

interface Ctx {
  app: INestApplication;
  cookie: string;
  adminId: string;
  db: Kysely<Database>;
  paths: ContentPathResolver;
  mirror: RoutingRevisionMirror;
  registry: SourceRegistryService;
  root: string;
}

async function rowOf(ctx: Ctx, id: string) {
  return ctx.db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function outboxRows(ctx: Ctx, pageId: string) {
  return ctx.db
    .selectFrom('content_outbox')
    .selectAll()
    .where('page_id', '=', pageId)
    .orderBy('created_at', 'asc')
    .execute();
}

/** The production wiring, with a short debounce so `flush()` is the only wait. */
async function makeDeleteApp(ctx: Ctx): Promise<void> {
  process.env['DB_URL'] = ':memory:';
  ctx.root = mkdtempSync(join(tmpdir(), 'e3-delete-root-'));
  process.env['GIT_MIRROR_ROOT'] = ctx.root;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REVISION_MIRROR)
    .useFactory({
      factory: (kysely: Kysely<Database>, outbox: OutboxService, resolver: ContentPathResolver) =>
        new RoutingRevisionMirror(resolver.root, kysely, {
          quietMs: 20,
          maxMs: 50,
          onCommitted: (committed, at) =>
            outbox.markProcessed(
              committed.map((c) => ({ pageId: c.itemId, path: c.path })),
              at,
            ),
        }),
      inject: [KYSELY, OutboxService, ContentPathResolver],
    })
    .compile();
  ctx.app = moduleRef.createNestApplication();
  configureApp(ctx.app, { webDist: null });
  await ctx.app.init();
  const login = await seedAdminAndLogin(ctx.app);
  ctx.cookie = login.cookie;
  ctx.adminId = login.userId;
  // The items these suites publish are conformant documents: a create that
  // lands published is gated like any other publish (issue 98).
  await curateCategories(ctx.app);
  ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
  ctx.paths = ctx.app.get(ContentPathResolver);
  ctx.mirror = ctx.app.get<RoutingRevisionMirror>(REVISION_MIRROR);
  ctx.registry = ctx.app.get(SourceRegistryService);
}

async function closeDeleteApp(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  delete process.env['GIT_MIRROR_ROOT'];
  rmSync(ctx.root, { recursive: true, force: true });
}

async function createItem(ctx: Ctx, body: Record<string, unknown>): Promise<{ id: string; slug: string; version_token: number }> {
  const res = await request(ctx.app.getHttpServer())
    .post('/api/v1/items')
    .set('Cookie', ctx.cookie)
    .send(body)
    .expect(201);
  return res.body.item;
}

function deleteRequest(ctx: Ctx, id: string) {
  return request(ctx.app.getHttpServer()).delete(`/api/v1/pages/${id}`).set('Cookie', ctx.cookie);
}

function restoreRequest(ctx: Ctx, id: string) {
  return request(ctx.app.getHttpServer()).post(`/api/v1/pages/${id}/restore`).set('Cookie', ctx.cookie);
}

describe('delete: the file leaves the working tree and the repository commits it', () => {
  const ctx = {} as Ctx;

  beforeEach(async () => {
    await makeDeleteApp(ctx);
    await ctx.app.get(SpacesService).create({ name: 'Ops' });
  });

  /** Portal is a bundle of its own: `<root>/topics/portal`, source `topic:portal`. */
  async function dedicatedPortal(): Promise<void> {
    await ctx.app.get(SpacesService).create({ name: 'Portal' });
    await ctx.registry.upsert('topic:portal', {});
  }
  afterEach(async () => closeDeleteApp(ctx));

  it('unlinks the file, commits the removal, and settles the delete outbox row on that commit', async () => {
    const item = await createItem(ctx, {
      title: 'Deployment Pipeline',
      body: 'The pipeline builds, tests and ships.',
      status: 'published',
      frontmatter: conformant({ topic: 'Ops', type: 'Concept' }),
    });
    // A second item stays behind, so `ops` is not left an empty subtree.
    await createItem(ctx, { title: 'Rotate Secrets', body: 'Rotate.', status: 'published', frontmatter: conformant({ topic: 'Ops', type: 'How-To' }) });
    await ctx.mirror.flush();

    const mainDir = ctx.paths.mainDir;
    const path = 'ops/concepts/deployment-pipeline.md';
    expect(tracked(mainDir)).toContain(path);

    await deleteRequest(ctx, item.id).expect(204);

    // 1. The file is gone from the working tree, before anything was committed.
    expect(existsSync(join(mainDir, path))).toBe(false);
    // 2. The row is soft-deleted and still remembers the file, which is what a
    //    restore re-renders from.
    const row = await rowOf(ctx, item.id);
    expect(row.deleted_at).not.toBeNull();
    expect(row).toMatchObject({ file_path: path, source_id: 'main' });

    // 3. One `delete` outbox row, still pending: the repo has not committed yet.
    const pending = (await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'delete', source_id: 'main', file_path: path, actor_id: ctx.adminId });

    // A restart replays the removal from that row: the page has no arrival
    // event of its own any more, and nothing else would ever stage the deletion
    // (the committer's `git add` is path-scoped).
    expect(await ctx.app.get(OutboxReplayService).replay()).toEqual({ replayed: 0 });

    await ctx.mirror.flush();

    // 4. The repo committed the removal, naming the item, and nothing is left dirty.
    expect(tracked(mainDir)).not.toContain(path);
    expect(log(mainDir)).toContain(`e3-remove: ${item.id} ${path}`);
    expect(git(mainDir, 'status', '--porcelain').trim()).toBe('');
    // A deletion is not a departure: the move trailer must not appear for it.
    expect(log(mainDir)).not.toContain('e3-move-out:');

    // 5. The outbox row settled on that commit.
    expect((await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null)).toHaveLength(0);

    // 6. The item is gone from every read door.
    const gone = await request(ctx.app.getHttpServer()).get(`/api/v1/items/${item.id}`).set('Cookie', ctx.cookie).expect(200);
    expect(gone.body.item).toBeNull();
  });

  it('restore rewrites the file and commits it again', async () => {
    const item = await createItem(ctx, {
      title: 'Runbook Draft',
      body: 'Steps.',
      status: 'published',
      frontmatter: conformant({ topic: 'Ops', type: 'Runbook' }),
    });
    await ctx.mirror.flush();
    const mainDir = ctx.paths.mainDir;
    const path = 'ops/concepts/runbook-draft.md';
    const before = readFileSync(join(mainDir, path), 'utf8');

    await deleteRequest(ctx, item.id).expect(204);
    await ctx.mirror.flush();
    expect(tracked(mainDir)).not.toContain(path);

    const restored = await restoreRequest(ctx, item.id).expect(201);
    expect(restored.body.page).toMatchObject({ id: item.id, slug: 'runbook-draft' });

    // The file is back, byte for byte — it is rendered from the same row.
    expect(readFileSync(join(mainDir, path), 'utf8')).toBe(before);
    const row = await rowOf(ctx, item.id);
    expect(row.deleted_at).toBeNull();
    expect(row).toMatchObject({ file_path: path, source_id: 'main' });

    // An `upsert` row for the restore, settled by the commit that follows.
    const rows = await outboxRows(ctx, item.id);
    expect(rows.map((r) => r.kind)).toEqual(['upsert', 'delete', 'upsert']);
    await ctx.mirror.flush();
    expect(tracked(mainDir)).toContain(path);
    expect(git(mainDir, 'status', '--porcelain').trim()).toBe('');
    expect((await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null)).toHaveLength(0);
  });

  /** Two items in the `ops` subtree of the main repo; the first is the subject. */
  async function seedPair(): Promise<{ subject: { id: string }; kept: { id: string } }> {
    const subject = await createItem(ctx, {
      title: 'Prompting Basics',
      body: 'Patterns that work.',
      status: 'published',
      frontmatter: conformant({ topic: 'Ops', type: 'How-To' }),
    });
    const kept = await createItem(ctx, {
      title: 'Rotate Secrets',
      body: 'Rotate.',
      status: 'published',
      frontmatter: conformant({ topic: 'Ops', type: 'How-To' }),
    });
    await ctx.mirror.flush();
    return { subject, kept };
  }

  function rebuild() {
    return ctx.app
      .get(IndexRebuildService)
      .rebuildFromRepos([{ dir: ctx.paths.mainDir, sourceId: 'main' }], { actorId: ctx.adminId });
  }

  it('after a delete, a drop-and-rebuild does NOT bring the item back', async () => {
    const { subject, kept } = await seedPair();
    await deleteRequest(ctx, subject.id).expect(204);
    await ctx.mirror.flush();

    // The whole point of issue 76: one file in the tree, one row after a rebuild.
    expect(await rebuild()).toMatchObject({ pages: 1 });
    const rows = await ctx.db.selectFrom('pages').select(['id', 'slug']).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: kept.id, slug: 'rotate-secrets' });
  });

  it('after a delete and a restore, a drop-and-rebuild sees the item exactly once', async () => {
    const { subject } = await seedPair();
    await deleteRequest(ctx, subject.id).expect(204);
    await restoreRequest(ctx, subject.id).expect(201);
    await ctx.mirror.flush();

    expect(await rebuild()).toMatchObject({ pages: 2 });
    const rows = await ctx.db.selectFrom('pages').select(['id', 'slug', 'file_path']).execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.id === subject.id)).toHaveLength(1);
    expect(rows.find((r) => r.id === subject.id)).toMatchObject({
      slug: 'prompting-basics',
      file_path: 'ops/concepts/prompting-basics.md',
    });
  });

  it('refuses to delete a file that drifted on disk — 409 changed_on_disk, nothing removed', async () => {
    const item = await createItem(ctx, {
      title: 'Drifting Note',
      body: 'v1',
      status: 'published',
      frontmatter: conformant({ topic: 'Ops', type: 'Concept' }),
    });
    await ctx.mirror.flush();
    const abs = join(ctx.paths.mainDir, 'ops/concepts/drifting-note.md');
    const edited = `${readFileSync(abs, 'utf8')}\n\nEdited by an agent on disk.\n`;
    writeFileSync(abs, edited, 'utf8');

    const refused = await deleteRequest(ctx, item.id).expect(409);
    expect(refused.body).toMatchObject({ reason: 'changed_on_disk', file_path: 'ops/concepts/drifting-note.md' });

    // The on-disk edit stands, the row is untouched, and no `delete` row exists.
    expect(readFileSync(abs, 'utf8')).toBe(edited);
    expect((await rowOf(ctx, item.id)).deleted_at).toBeNull();
    expect((await outboxRows(ctx, item.id)).map((r) => r.kind)).toEqual(['upsert']);
  });

  it('a delete and a restore in a read-only source are 403 source_read_only, and the file is untouched', async () => {
    await dedicatedPortal();
    const item = await createItem(ctx, {
      title: 'Vendor Note',
      body: 'upstream owns this',
      status: 'published',
      frontmatter: conformant({ topic: 'Portal', type: 'Concept' }),
    });
    await ctx.mirror.flush();
    const abs = join(ctx.paths.topicsDir, 'portal', 'concepts', 'vendor-note.md');
    const before = readFileSync(abs, 'utf8');
    await ctx.registry.upsert('topic:portal', { mode: 'read-only' });

    const refused = await deleteRequest(ctx, item.id).expect(403);
    expect(refused.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:portal' });
    expect(readFileSync(abs, 'utf8')).toBe(before);
    expect((await rowOf(ctx, item.id)).deleted_at).toBeNull();

    // Restoring INTO a read-only source is refused for the same reason: the
    // write would add a file to a tree nobody here publishes.
    await ctx.registry.upsert('topic:portal', { mode: 'direct' });
    await deleteRequest(ctx, item.id).expect(204);
    await ctx.registry.upsert('topic:portal', { mode: 'read-only' });
    const refusedRestore = await restoreRequest(ctx, item.id).expect(403);
    expect(refusedRestore.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:portal' });
    expect(existsSync(abs)).toBe(false);
    expect((await rowOf(ctx, item.id)).deleted_at).not.toBeNull();
  });

  it('an inbound deletion (the file vanished upstream) indexes only: no outbox row, no file removal', async () => {
    await dedicatedPortal();
    const item = await createItem(ctx, {
      title: 'Upstream Note',
      body: 'authored elsewhere',
      status: 'published',
      frontmatter: conformant({ topic: 'Portal', type: 'Concept' }),
    });
    await ctx.mirror.flush();
    const path = 'concepts/upstream-note.md';
    const abs = join(ctx.paths.topicsDir, 'portal', path);
    // The merge that brought the deletion in has already removed the file.
    rmSync(abs);

    const source = (await ctx.registry.get('topic:portal'))!;
    await ctx.app.get(InboundIndexService).indexPath(source, { path, change: 'deleted' });

    expect((await rowOf(ctx, item.id)).deleted_at).not.toBeNull();
    // Only the create's `upsert` row: an upstream deletion is already in the
    // repository, so there is nothing to push back.
    expect((await outboxRows(ctx, item.id)).map((r) => r.kind)).toEqual(['upsert']);
  });
});

/**
 * Review policy (plan §8.2, issue 80): a delete in a `review` source proposes
 * the removal on the item branch instead of committing it to the base branch.
 * The fixture is the one `sync-review.e2e.test.ts` uses — a temp bare origin
 * and the real GitHub adapter over an injected `fetchImpl`, with the GitHub URL
 * rewritten to the bare repo by a repo-local `insteadOf`.
 */
describe('delete: in a review source the removal is staged, not committed to base', () => {
  const GITHUB_REMOTE = 'https://github.com/acme/kb.git';
  const PR_URL = 'https://github.com/acme/kb/pull/12';
  const TOKEN_ENV = 'E3_TEST_DELETE_REVIEW_TOKEN';

  let app: INestApplication;
  let db: Kysely<Database>;
  let registry: SourceRegistryService;
  let cookie: string;
  let tmp: string;
  let root: string;
  let bare: string;
  let local: string;
  let calls: { url: string; method: string; body: Record<string, unknown> | undefined }[];

  const openChangeCalls = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pulls'));

  const fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    if (method === 'POST' && url.endsWith('/pulls')) {
      return new Response(JSON.stringify({ number: 12, html_url: PR_URL, state: 'open', merged: false }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-delete-review-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    process.env[TOKEN_ENV] = 'test-token';
    calls = [];

    // A bare origin with one commit on `main`.
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

    // The working tree the server writes into, on `main`, with `origin` set to
    // the GitHub URL the host adapter parses (rewritten to the bare repo).
    local = join(root, 'topics', 'ops');
    execFileSync('git', ['init', '-q', '--initial-branch=main', local]);
    git(local, 'config', 'user.email', 'knowledge-e3@localhost');
    git(local, 'config', 'user.name', 'Knowledge E3');
    git(local, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, GITHUB_REMOTE);
    git(local, 'remote', 'add', 'origin', GITHUB_REMOTE);
    git(local, 'fetch', '-q', 'origin');
    git(local, 'reset', '--hard', 'origin/main');

    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);
    db = app.get<Kysely<Database>>(KYSELY);
    registry = app.get(SourceRegistryService);
    app.get(ReviewService).fetchImpl = fetchImpl;
    await app.get(SpacesService).create({ name: 'Ops' });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    delete process.env[TOKEN_ENV];
    rmSync(tmp, { recursive: true, force: true });
  });

  async function registerSource(mode: 'direct' | 'review'): Promise<void> {
    await registry.upsert('topic:ops', {
      remote_url: GITHUB_REMOTE,
      branch: 'main',
      role: 'authoritative',
      mode,
      host_kind: 'github',
      host_base_url: 'https://api.github.test',
      host_token_env: TOKEN_ENV,
    });
  }

  it('stages a removal commit on the item branch, leaves the file on base, and opens exactly one change request', async () => {
    // The item is authored while the source is `direct`, so its file really is
    // on the base branch — the state a proposed removal has to start from.
    await registerSource('direct');
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title: 'Checklist',
        body: 'the checklist\n',
        status: 'published',
        frontmatter: conformant({ topic: 'Ops', type: 'Concept', description: 'Ops checklist.' }),
      })
      .expect(201);
    const page = created.body.page as { id: string };
    const path = 'concepts/checklist.md';
    await app.get<RoutingRevisionMirror>(REVISION_MIRROR).flush();
    expect(tracked(local, 'main')).toContain(path);

    await registerSource('review');
    await request(app.getHttpServer()).delete(`/api/v1/pages/${page.id}`).set('Cookie', cookie).expect(204);

    const row = await db.selectFrom('pages').selectAll().where('id', '=', page.id).executeTakeFirstOrThrow();
    // The item is gone from this index immediately; the change request is what
    // carries the intent upstream.
    expect(row.deleted_at).not.toBeNull();
    expect(row.review_state).toBe('open');
    const branch = row.review_branch!;
    expect(branch).toMatch(/^e3\/checklist-/);

    // The base branch still has the file; the item branch is one commit that
    // deletes it.
    expect(tracked(local, 'main')).toContain(path);
    expect(git(local, 'rev-list', '--count', `main..${branch}`).trim()).toBe('1');
    expect(fileOnRef(local, branch, path)).toBeNull();
    expect(fileOnRef(bare, branch, path)).toBeNull();
    expect(fileOnRef(bare, `refs/heads/${branch}`, 'README.md')).not.toBeNull();

    // Exactly one change request, and it reads as a removal.
    expect(openChangeCalls()).toHaveLength(1);
    const opened = openChangeCalls()[0]!;
    expect(opened.body).toMatchObject({ title: 'Remove Checklist', head: branch, base: 'main' });
    expect(String(opened.body!['body'])).toContain('deleted in Knowledge E3');

    // Staging put the working-tree copy back to the base version, so the
    // `direct` committer and the sync merge can never sweep the removal onto
    // base. The tree is clean.
    expect(existsSync(join(local, path))).toBe(true);
    expect(git(local, 'status', '--porcelain').trim()).toBe('');

    // The `delete` outbox row was settled by the branch push.
    const outbox = await db.selectFrom('content_outbox').selectAll().where('page_id', '=', page.id).execute();
    expect(outbox.find((r) => r.kind === 'delete')?.processed_at).toBeTruthy();
  });
});
