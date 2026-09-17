/**
 * `ContentCommands.move` (plan §8.3, issue 84): moving an item to another topic
 * — including a topic that lives in a **different repository**.
 *
 * What a move has to get right, and what this suite pins:
 *  - the file exists at the target path and is GONE from the source path;
 *  - both working trees commit, and each commit names the item id;
 *  - `file_path` / `source_id` / `space_id` follow the file;
 *  - two outbox rows (the arrival `upsert`, the departure `move`), each settled
 *    by its OWN repo's commit — the target's commit must not settle the source's;
 *  - `/p/:slug` and `/items/:id` keep resolving. `pages.slug` is allocated
 *    instance-wide and a move never changes it, so this holds by construction:
 *    there is no slug-alias table and none is needed;
 *  - a move out of, or into, a `read-only` source is a 403, and a move touching
 *    a `review` source keeps its 409 `review_unsupported_operation` (issue 80);
 *  - and the one the whole feature exists for: after a move, a drop-and-rebuild
 *    from the working trees sees the item EXACTLY ONCE. Before this, a topic
 *    change wrote the new file and left the old one behind, so a rebuild found
 *    the same `e3_id` twice.
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
import { conformant, curateCategories, seedAdminAndLogin } from './helpers.js';
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
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

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

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** Every commit message in the repo, subjects and bodies. */
function log(dir: string): string {
  return git(dir, 'log', '--format=%B');
}

function tracked(dir: string): string[] {
  return git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
}

