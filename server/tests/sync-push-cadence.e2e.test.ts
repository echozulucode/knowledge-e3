/**
 * Push cadence (plan §12 decision 1): for a source the sync engine manages,
 * the debounced committer keeps commits local (`pushOnCommit: false`); a
 * publish asks the engine to push, a manual/forced cycle pushes, and drafts
 * wait for the timer. A `read-only` source never pushes and refuses writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { PagesService } from '../src/pages/pages.service.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import type { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function originHead(bare: string): string | null {
  try {
    return git(bare, 'rev-parse', '--verify', '-q', 'refs/heads/main') || null;
  } catch {
    return null;
  }
}

function originFile(bare: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', bare, 'show', `main:${path}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

describe('sync: push cadence e2e', () => {
  let app: INestApplication;
  let sync: SyncService;
  let mirror: RoutingRevisionMirror;
  let registry: SourceRegistryService;
  let spaces: SpacesService;
  let cookie: string;
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-sync-push-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    sync = app.get(SyncService);
    mirror = app.get<RoutingRevisionMirror>(REVISION_MIRROR);
    registry = app.get(SourceRegistryService);
    spaces = app.get(SpacesService);
    await spaces.createCategory({ name: 'Guides' });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drafts stay local; publish pushes; a forced cycle pushes', async () => {
    await spaces.create({ name: 'Ops' });
    const bare = join(tmp, 'origin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    await registry.upsert('topic:ops', { remote_url: bare, branch: 'main', mode: 'direct' });
    expect((await sync.runNow('topic:ops')).state).toBe('idle');
    expect(sync.isManaged('topic:ops')).toBe(true);

    // A draft: written, committed by the adapter on flush — but NOT pushed.
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Checklist', body: 'draft one\n', status: 'draft', frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'], description: 'Ops checklist.' } })
      .expect(201);
    const page = created.body.page;
    await mirror.flush();
    const local = join(root, 'topics', 'ops');
    expect(git(local, 'log', '--oneline')).toContain('knowledge-e3: mirror 1 item');
    expect(originHead(bare)).toBeNull();

    // Publish → the write path asks the engine to push (in the background).
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${page.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(page.version_token))
      .send({ status: 'published' })
      .expect(200);
    await sync.settle('topic:ops');
    const pushed = originHead(bare);
    expect(pushed).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(originFile(bare, 'concepts/checklist.md')).toContain('status: published');

    // Another draft edit: committed locally, origin unchanged…
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${page.id}`)
      .set('Cookie', cookie)
      .set('If-Match', '2')
      .send({ body: 'draft two\n', status: 'draft' })
      .expect(200);
    await mirror.flush();
    expect(git(local, 'rev-parse', 'HEAD')).not.toBe(pushed);
    expect(originHead(bare)).toBe(pushed);
    // …until a forced cycle (or the 5-minute timer) pushes it.
    const forced = await sync.runNow('topic:ops', { force: true });
    expect(forced).toMatchObject({ state: 'idle', ahead: 0 });
    expect(originHead(bare)).toBe(git(local, 'rev-parse', 'HEAD'));
    expect(originFile(bare, 'concepts/checklist.md')).toContain('draft two');

    // The admin "push now" route is the manual reason.
    const manual = await request(app.getHttpServer()).post('/api/v1/admin/sources/topic:ops/push').set('Cookie', cookie).expect(200);
    expect(manual.body.status).toMatchObject({ state: 'idle', ahead: 0 });
  });

  it('a read-only source never pushes and refuses writes with 403 source_read_only', async () => {
    const vendor = await spaces.create({ name: 'Vendor Docs' });
    const bare = join(tmp, 'vendor.git');
    const clone = join(tmp, 'vendor-clone');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['clone', '-q', bare, clone]);
    git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(clone, 'config', 'user.email', 'upstream@example.com');
    git(clone, 'config', 'user.name', 'Upstream');
    mkdirSync(join(clone, 'concepts'), { recursive: true });
    writeFileSync(join(clone, 'concepts', 'sdk-setup.md'), '---\ntype: Concept\ntitle: SDK Setup\nstatus: published\ncategories: [guides]\ndescription: Install.\n---\n\nSteps.\n', 'utf8');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'seed');
    git(clone, 'push', '-q', 'origin', 'main');
    const upstream = originHead(bare);

    await registry.upsert('topic:vendor-docs', { remote_url: bare, branch: 'main', role: 'reference', mode: 'read-only' });
    expect((await sync.runNow('topic:vendor-docs')).state).toBe('idle');
    const sdk = (await app.get(PagesService).getBySlug('sdk-setup'))!;
    expect(sdk).toMatchObject({ title: 'SDK Setup', space_id: vendor.id });

    const create = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'My Notes', body: 'x', frontmatter: { topic: 'Vendor Docs' } })
      .expect(403);
    expect(create.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:vendor-docs' });
    const update = await request(app.getHttpServer())
      .put(`/api/v1/pages/${sdk.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(sdk.version_token))
      .send({ body: 'edited here' })
      .expect(403);
    expect(update.body).toMatchObject({ reason: 'source_read_only', source_id: 'topic:vendor-docs' });
    expect(await app.get(PagesService).getBySlug('my-notes')).toBeNull();

    // Even a forced cycle or an explicit push request leaves origin untouched.
    expect((await sync.runNow('topic:vendor-docs', { force: true })).state).toBe('idle');
    expect((await sync.requestPush('topic:vendor-docs', 'manual')).state).toBe('idle');
    expect(originHead(bare)).toBe(upstream);
    expect(git(join(root, 'topics', 'vendor-docs'), 'status', '--porcelain')).toBe('');
  });
});
