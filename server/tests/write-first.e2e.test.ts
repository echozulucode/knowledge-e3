/**
 * Write-first (plan §7.2–7.3): the concept file in the local bundle working
 * tree is written first, then the index + outbox row land in one transaction,
 * then the git mirror is asked to commit. Every door (REST /items, /pages, MCP)
 * takes this path; reads and response shapes are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Kysely } from 'kysely';
import { digestOf } from '@echozedlabs/content-store';
import { conformant, curateCategories, makeApp, seedAdminAndLogin } from './helpers.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { OutboxReplayService } from '../src/content/outbox-replay.service.js';
import { CreateItemTool } from '../src/mcp/tools/create-item.tool.js';

interface Ctx {
  app: INestApplication;
  cookie: string;
  adminId: string;
  db: Kysely<Database>;
  paths: ContentPathResolver;
}

async function fileFor(ctx: Ctx, pageId: string): Promise<{ abs: string; row: Database['pages'] }> {
  const row = await ctx.db.selectFrom('pages').selectAll().where('id', '=', pageId).executeTakeFirstOrThrow();
  const target = await ctx.paths.resolve(row.space_id);
  return { abs: join(target.repoDir, row.file_path ?? `${target.conceptDir}/${row.slug}.md`), row };
}

async function outboxRows(db: Kysely<Database>, pageId: string) {
  return db.selectFrom('content_outbox').selectAll().where('page_id', '=', pageId).orderBy('created_at', 'asc').execute();
}

/** The file is on disk, its digest is what the row indexed, and the outbox row exists. */
async function expectCanonical(ctx: Ctx, pageId: string, expectedPath: string): Promise<string> {
  const { abs, row } = await fileFor(ctx, pageId);
  expect(existsSync(abs)).toBe(true);
  const content = readFileSync(abs, 'utf8');
  expect(row.file_path).toBe(expectedPath);
  expect(row.source_id).toBe('main');
  expect(row.file_digest).toBe(digestOf(content));
  expect(content).toContain(`e3_id: ${pageId}`);
  return content;
}