async function spaceId(ctx: Ctx, slug: string): Promise<string> {
  const row = await ctx.db.selectFrom('spaces').select('id').where('slug', '=', slug).executeTakeFirstOrThrow();
  return row.id;
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
async function makeMoveApp(ctx: Ctx): Promise<void> {
  process.env['DB_URL'] = ':memory:';
  ctx.root = mkdtempSync(join(tmpdir(), 'e3-move-root-'));
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
  await curateCategories(ctx.app);
  ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
  ctx.paths = ctx.app.get(ContentPathResolver);
  ctx.mirror = ctx.app.get<RoutingRevisionMirror>(REVISION_MIRROR);
  ctx.registry = ctx.app.get(SourceRegistryService);
}

async function closeMoveApp(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  delete process.env['GIT_MIRROR_ROOT'];
  rmSync(ctx.root, { recursive: true, force: true });
}

/** A published fixture carries the frontmatter the publish gate asks for; a draft is sent as given. */
async function createItem(ctx: Ctx, body: Record<string, unknown>): Promise<{ id: string; slug: string; version_token: number }> {
  const published = body['status'] === 'published';
  const res = await request(ctx.app.getHttpServer())
    .post('/api/v1/items')
    .set('Cookie', ctx.cookie)
    .send(published ? { ...body, frontmatter: conformant(body['frontmatter'] as Record<string, unknown> | undefined) } : body)
    .expect(201);
  return res.body.item;
}

function moveRequest(ctx: Ctx, id: string, topic: string, ifMatch?: number) {
  const req = request(ctx.app.getHttpServer()).post(`/api/v1/items/${id}/move`).set('Cookie', ctx.cookie);
  if (ifMatch !== undefined) req.set('If-Match', String(ifMatch));
  return req.send({ topic });
}

describe('move: the file, the index and both repositories follow the item', () => {
  const ctx = {} as Ctx;

  beforeEach(async () => {
    await makeMoveApp(ctx);
    const spaces = ctx.app.get(SpacesService);
    await spaces.create({ name: 'Ops' });
    await spaces.create({ name: 'Notes' });
    await spaces.create({ name: 'Portal' });
    // Portal is a bundle of its own: `<root>/topics/portal`, source `topic:portal`.
    await ctx.registry.upsert('topic:portal', {});
  });
  afterEach(async () => closeMoveApp(ctx));

  it('cross-repo: the file leaves the main repo for the dedicated one, both commit, both outbox rows settle on their own commit', async () => {
    const item = await createItem(ctx, {
      title: 'Deployment Pipeline',
      body: 'The pipeline builds, tests and ships.',
      status: 'published',
      frontmatter: { topic: 'Ops', type: 'Concept' },
    });
    // A second item stays behind, so `ops` is not left an empty subtree.
    await createItem(ctx, { title: 'Rotate Secrets', body: 'Rotate.', status: 'published', frontmatter: { topic: 'Ops', type: 'How-To' } });
    await ctx.mirror.flush();

    const mainDir = ctx.paths.mainDir;
    const portalDir = join(ctx.paths.topicsDir, 'portal');
    const fromPath = 'ops/concepts/deployment-pipeline.md';
    const toPath = 'concepts/deployment-pipeline.md';
    expect(existsSync(join(mainDir, fromPath))).toBe(true);
    expect(tracked(mainDir)).toContain(fromPath);

    const moved = await moveRequest(ctx, item.id, 'Portal', item.version_token).expect(201);
    expect(moved.body.item).toMatchObject({ id: item.id, slug: 'deployment-pipeline' });

    // 1. The file is at the target path and GONE from the source path.
    expect(existsSync(join(portalDir, toPath))).toBe(true);
    expect(existsSync(join(mainDir, fromPath))).toBe(false);

    // 2. The row followed it: path, source and topic.
    const portalId = await spaceId(ctx, 'portal');
    const row = await rowOf(ctx, item.id);
    expect(row).toMatchObject({ file_path: toPath, source_id: 'topic:portal', space_id: portalId, slug: 'deployment-pipeline' });

    // 3. Two outbox rows: the arrival in the target source, the departure in the
    //    source it left. Both still pending — neither repo has committed yet.
    const beforeCommit = (await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null);
    expect(beforeCommit).toHaveLength(2);
    expect(beforeCommit.find((r) => r.kind === 'upsert')).toMatchObject({ source_id: 'topic:portal', file_path: toPath });
    expect(beforeCommit.find((r) => r.kind === 'move')).toMatchObject({ source_id: 'main', file_path: fromPath, actor_id: ctx.adminId });

    // A restart replays both halves from the outbox: the arrival from the page's
    // current state, the departure from its pending `move` row (nothing else
    // would ever stage that deletion — the committer's `git add` is path-scoped).
    expect(await ctx.app.get(OutboxReplayService).replay()).toEqual({ replayed: 1 });

    await ctx.mirror.flush();

    // 4. Both working trees committed, and each commit names the item id.
    expect(tracked(mainDir)).not.toContain(fromPath);
    expect(tracked(portalDir)).toContain(toPath);
    expect(log(mainDir)).toContain(`e3-move-out: ${item.id} ${fromPath}`);
    expect(log(portalDir)).toContain(`e3-move-in: ${item.id} ${toPath}`);
    expect(git(mainDir, 'status', '--porcelain').trim()).toBe('');
    expect(git(portalDir, 'status', '--porcelain').trim()).toBe('');

    // 5. Both rows are processed — each by its own repo's commit.
    expect((await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null)).toHaveLength(0);

    // 6. The claim that replaces the alias table: both handles still resolve.
    const byId = await request(ctx.app.getHttpServer()).get(`/api/v1/items/${item.id}`).set('Cookie', ctx.cookie).expect(200);
    expect(byId.body.item).toMatchObject({ id: item.id, slug: 'deployment-pipeline', space_id: portalId });
    const bySlug = await request(ctx.app.getHttpServer())
      .get('/api/v1/pages/by-slug/deployment-pipeline')
      .set('Cookie', ctx.cookie)
      .expect(200);
    expect(bySlug.body.page).toMatchObject({ id: item.id, space_id: portalId });
  });

  it('same repo, another subtree: one working tree, two commits, both naming the item', async () => {
    const item = await createItem(ctx, {
      title: 'Runbook Draft',
      body: 'Steps.',
      status: 'published',
      frontmatter: { topic: 'Ops', type: 'Runbook' },
    });
    await ctx.mirror.flush();
    const mainDir = ctx.paths.mainDir;
    expect(tracked(mainDir)).toContain('ops/concepts/runbook-draft.md');

    await moveRequest(ctx, item.id, 'Notes', item.version_token).expect(201);

    expect(existsSync(join(mainDir, 'notes/concepts/runbook-draft.md'))).toBe(true);
    expect(existsSync(join(mainDir, 'ops/concepts/runbook-draft.md'))).toBe(false);
    const notesId = await spaceId(ctx, 'notes');
    expect(await rowOf(ctx, item.id)).toMatchObject({
      file_path: 'notes/concepts/runbook-draft.md',
      source_id: 'main',
      space_id: notesId,
    });

    await ctx.mirror.flush();
    expect(tracked(mainDir)).toContain('notes/concepts/runbook-draft.md');
    expect(tracked(mainDir)).not.toContain('ops/concepts/runbook-draft.md');
    const messages = log(mainDir);
    expect(messages).toContain(`e3-move-in: ${item.id} notes/concepts/runbook-draft.md`);
    expect(messages).toContain(`e3-move-out: ${item.id} ops/concepts/runbook-draft.md`);
    expect(git(mainDir, 'status', '--porcelain').trim()).toBe('');
    expect((await outboxRows(ctx, item.id)).filter((r) => r.processed_at === null)).toHaveLength(0);
  });

  it('refuses to move a file that drifted on disk — 409 changed_on_disk, nothing removed', async () => {
    const item = await createItem(ctx, {
      title: 'Drifting Note',
      body: 'v1',
      status: 'published',
      frontmatter: { topic: 'Ops', type: 'Concept' },
    });
    await ctx.mirror.flush();
    const from = join(ctx.paths.mainDir, 'ops/concepts/drifting-note.md');
    const edited = `${readFileSync(from, 'utf8')}

Edited by an agent on disk.
`;
    writeFileSync(from, edited, 'utf8');

    const refused = await moveRequest(ctx, item.id, 'Portal', item.version_token).expect(409);
    expect(refused.body).toMatchObject({ reason: 'changed_on_disk', file_path: 'ops/concepts/drifting-note.md' });

    // The on-disk edit stands, nothing landed in the target repo, the row is unchanged.
    expect(readFileSync(from, 'utf8')).toBe(edited);
    expect(existsSync(join(ctx.paths.topicsDir, 'portal', 'concepts', 'drifting-note.md'))).toBe(false);
    expect(await rowOf(ctx, item.id)).toMatchObject({ source_id: 'main', file_path: 'ops/concepts/drifting-note.md' });
  });

  it('after a move, a drop-and-rebuild from the working trees sees the item exactly once', async () => {
    const moved = await createItem(ctx, {
      title: 'Prompting Basics',
      body: 'Patterns that work.',
      status: 'published',
      frontmatter: { topic: 'Ops', type: 'How-To' },
    });
    const stayed = await createItem(ctx, {
      title: 'Rotate Secrets',
      body: 'Rotate.',
      status: 'published',
      frontmatter: { topic: 'Ops', type: 'How-To' },
    });
    await ctx.mirror.flush();
    await moveRequest(ctx, moved.id, 'Portal', moved.version_token).expect(201);
    await ctx.mirror.flush();

    const mainDir = ctx.paths.mainDir;
    const portalDir = join(ctx.paths.topicsDir, 'portal');
    const report = await ctx.app.get(IndexRebuildService).rebuildFromRepos(
      [
        { dir: mainDir, sourceId: 'main' },
        { dir: portalDir, sourceId: 'topic:portal' },
      ],
      { actorId: ctx.adminId },
    );
    // Two files across the two trees, two rows — not three. This is the
    // `e3_id`-twice hazard the move flow exists to close.
    expect(report.pages).toBe(2);

    const rows = await ctx.db.selectFrom('pages').select(['id', 'slug', 'source_id', 'file_path']).execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.id === moved.id)).toHaveLength(1);
    expect(rows.find((r) => r.id === moved.id)).toMatchObject({
      slug: 'prompting-basics',
      source_id: 'topic:portal',
      file_path: 'concepts/prompting-basics.md',
    });
    expect(rows.find((r) => r.id === stayed.id)).toMatchObject({
      source_id: 'main',
      file_path: 'ops/concepts/rotate-secrets.md',
    });

    // And it is still reachable by both handles after the rebuild.
    const byId = await request(ctx.app.getHttpServer()).get(`/api/v1/items/${moved.id}`).set('Cookie', ctx.cookie).expect(200);
    expect(byId.body.item.id).toBe(moved.id);
    const bySlug = await request(ctx.app.getHttpServer())
      .get('/api/v1/pages/by-slug/prompting-basics')
      .set('Cookie', ctx.cookie)
      .expect(200);
    expect(bySlug.body.page.id).toBe(moved.id);
  });
});

