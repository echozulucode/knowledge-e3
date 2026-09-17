/**
 * Conflict queue (plan §8.1): the same file edited here (through /pages,
 * committed by the debounced committer) and upstream puts the source into
 * `conflict`, parks both sides in the queue, and resolving "theirs" re-indexes
 * the upstream content and returns the source to idle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { PagesService } from '../src/pages/pages.service.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import type { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { ConflictQueueService } from '../src/sync/conflict-queue.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

describe('sync: conflict queue e2e', () => {
  let app: INestApplication;
  let pages: PagesService;
  let sync: SyncService;
  let mirror: RoutingRevisionMirror;
  let cookie: string;
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-sync-conflict-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    pages = app.get(PagesService);
    sync = app.get(SyncService);
    mirror = app.get<RoutingRevisionMirror>(REVISION_MIRROR);
    const spaces = app.get(SpacesService);
    await spaces.createCategory({ name: 'Guides' });
    await spaces.create({ name: 'Ops' });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(tmp, { recursive: true, force: true });
  });

  it('enters conflict on a two-sided edit, queues both sides, and "theirs" re-indexes and clears', async () => {
    const bare = join(tmp, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    await app.get(SourceRegistryService).upsert('topic:ops', { remote_url: bare, branch: 'main', mode: 'direct' });
    expect((await sync.runNow('topic:ops')).state).toBe('idle');

    // v1 through the UI door; pushed by the engine so upstream can see it.
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Runbook', body: 'Line one.\n', status: 'published', frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'], description: 'Ops runbook.' } })
      .expect(201);
    const page = created.body.page;
    await sync.requestPush('topic:ops', 'manual');
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toContain('concepts/runbook.md');

    // Upstream edits the same line…
    const clone = join(tmp, 'clone');
    execFileSync('git', ['clone', '-q', bare, clone]);
    git(clone, 'config', 'user.email', 'upstream@example.com');
    git(clone, 'config', 'user.name', 'Upstream');
    const file = join(clone, 'concepts', 'runbook.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Line one.', 'Upstream edit.'), 'utf8');
    git(clone, 'commit', '-q', '-am', 'upstream edit');
    git(clone, 'push', '-q', 'origin', 'main');

    // …while we edit it here (committed locally by the adapter, not pushed).
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${page.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(page.version_token))
      .send({ body: 'Local edit.\n' })
      .expect(200);
    await mirror.flush();

    const status = await sync.runNow('topic:ops');
    expect(status.state).toBe('conflict');
    expect(status.conflicted_paths).toEqual(['concepts/runbook.md']);

    const queue = await request(app.getHttpServer()).get('/api/v1/admin/sources/topic:ops/conflicts').set('Cookie', cookie).expect(200);
    expect(queue.body.conflicts).toHaveLength(1);
    const conflict = queue.body.conflicts[0];
    expect(conflict).toMatchObject({ source_id: 'topic:ops', path: 'concepts/runbook.md', page_id: page.id, resolved_at: null });
    expect(conflict.ours).toContain('Local edit.');
    expect(conflict.theirs).toContain('Upstream edit.');
    expect(conflict.base).toContain('Line one.');

    const health = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);
    expect(health.body.sync).toEqual({ conflicts: 1, sources_in_conflict: ['topic:ops'] });
    // While in conflict a cycle is a no-op that reports the conflict.
    expect((await sync.runNow('topic:ops')).state).toBe('conflict');
    const listed = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
    expect(listed.body.sources[0].status.state).toBe('conflict');

    // Keep theirs: the upstream text wins, the item is re-indexed, the source is idle again.
    const resolved = await request(app.getHttpServer())
      .post(`/api/v1/admin/sources/conflicts/${conflict.id}/resolve`)
      .set('Cookie', cookie)
      .send({ choice: 'theirs' })
      .expect(200);
    expect(resolved.body.status.state).toBe('idle');
    expect(resolved.body.conflict).toMatchObject({ resolution: 'theirs' });
    expect(resolved.body.conflict.resolved_at).toBeTruthy();

    const after = (await pages.getById(page.id))!;
    expect(after.body_markdown).toContain('Upstream edit.');
    expect(after.body_markdown).not.toContain('Local edit.');
    expect(after.version_token).toBeGreaterThan(page.version_token + 1);
    expect(readFileSync(join(root, 'topics', 'ops', 'concepts', 'runbook.md'), 'utf8')).toContain('Upstream edit.');

    const clean = await sync.runNow('topic:ops');
    expect(clean).toMatchObject({ state: 'idle', behind: 0, conflicted_paths: [] });
    expect((await request(app.getHttpServer()).get('/api/v1/admin/sources/topic:ops/conflicts').set('Cookie', cookie).expect(200)).body.conflicts).toEqual([]);

    // …and the resolution survives: `includeResolved` replays it from the table,
    // so the Sources panel's history is not a session-local memory of the mutation.
    const history = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=true')
      .set('Cookie', cookie)
      .expect(200);
    expect(history.body.conflicts).toHaveLength(1);
    expect(history.body.conflicts[0]).toMatchObject({
      id: conflict.id,
      path: 'concepts/runbook.md',
      resolution: 'theirs',
      resolved_by_username: 'admin',
    });
    expect(history.body.conflicts[0].resolved_at).toBeTruthy();
    expect(history.body.resolved_limit).toBe(20);
  });

  it('lists the resolved history newest first, bounded, and only when asked for', async () => {
    await app.get(SourceRegistryService).upsert('topic:ops', { mode: 'direct' });
    const queue = app.get(ConflictQueueService);
    const db = app.get<Kysely<Database>>(KYSELY);
    const admin = await db.selectFrom('users').select('id').where('username', '=', 'admin').executeTakeFirstOrThrow();

    // Three resolutions, oldest → newest, plus one still-open conflict.
    const resolvedIds: string[] = [];
    for (const [i, choice] of (['ours', 'theirs', 'manual'] as const).entries()) {
      const id = `conflict-resolved-${i}`;
      resolvedIds.push(id);
      await db
        .insertInto('sync_conflicts')
        .values({
          id,
          source_id: 'topic:ops',
          path: `concepts/old-${i}.md`,
          page_id: null,
          ours: 'mine',
          theirs: 'theirs',
          base: 'base',
          detected_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          resolved_at: `2026-02-0${i + 1}T00:00:00.000Z`,
          resolution: choice,
          resolved_by: admin.id,
        })
        .execute();
    }
    await db
      .insertInto('sync_conflicts')
      .values({
        id: 'conflict-open',
        source_id: 'topic:ops',
        path: 'concepts/still-open.md',
        page_id: null,
        ours: 'mine',
        theirs: 'theirs',
        base: 'base',
        detected_at: '2026-03-01T00:00:00.000Z',
        resolved_at: null,
        resolution: null,
        resolved_by: null,
      })
      .execute();

    // Default: open only — existing callers see no change.
    const byDefault = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts')
      .set('Cookie', cookie)
      .expect(200);
    expect(byDefault.body.conflicts.map((c: { id: string }) => c.id)).toEqual(['conflict-open']);
    expect(byDefault.body.resolved_limit).toBeUndefined();
    // `includeResolved=false` is still the default behaviour.
    const explicitlyOff = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=false')
      .set('Cookie', cookie)
      .expect(200);
    expect(explicitlyOff.body.conflicts.map((c: { id: string }) => c.id)).toEqual(['conflict-open']);

    // Asked for: the open one first, then the resolved history newest first.
    const withHistory = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=true')
      .set('Cookie', cookie)
      .expect(200);
    expect(withHistory.body.conflicts.map((c: { id: string }) => c.id)).toEqual([
      'conflict-open',
      ...[...resolvedIds].reverse(),
    ]);
    expect(withHistory.body.conflicts[1]).toMatchObject({
      resolution: 'manual',
      resolved_by: admin.id,
      resolved_by_username: 'admin',
      resolved_at: '2026-02-03T00:00:00.000Z',
    });

    // Bounded: the caller's limit wins, and the ceiling caps a greedy one.
    const bounded = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=1&resolvedLimit=2')
      .set('Cookie', cookie)
      .expect(200);
    expect(bounded.body.resolved_limit).toBe(2);
    expect(bounded.body.conflicts.map((c: { id: string }) => c.id)).toEqual([
      'conflict-open',
      'conflict-resolved-2',
      'conflict-resolved-1',
    ]);
    const capped = await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=1&resolvedLimit=5000')
      .set('Cookie', cookie)
      .expect(200);
    expect(capped.body.resolved_limit).toBe(100);
    await request(app.getHttpServer())
      .get('/api/v1/admin/sources/topic:ops/conflicts?includeResolved=1&resolvedLimit=0')
      .set('Cookie', cookie)
      .expect(400);

    // The service is bounded in its own right, and another source sees none of this.
    expect((await queue.listResolved('topic:ops', 1)).map((r) => r.id)).toEqual(['conflict-resolved-2']);
    expect(await queue.listResolved('topic:other')).toEqual([]);
  });
});