describe('write-first: file → index+outbox → mirror (default wiring, no-op mirror)', () => {
  const ctx = {} as Ctx;

  beforeEach(async () => {
    ctx.app = await makeApp();
    ({ cookie: ctx.cookie, userId: ctx.adminId } = await seedAdminAndLogin(ctx.app));
    ctx.db = ctx.app.get<Kysely<Database>>(KYSELY);
    ctx.paths = ctx.app.get(ContentPathResolver);
    await curateCategories(ctx.app);
  });
  afterEach(async () => ctx.app.close());

  it('REST /items: writes the concept file, indexes its digest, and completes the outbox row at once', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', ctx.cookie)
      .send({ title: 'Write First', body: 'file before row', status: 'published', tags: ['ops'], frontmatter: conformant() })
      .expect(201);
    const item = created.body.item;
    expect(item).toMatchObject({ slug: 'write-first', version_token: 1 });

    const content = await expectCanonical(ctx, item.id, 'default/concepts/write-first.md');
    expect(content).toContain('file before row');
    // The file carries the same timestamps the row persisted.
    expect(content).toContain(`e3_created_at: ${item.created_at}`);
    expect(content).toContain(`timestamp: ${item.updated_at}`);

    const rows = await outboxRows(ctx.db, item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'upsert', source_id: 'main', file_path: 'default/concepts/write-first.md', actor_id: ctx.adminId });
    expect(rows[0]!.file_digest).toBe(digestOf(content));
    // No repo to commit to → processed immediately.
    expect(rows[0]!.processed_at).not.toBeNull();

    // Reads are unchanged: raw_markdown is still the user's document, not the file rendering.
    const got = await request(ctx.app.getHttpServer()).get(`/api/v1/items/${item.id}`).set('Cookie', ctx.cookie).expect(200);
    expect(got.body.item.raw_markdown).toBe(item.raw_markdown);
    expect(got.body.item.raw_markdown).not.toContain('e3_id');
  });

  it('REST /pages (ui door): same file, same /pages response shape', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', ctx.cookie)
      .send({ title: 'UI Page', body: 'from the editor', status: 'published', frontmatter: conformant() })
      .expect(201);
    expect(created.body.version_token).toBe(1);
    expect(created.body.page).toMatchObject({ title: 'UI Page', status: 'published', published_at: expect.any(String) });
    await expectCanonical(ctx, created.body.page.id, 'default/concepts/ui-page.md');
    expect((await outboxRows(ctx.db, created.body.page.id))[0]?.processed_at).not.toBeNull();
  });

  it('MCP create_item: same file in the topic subtree', async () => {
    const tool = ctx.app.get(CreateItemTool);
    const result = await tool.execute(ctx.adminId, { title: 'Agent Note', body: 'via mcp', space: 'Ops' });
    const item = result.item as { id: string; space_id: string };
    const { abs, row } = await fileFor(ctx, item.id);
    expect(row.file_path).toBe('ops/concepts/agent-note.md');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toContain('e3_space: Ops');
    expect(await outboxRows(ctx.db, item.id)).toHaveLength(1);
  });

  it('update rewrites the file, re-indexes the digest, and adds an outbox row; an external edit → 409 changed_on_disk until reindexed', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', ctx.cookie)
      .send({ title: 'Evolving', body: 'v1', status: 'published', frontmatter: conformant() })
      .expect(201);
    const id = created.body.item.id as string;
    const { abs } = await fileFor(ctx, id);
    const before = digestOf(readFileSync(abs, 'utf8'));

    await request(ctx.app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', '1')
      .send({ body: 'v2' })
      .expect(200);
    const content = await expectCanonical(ctx, id, 'default/concepts/evolving.md');
    expect(content).toContain('v2');
    expect(digestOf(content)).not.toBe(before);
    expect(await outboxRows(ctx.db, id)).toHaveLength(2);

    // Someone edits the file directly (an agent, a git pull): the index is behind.
    writeFileSync(abs, content.replace('v2', 'v2 edited on disk'), 'utf8');
    const conflict = await request(ctx.app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', '2')
      .send({ body: 'v3' })
      .expect(409);
    expect(conflict.body).toMatchObject({ reason: 'changed_on_disk', file_path: 'default/concepts/evolving.md' });
    // The conflict left the external edit untouched.
    expect(readFileSync(abs, 'utf8')).toContain('v2 edited on disk');

    // Reindex from the files: the index now derives from the edited file …
    const target = await ctx.paths.resolve('space_default');
    await ctx.app.get(IndexRebuildService).rebuildFromDir(target.repoDir, { actorId: ctx.adminId, sourceId: 'main' });
    const reindexed = await request(ctx.app.getHttpServer()).get(`/api/v1/items/${id}`).set('Cookie', ctx.cookie).expect(200);
    expect(reindexed.body.item.body_markdown).toContain('v2 edited on disk');
    const row = await ctx.db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.file_digest).toBe(digestOf(readFileSync(abs, 'utf8')));
    expect(row.source_id).toBe('main');

    // … and the next edit goes through.
    await request(ctx.app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', String(reindexed.body.item.version_token))
      .send({ body: 'v3' })
      .expect(200);
    expect((await expectCanonical(ctx, id, 'default/concepts/evolving.md'))).toContain('v3');
  });

  it('compensates: when the index transaction fails after the file write, the file is removed', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', ctx.cookie)
      .send({ title: 'Twice', body: 'first' })
      .expect(201);
    // Same title in the same topic → the slug is free (twice-2) but the title is not: 409 inside the tx.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', ctx.cookie)
      .send({ title: 'Twice', body: 'second' })
      .expect(409);
    const target = await ctx.paths.resolve('space_default');
    expect(existsSync(join(target.repoDir, 'default/concepts/twice.md'))).toBe(true);
    expect(existsSync(join(target.repoDir, 'default/concepts/twice-2.md'))).toBe(false);
    const outbox = await ctx.db.selectFrom('content_outbox').selectAll().execute();
    expect(outbox).toHaveLength(1);
  });

  it('a stale If-Match fails before the file is touched', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', ctx.cookie)
      .send({ title: 'Guarded', body: 'v1' })
      .expect(201);
    const { abs } = await fileFor(ctx, created.body.item.id);
    const before = readFileSync(abs, 'utf8');
    const conflict = await request(ctx.app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', ctx.cookie)
      .set('If-Match', '99')
      .send({ body: 'stale' })
      .expect(409);
    expect(conflict.body.current_version_token).toBe(1);
    expect(readFileSync(abs, 'utf8')).toBe(before);
    expect(await outboxRows(ctx.db, created.body.item.id)).toHaveLength(1);
  });
});