describe('move: the policy guards on both ends (plan §8.2, issue 80)', () => {
  const ctx = {} as Ctx;

  // A well-formed but unreachable remote: every case here is refused before any
  // git call, so the remote only has to exist for the policy to be meaningful.
  const GUARD_REMOTE = 'https://github.com/acme/guard.git';

  beforeEach(async () => {
    await makeMoveApp(ctx);
    const spaces = ctx.app.get(SpacesService);
    await spaces.create({ name: 'Ops' });
    await spaces.create({ name: 'Vendor Docs' });
    // Both bound to their own sources, `direct` while the fixtures are created.
    await ctx.registry.upsert('topic:ops', { mode: 'direct' });
    await ctx.registry.upsert('topic:vendor-docs', { mode: 'direct' });
  });
  afterEach(async () => closeMoveApp(ctx));

  async function seed(): Promise<{ ops: { id: string; version_token: number }; vendor: { id: string; version_token: number } }> {
    const ops = await createItem(ctx, { title: 'Ops Item', body: 'in ops', frontmatter: { topic: 'Ops', type: 'Concept' } });
    const vendor = await createItem(ctx, { title: 'Vendor Item', body: 'in vendor', frontmatter: { topic: 'Vendor Docs', type: 'Concept' } });
    expect((await rowOf(ctx, ops.id)).source_id).toBe('topic:ops');
    expect((await rowOf(ctx, vendor.id)).source_id).toBe('topic:vendor-docs');
    return { ops, vendor };
  }

  it('a move INTO and OUT OF a read-only source is 403 source_read_only, and nothing moves', async () => {
    const { ops, vendor } = await seed();
    await ctx.registry.upsert('topic:vendor-docs', { mode: 'read-only' });
    const opsFile = join(ctx.paths.topicsDir, 'ops', 'concepts', 'ops-item.md');
    const vendorFile = join(ctx.paths.topicsDir, 'vendor-docs', 'concepts', 'vendor-item.md');

    // INTO: the target is read-only — nobody publishes there.
    const into = await moveRequest(ctx, ops.id, 'Vendor Docs', ops.version_token).expect(403);
    expect(into.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:vendor-docs' });

    // OUT OF: the move would delete a file in a tree we do not write.
    const outOf = await moveRequest(ctx, vendor.id, 'Ops', vendor.version_token).expect(403);
    expect(outOf.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:vendor-docs' });

    // Neither file moved and neither row changed.
    expect(existsSync(opsFile)).toBe(true);
    expect(existsSync(vendorFile)).toBe(true);
    expect(await rowOf(ctx, ops.id)).toMatchObject({ source_id: 'topic:ops', version_token: ops.version_token });
    expect(await rowOf(ctx, vendor.id)).toMatchObject({ source_id: 'topic:vendor-docs', version_token: vendor.version_token });
  });

  it('a move INTO and OUT OF a review source is 409 review_unsupported_operation, and nothing moves', async () => {
    const { ops, vendor } = await seed();
    await ctx.registry.upsert('topic:ops', {
      mode: 'review',
      remote_url: GUARD_REMOTE,
      branch: 'main',
      host_kind: 'github',
      host_base_url: 'https://api.github.test',
      host_token_env: 'E3_TEST_MOVE_GUARD_TOKEN',
    });
    const opsFile = join(ctx.paths.topicsDir, 'ops', 'concepts', 'ops-item.md');

    const outOf = await moveRequest(ctx, ops.id, 'Vendor Docs', ops.version_token).expect(409);
    expect(outOf.body).toMatchObject({ reason: 'review_unsupported_operation', operation: 'topic move', source_id: 'topic:ops' });

    const into = await moveRequest(ctx, vendor.id, 'Ops', vendor.version_token).expect(409);
    expect(into.body).toMatchObject({ reason: 'review_unsupported_operation', operation: 'topic move', source_id: 'topic:ops' });

    expect(existsSync(opsFile)).toBe(true);
    expect(await rowOf(ctx, ops.id)).toMatchObject({ source_id: 'topic:ops', version_token: ops.version_token });
    expect(await rowOf(ctx, vendor.id)).toMatchObject({ source_id: 'topic:vendor-docs', version_token: vendor.version_token });

    // Back to `direct` and the same move goes through — the refusal was the
    // policy, not a broken move.
    await ctx.registry.upsert('topic:ops', { mode: 'direct', remote_url: null });
    await moveRequest(ctx, ops.id, 'Vendor Docs', ops.version_token).expect(201);
    expect(existsSync(opsFile)).toBe(false);
    expect(await rowOf(ctx, ops.id)).toMatchObject({ source_id: 'topic:vendor-docs', file_path: 'concepts/ops-item.md' });
  });
});