describe('write-first with the git mirror: the adapter commits the file the command wrote', () => {
  let app: INestApplication;
  let cookie: string;
  let db: Kysely<Database>;
  let paths: ContentPathResolver;
  let mirror: RoutingRevisionMirror;

  beforeEach(async () => {
    process.env['DB_URL'] = ':memory:';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REVISION_MIRROR)
      .useFactory({
        // Same root as the command's resolver, so the mirror commits from the
        // working tree the command wrote into — exactly the production wiring.
        factory: (kysely: Kysely<Database>, outbox: OutboxService, resolver: ContentPathResolver) =>
          new RoutingRevisionMirror(resolver.root, kysely, {
            quietMs: 20,
            maxMs: 50,
            onCommitted: (committed, at) => outbox.markProcessed(committed.map((c) => ({ pageId: c.itemId, path: c.path })), at),
          }),
        inject: [KYSELY, OutboxService, ContentPathResolver],
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, { webDist: null });
    await app.init();
    ({ cookie } = await seedAdminAndLogin(app));
    await curateCategories(app);
    db = app.get<Kysely<Database>>(KYSELY);
    paths = app.get(ContentPathResolver);
    mirror = app.get<RoutingRevisionMirror>(REVISION_MIRROR);
  });
  afterEach(async () => app.close());

  it('leaves the bytes untouched (guard hit), commits them, and marks the outbox row processed', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Committed', body: 'once', status: 'published', frontmatter: conformant({ topic: 'Ops' }) })
      .expect(201);
    const id = created.body.item.id as string;
    const target = await paths.resolve(created.body.item.space_id);
    const abs = join(target.repoDir, 'ops/concepts/committed.md');
    const before = digestOf(readFileSync(abs, 'utf8'));

    // Row pending until the commit lands.
    const pendingRows = await outboxRows(db, id);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]!.processed_at).toBeNull();

    // A restart would replay it from the current page state.
    expect(await app.get(OutboxReplayService).replay()).toEqual({ replayed: 1 });

    await mirror.flush();

    expect(digestOf(readFileSync(abs, 'utf8'))).toBe(before);
    const row = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.file_digest).toBe(before);
    const commits = execFileSync('git', ['-C', target.repoDir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(commits).toBe('1');
    const committed = execFileSync('git', ['-C', target.repoDir, 'show', 'HEAD:ops/concepts/committed.md'], { encoding: 'utf8' });
    expect(digestOf(committed)).toBe(before);

    const rows = await outboxRows(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed_at).not.toBeNull();
    const state = await db.selectFrom('revision_mirror_state').selectAll().where('page_id', '=', id).executeTakeFirst();
    expect(state).toMatchObject({ dirty: 0, last_synced_version_token: 1 });

    // Second edit: same story, second commit.
    await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', '1')
      .send({ body: 'twice' })
      .expect(200);
    const afterEdit = digestOf(readFileSync(abs, 'utf8'));
    await mirror.flush();
    expect(digestOf(readFileSync(abs, 'utf8'))).toBe(afterEdit);
    expect(execFileSync('git', ['-C', target.repoDir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('2');
    expect((await outboxRows(db, id)).every((r) => r.processed_at !== null)).toBe(true);
  });
});
