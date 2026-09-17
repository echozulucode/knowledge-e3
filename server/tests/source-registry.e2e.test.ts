/**
 * Source registry (plan §7.4): the `content_sources` table, its one-time copy
 * of the legacy `space_repos` / `git.main_remote` configuration, the
 * `RepoConfigService` facade the Admin → Repos routes keep using, the path
 * resolver reading the registry, and boot-time reconciliation of `sources:`
 * from the config file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY, makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { loadServerConfig, resetServerConfig } from '../src/config/server-config.js';
import { PagesService } from '../src/pages/pages.service.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { normalizeLocalDir, normalizeRemoteUrl, SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

describe('source registry migration', () => {
  it('copies space_repos rows and the main remote once, then leaves the registry alone', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    await migrateSqlite(db);
    const now = new Date().toISOString();
    await db
      .insertInto('spaces')
      .values({ id: 'space_matlab', slug: 'matlab', name: 'MATLAB', description: null, created_at: now, updated_at: now, archived_at: null })
      .execute();
    await db
      .insertInto('space_repos')
      .values({ space_id: 'space_matlab', remote_url: 'git@host:org/matlab.git', branch: 'main', enabled: 1, default_status: 'published', created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('app_config')
      .values({ key: 'git.main_remote', value_json: JSON.stringify({ remote_url: 'git@host:org/knowledge.git', branch: null, enabled: true }), updated_at: now, updated_by: null })
      .execute();
    // The legacy rows were written after this DB's first migration: pretend the copy never ran.
    await db.deleteFrom('app_config').where('key', '=', 'migrations.content_sources_copied').execute();

    await migrateSqlite(db);
    const topic = await db.selectFrom('content_sources').selectAll().where('id', '=', 'topic:matlab').executeTakeFirstOrThrow();
    expect(topic).toMatchObject({
      space_id: 'space_matlab',
      local_dir: 'topics/matlab',
      remote_url: 'git@host:org/matlab.git',
      branch: 'main',
      role: 'authoritative',
      mode: 'direct',
      branch_prefix: 'e3/',
      enabled: 1,
      default_status: 'published',
    });
    const main = await db.selectFrom('content_sources').selectAll().where('id', '=', 'main').executeTakeFirstOrThrow();
    expect(main).toMatchObject({ space_id: null, local_dir: 'main', remote_url: 'git@host:org/knowledge.git', mode: 'direct', enabled: 1 });

    // Idempotent: a binding the admin removes does not come back on the next boot.
    await db.deleteFrom('content_sources').where('id', '=', 'topic:matlab').execute();
    await migrateSqlite(db);
    expect(await db.selectFrom('content_sources').select('id').execute()).toEqual([{ id: 'main' }]);
    await db.destroy();
  });
});

describe('source registry e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let registry: SourceRegistryService;
  let repos: RepoConfigService;
  let spaces: SpacesService;
  let cookie: string;
  let adminId: string;
  let tmp: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    registry = app.get(SourceRegistryService);
    repos = app.get(RepoConfigService);
    spaces = app.get(SpacesService);
    tmp = mkdtempSync(join(tmpdir(), 'e3-registry-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('RepoConfigService is a facade: bindings and the main remote round-trip through content_sources', async () => {
    const topic = await spaces.create({ name: 'Physics' });
    await repos.upsert(topic.id, { remote_url: 'git@host:org/physics.git', branch: 'main', default_status: 'published' }, adminId);

    const row = await registry.get('topic:physics');
    expect(row).toMatchObject({ space_id: topic.id, remote_url: 'git@host:org/physics.git', branch: 'main', role: 'authoritative', mode: 'direct', default_status: 'published', enabled: 1 });
    expect(await registry.forSpace(topic.id)).toMatchObject({ id: 'topic:physics' });
    expect(await repos.list()).toEqual([
      expect.objectContaining({ space_id: topic.id, space_slug: 'physics', remote_url: 'git@host:org/physics.git', branch: 'main', enabled: true, default_status: 'published' }),
    ]);
    // The legacy table is no longer written.
    expect(await db.selectFrom('space_repos').selectAll().execute()).toEqual([]);

    // A re-upsert through the facade keeps registry-only fields an admin set.
    await registry.upsert('topic:physics', { mode: 'review', host_kind: 'github', host_token_env: 'E3_GITHUB_TOKEN' });
    await repos.upsert(topic.id, { remote_url: 'git@host:org/physics2.git', enabled: false }, adminId);
    expect(await registry.get('topic:physics')).toMatchObject({ remote_url: 'git@host:org/physics2.git', enabled: 0, mode: 'review', host_kind: 'github', host_token_env: 'E3_GITHUB_TOKEN' });

    expect(await repos.getMainRemote()).toBeNull();
    await repos.setMainRemote({ remote_url: 'git@host:org/knowledge.git', branch: 'trunk' });
    expect(await repos.getMainRemote()).toEqual({ remote_url: 'git@host:org/knowledge.git', branch: 'trunk', enabled: true });
    expect(await registry.get('main')).toMatchObject({ local_dir: 'main', remote_url: 'git@host:org/knowledge.git', branch: 'trunk' });
    expect(await db.selectFrom('app_config').select('key').where('key', '=', 'git.main_remote').execute()).toEqual([]);

    // The existing admin routes keep working over the facade.
    const listed = await request(app.getHttpServer()).get('/api/v1/admin/repos').set('Cookie', cookie).expect(200);
    expect(listed.body.main).toEqual({ remote_url: 'git@host:org/knowledge.git', branch: 'trunk', enabled: true });
    expect(listed.body.repos).toHaveLength(1);

    await repos.remove(topic.id);
    expect(await registry.get('topic:physics')).toBeNull();
  });

  it('ContentPathResolver places files from the registry (dedicated dir, mode, main remote)', async () => {
    const paths = app.get(ContentPathResolver);
    const topic = await spaces.create({ name: 'Vendor Docs' });
    const before = await paths.resolve(topic.id);
    expect(before).toMatchObject({ sourceId: 'main', dedicated: false, conceptDir: 'vendor-docs/concepts', remoteUrl: null, mode: 'direct' });

    const custom = join(tmp, 'vendor');
    await registry.upsert('topic:vendor-docs', { remote_url: 'https://example.com/vendor.git', branch: 'main', local_dir: custom, role: 'reference', mode: 'read-only' });
    const dedicated = await paths.resolve(topic.id);
    expect(dedicated).toEqual({
      sourceId: 'topic:vendor-docs',
      repoDir: resolve(custom),
      conceptDir: 'concepts',
      remoteUrl: 'https://example.com/vendor.git',
      branch: 'main',
      dedicated: true,
      mode: 'read-only',
    });
    // Disabled binding: still dedicated, but nothing is pushed.
    await registry.upsert('topic:vendor-docs', { enabled: false });
    expect(await paths.resolve(topic.id)).toMatchObject({ sourceId: 'topic:vendor-docs', remoteUrl: null });

    // The default `topics/<slug>` dir lives under the content root.
    const other = await spaces.create({ name: 'Ops' });
    await registry.upsert('topic:ops', { remote_url: 'git@host:org/ops.git' });
    expect((await paths.resolve(other.id)).repoDir).toBe(join(paths.root, 'topics', 'ops'));

    await registry.upsert('main', { remote_url: 'git@host:org/knowledge.git', branch: 'main' });
    expect(await paths.resolve(null)).toMatchObject({ sourceId: 'main', repoDir: paths.mainDir, remoteUrl: 'git@host:org/knowledge.git', branch: 'main' });
  });

  it('PUT/GET/DELETE /admin/sources validate and expose the registry with a status', async () => {
    const bad = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:ops')
      .set('Cookie', cookie)
      .send({ remote_url: 'git@host:org/ops.git', mode: 'sideways' })
      .expect(400);
    expect(bad.body.message).toEqual(expect.arrayContaining([expect.stringContaining('mode')]));

    const put = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:ops')
      .set('Cookie', cookie)
      .send({ remote_url: 'git@host:org/ops.git', branch: 'main', role: 'reference', mode: 'read-only', host_kind: 'github', host_token_env: 'E3_TOKEN', sync_every_seconds: 60 })
      .expect(200);
    expect(put.body.source).toMatchObject({ id: 'topic:ops', local_dir: 'topics/ops', role: 'reference', mode: 'read-only', host_kind: 'github', sync_every_seconds: 60, managed: false });
    expect(put.body.source.status).toMatchObject({ source: 'topic:ops', state: 'idle' });

    const list = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
    expect(list.body.sources.map((s: { id: string }) => s.id)).toEqual(['topic:ops']);

    await request(app.getHttpServer()).delete('/api/v1/admin/sources/topic:ops').set('Cookie', cookie).expect(200);
    expect(await registry.list()).toEqual([]);
  });

  /**
   * B3 / D4a: the row says whether the env var it NAMES is set on this server —
   * runbook §3.3's whole diagnosis — and the value never crosses the wire.
   */
  it('reports host-token and webhook-secret PRESENCE as booleans, and never the value', async () => {
    const secret = 'ghp_this_value_must_never_leave_the_process';
    process.env['E3_TEST_HOST_TOKEN'] = secret;
    process.env['E3_TEST_BLANK_SECRET'] = '   ';
    try {
      await request(app.getHttpServer())
        .put('/api/v1/admin/sources/topic:hosted')
        .set('Cookie', cookie)
        .send({
          remote_url: 'git@host:org/hosted.git',
          mode: 'review',
          host_kind: 'github',
          host_token_env: 'E3_TEST_HOST_TOKEN',
          webhook_secret_env: 'E3_TEST_BLANK_SECRET',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/admin/sources/topic:unhosted')
        .set('Cookie', cookie)
        .send({ remote_url: 'git@host:org/unhosted.git', host_token_env: 'E3_TEST_UNSET_TOKEN' })
        .expect(200);

      const list = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
      const byId = Object.fromEntries(
        (list.body.sources as { id: string }[]).map((s) => [s.id, s as Record<string, unknown>]),
      );
      expect(byId['topic:hosted']).toMatchObject({
        host_token_env: 'E3_TEST_HOST_TOKEN',
        host_token_present: true,
        // Whitespace is not a token: `hostFor` treats it as missing, so the row must too.
        webhook_secret_env: 'E3_TEST_BLANK_SECRET',
        webhook_secret_present: false,
      });
      expect(byId['topic:unhosted']).toMatchObject({ host_token_present: false, webhook_secret_present: false });

      // The one assertion that matters: presence is a boolean, so no part of the
      // value — not a prefix, not a length — can be reconstructed from the body.
      //
      // Checked value by value, not as a substring of the whole JSON: the old
      // `not.toContain(String(secret.length))` failed whenever a timestamp or
      // id happened to contain "43" (a flake, 2026-09-13), which proved nothing
      // about the secret either way.
      const wire = JSON.stringify(list.body);
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain(secret.slice(0, 4));
      const leaks: string[] = [];
      const walk = (value: unknown, path: string): void => {
        if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            if (/(token|secret).*(len|length|prefix|preview|hint|mask)/i.test(k)) leaks.push(`${path}.${k}`);
            walk(v, `${path}.${k}`);
          }
          return;
        }
        // A length would surface as a bare number or numeric string on the row.
        if (value === secret.length || value === String(secret.length)) leaks.push(path);
      };
      for (const id of ['topic:hosted', 'topic:unhosted']) walk(byId[id], id);
      expect(leaks).toEqual([]);
    } finally {
      delete process.env['E3_TEST_HOST_TOKEN'];
      delete process.env['E3_TEST_BLANK_SECRET'];
      await registry.remove('topic:hosted').catch(() => {});
      await registry.remove('topic:unhosted').catch(() => {});
    }
  });

  /**
   * Plan A1: the Details panel reads the selection straight off the row, plus
   * the two facts that cost I/O — the item count (one grouped query) and the
   * working tree's HEAD (one bounded `git log -1`). A source whose tree is not
   * a repository still lists, with a null HEAD, rather than failing the page.
   */
  it('lists each source with its indexed item count and the HEAD its working tree is on', async () => {
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const tree = join(tmp, 'handbook');
    mkdirSync(tree, { recursive: true });
    execFileSync('git', ['init', '-q', '--initial-branch=main', tree]);
    git(tree, 'config', 'user.email', 'upstream@example.com');
    git(tree, 'config', 'user.name', 'Upstream');
    writeFileSync(join(tree, 'README.md'), '# Handbook\n', 'utf8');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-q', '-m', 'seed');
    const sha = git(tree, 'rev-parse', 'HEAD');

    // A plain directory: `git -C` would walk up from here, which is exactly what must not be reported.
    const notARepo = join(tmp, 'plain');
    mkdirSync(notARepo, { recursive: true });

    await registry.upsert('topic:handbook', {
      local_dir: tree,
      include_globs: ['docs/**/*.md'],
      exclude_globs: ['docs/archive/**'],
      default_type: 'how-to',
      default_status: 'draft',
    });
    await registry.upsert('topic:plain', { local_dir: notARepo });

    // Two live items and one soft-deleted one indexed from the handbook.
    const pages = app.get(PagesService);
    const ids: string[] = [];
    for (const title of ['Onboarding', 'Expenses', 'Retired']) {
      ids.push((await pages.create(adminId, { title, body: 'x', status: 'draft', frontmatter: { type: 'Concept' } })).id);
    }
    await db.updateTable('pages').set({ source_id: 'topic:handbook' }).where('id', 'in', ids).execute();
    await db.updateTable('pages').set({ deleted_at: new Date().toISOString() }).where('id', '=', ids[2]!).execute();

    const list = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
    const byId = Object.fromEntries((list.body.sources as { id: string }[]).map((s) => [s.id, s as Record<string, any>]));

    expect(byId['topic:handbook']).toMatchObject({
      include_globs: '["docs/**/*.md"]',
      exclude_globs: '["docs/archive/**"]',
      default_type: 'How-To',
      default_status: 'draft',
      item_count: 2,
      head: { sha },
    });
    expect(Date.parse(byId['topic:handbook']!.head.committed_at)).not.toBeNaN();
    expect(byId['topic:plain']).toMatchObject({ item_count: 0, head: null });

    // The upsert response carries the same two fields, so a saved row is never blanker than the list.
    const put = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:handbook')
      .set('Cookie', cookie)
      .send({ default_status: 'published' })
      .expect(200);
    expect(put.body.source).toMatchObject({ item_count: 2, head: { sha } });
  });

  it('rejects a glob that is absolute or climbs out of the repository with a 400 that says why', async () => {
    const server = app.getHttpServer();
    for (const glob of ['/etc/*.md', 'C:/docs/*.md', 'docs/../../secrets/*.md', '..\\secrets\\*.md', '\\\\share\\docs\\*.md']) {
      const res = await request(server)
        .put('/api/v1/admin/sources/topic:globs')
        .set('Cookie', cookie)
        .send({ local_dir: join(tmp, 'globs'), include_globs: ['docs/**/*.md', glob] })
        .expect(400);
      expect(res.body.message).toMatch(/repository-relative glob/);
    }
    const exclude = await request(server)
      .put('/api/v1/admin/sources/topic:globs')
      .set('Cookie', cookie)
      .send({ local_dir: join(tmp, 'globs'), exclude_globs: ['../outside/**'] })
      .expect(400);
    expect(exclude.body.message).toMatch(/^exclude_globs:/);
    expect(await registry.get('topic:globs')).toBeNull();

    // Blank lines are dropped, `./` is normalised, and a legal list round-trips.
    const ok = await request(server)
      .put('/api/v1/admin/sources/topic:globs')
      .set('Cookie', cookie)
      .send({ local_dir: join(tmp, 'globs'), include_globs: ['./docs/**/*.md', '  '], exclude_globs: [] })
      .expect(200);
    expect(ok.body.source).toMatchObject({ include_globs: '["docs/**/*.md"]', exclude_globs: null });

    // An unknown default type is configuration, and a typo there would mistype every import.
    const typo = await request(server)
      .put('/api/v1/admin/sources/topic:globs')
      .set('Cookie', cookie)
      .send({ default_type: 'Hwo-to' })
      .expect(400);
    expect(typo.body.message).toMatch(/unknown content type/);
  });

  /**
   * Plan §8.3, last row: two E3 instances on one repository are supported only as
   * different branches, or one writer plus one `reference`/`read-only` reader.
   * Same-branch dual writers are rejected by the registry.
   */
  it('rejects mode "review" without somewhere to push and a host to open the change request on', async () => {
    // A `review` source with no remote is the incoherent config: `ContentCommands`
    // would find no review source and write to the working tree exactly like
    // `direct`, so the source would look like it enforces PRs while not doing so —
    // and the issue-80 guard (which keys on the mode) would disagree with the
    // staging path (which needs the remote) about what a review source even is.
    await expect(registry.upsert('topic:noremote', { mode: 'review', host_kind: 'github' })).rejects.toThrow(
      /cannot use mode "review" without a remote_url/,
    );
    expect(await registry.get('topic:noremote')).toBeNull();

    // A remote but no host: nothing to open the pull request on. Caught at
    // registration rather than as a 500 from `createHost` on the author's save.
    await expect(
      registry.upsert('topic:nohost', { mode: 'review', remote_url: 'git@host:org/nohost.git', branch: 'main' }),
    ).rejects.toThrow(/cannot use mode "review" without a host_kind/);
    expect(await registry.get('topic:nohost')).toBeNull();

    // Fully configured: accepted.
    const ok = await registry.upsert('topic:reviewed', {
      mode: 'review',
      remote_url: 'git@host:org/reviewed.git',
      branch: 'main',
      host_kind: 'github',
      host_token_env: 'E3_SOME_TOKEN',
    });
    expect(ok).toMatchObject({ mode: 'review', host_kind: 'github' });

    // The merged row is what is validated, so flipping an existing local-only
    // source to `review` with a patch that carries no remote is refused too.
    await registry.upsert('topic:local', { mode: 'direct' });
    await expect(registry.upsert('topic:local', { mode: 'review' })).rejects.toThrow(/without a remote_url/);
    expect((await registry.get('topic:local'))?.mode).toBe('direct');

    // And it surfaces as a 400 on the admin route, not a 500.
    const res = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:local')
      .set('Cookie', cookie)
      .send({ mode: 'review' })
      .expect(400);
    expect(String(res.body.message)).toContain('without a remote_url');
  });

  it('rejects a second enabled writable source on the same remote + branch', async () => {
    await registry.upsert('main', { remote_url: 'git@host:org/knowledge.git', branch: 'main' });

    // Same remote, same branch, both writable → refused, and nothing is written.
    await expect(registry.upsert('topic:dup', { remote_url: 'git@host:org/knowledge.git', branch: 'main' })).rejects.toThrow(
      /same-branch dual writers/,
    );
    expect(await registry.get('topic:dup')).toBeNull();
    // `review` is a writer too (it pushes item branches to the same base).
    await expect(
      registry.upsert('topic:dup', { remote_url: 'git@host:org/knowledge.git', branch: 'main', mode: 'review', host_kind: 'github' }),
    ).rejects.toThrow(/same-branch dual writers/);
    // The comparison is on the NORMALIZED url: host case, trailing `.git` and
    // trailing slash, and the scp-vs-ssh spelling of one SSH remote.
    await expect(registry.upsert('topic:dup', { remote_url: 'git@HOST:org/knowledge.git/', branch: 'main' })).rejects.toThrow(
      /same-branch dual writers/,
    );
    await expect(registry.upsert('topic:dup', { remote_url: 'ssh://git@host/org/knowledge', branch: 'main' })).rejects.toThrow(
      /same-branch dual writers/,
    );
    // It surfaces as a 400 on the admin route, not a 500.
    const res = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:dup')
      .set('Cookie', cookie)
      .send({ remote_url: 'git@host:org/knowledge.git', branch: 'main' })
      .expect(400);
    expect(String(res.body.message)).toContain('dual writers');

    // The three SUPPORTED shapes of two instances on one repository:
    expect(await registry.upsert('topic:staging', { remote_url: 'git@host:org/knowledge.git', branch: 'staging' })).toMatchObject({
      branch: 'staging',
    });
    expect(
      await registry.upsert('topic:mirror', { remote_url: 'git@host:org/knowledge.git', branch: 'main', role: 'reference', mode: 'read-only' }),
    ).toMatchObject({ mode: 'read-only' });
    expect(await registry.upsert('topic:parked', { remote_url: 'git@host:org/knowledge.git', branch: 'main', enabled: false })).toMatchObject({
      enabled: 0,
    });

    // A disabled row is validated when it is re-enabled — the merged row, not the patch.
    await expect(registry.upsert('topic:parked', { enabled: true })).rejects.toThrow(/same-branch dual writers/);
    expect(await registry.get('topic:parked')).toMatchObject({ enabled: 0 });

    // Updating a row in place never collides with itself.
    expect(await registry.upsert('main', { default_status: 'published' })).toMatchObject({
      remote_url: 'git@host:org/knowledge.git',
      branch: 'main',
      default_status: 'published',
    });

    // A local-only source (no remote) never collides.
    await registry.upsert('topic:local-a', {});
    expect(await registry.upsert('topic:local-b', {})).toMatchObject({ remote_url: null });
  });

  it('rejects two enabled sources on one working tree', async () => {
    const shared = join(tmp, 'shared-tree');
    await registry.upsert('topic:one', { local_dir: shared });

    await expect(registry.upsert('topic:two', { local_dir: shared })).rejects.toThrow(/cannot share one working tree/);
    expect(await registry.get('topic:two')).toBeNull();
    // Path spelling does not get around it.
    await expect(registry.upsert('topic:two', { local_dir: `${shared}/` })).rejects.toThrow(/cannot share one working tree/);

    // Disabled is allowed; re-enabling is not.
    expect(await registry.upsert('topic:two', { local_dir: shared, enabled: false })).toMatchObject({ enabled: 0 });
    await expect(registry.upsert('topic:two', { enabled: true })).rejects.toThrow(/cannot share one working tree/);

    // Updating the owner of the tree in place is fine.
    expect(await registry.upsert('topic:one', { local_dir: shared, branch: 'main' })).toMatchObject({ branch: 'main' });
  });

  it('POST /sync/webhook/:sourceId is public but needs the secret named by webhook_secret_env', async () => {
    await spaces.create({ name: 'Ops' });
    await registry.upsert('topic:ops', { remote_url: join(tmp, 'nowhere.git'), webhook_secret_env: 'E3_TEST_WEBHOOK_SECRET' });
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const server = app.getHttpServer();
    try {
      // No secret on the server → refused.
      await request(server).post('/api/v1/sync/webhook/topic:ops').set('Content-Type', 'application/json').send(body).expect(403);
      process.env['E3_TEST_WEBHOOK_SECRET'] = 's3cret';
      await request(server).post('/api/v1/sync/webhook/topic:ops').set('X-Webhook-Secret', 'wrong').send(body).expect(403);
      await request(server).post('/api/v1/sync/webhook/topic:ops').set('X-Hub-Signature-256', 'sha256=deadbeef').send(body).expect(403);
      const hmac = createHmac('sha256', 's3cret').update(body).digest('hex');
      const ok = await request(server)
        .post('/api/v1/sync/webhook/topic:ops')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', `sha256=${hmac}`)
        .send(body)
        .expect(202);
      expect(ok.body).toEqual({ accepted: true, source: 'topic:ops' });
      await request(server).post('/api/v1/sync/webhook/topic:ops').set('X-Webhook-Secret', 's3cret').send(body).expect(202);
      await request(server).post('/api/v1/sync/webhook/topic:unknown').set('X-Webhook-Secret', 's3cret').send(body).expect(404);
      await app.get(SyncService).settle();
    } finally {
      delete process.env['E3_TEST_WEBHOOK_SECRET'];
    }
  });
});

describe('source registry: config file reconciliation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e3-sources-cfg-'));
  });

  afterEach(() => {
    delete process.env['KNOWLEDGE_E3_CONFIG'];
    resetServerConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts `sources:` entries at boot; the file wins for its fields, admin edits to the rest persist', async () => {
    const file = join(dir, 'knowledge-e3.config.yaml');
    writeFileSync(
      file,
      [
        'sync: { every: 2m }',
        'sources:',
        '  - id: main',
        '    remote: git@host:org/knowledge.git',
        '    branch: main',
        '  - id: topic:matlab',
        '    local: ./custom/matlab',
        '    remote: git@host:org/matlab.git',
        '    branch: main',
        '    role: reference',
        '    policy: { mode: read-only }',
        '    host: { kind: github, tokenEnv: E3_GITHUB_TOKEN }',
        '    sync: { every: 5m, webhookSecretEnv: E3_MATLAB_WEBHOOK }',
      ].join('\n'),
      'utf8',
    );
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();
    expect(loadServerConfig().sync.every).toBe(120);
    expect(loadServerConfig().sources).toHaveLength(2);

    const app = await makeApp();
    try {
      const registry = app.get(SourceRegistryService);
      expect(await registry.get('main')).toMatchObject({ remote_url: 'git@host:org/knowledge.git', branch: 'main', local_dir: 'main', mode: 'direct' });
      const matlab = await registry.get('topic:matlab');
      expect(matlab).toMatchObject({
        local_dir: './custom/matlab',
        remote_url: 'git@host:org/matlab.git',
        role: 'reference',
        mode: 'read-only',
        host_kind: 'github',
        host_token_env: 'E3_GITHUB_TOKEN',
        sync_every_seconds: 300,
        webhook_secret_env: 'E3_MATLAB_WEBHOOK',
        space_id: null,
      });

      // An admin edit to a field the file does not name survives the next reconciliation.
      await registry.upsert('topic:matlab', { default_status: 'published', enabled: false });
      await registry.reconcileFromConfig(loadServerConfig().sources);
      expect(await registry.get('topic:matlab')).toMatchObject({ default_status: 'published', enabled: 0, remote_url: 'git@host:org/matlab.git' });

      // A topic created later with that slug picks the entry up.
      const topic = await app.get(SpacesService).create({ name: 'MATLAB', slug: 'matlab' });
      expect(await registry.forSpace(topic.id)).toMatchObject({ id: 'topic:matlab', space_id: topic.id });
    } finally {
      await app.close();
    }
  });
});

describe('source registry: url and path normalization', () => {
  it('normalizeRemoteUrl equates the spellings of one remote and keeps different ones apart', () => {
    // One SSH remote, four spellings.
    const canonical = normalizeRemoteUrl('git@host:org/repo.git');
    expect(canonical).toBe(normalizeRemoteUrl('  git@HOST:org/repo  '));
    expect(canonical).toBe(normalizeRemoteUrl('git@host:org/repo.git/'));
    expect(canonical).toBe(normalizeRemoteUrl('ssh://git@host/org/repo'));

    expect(normalizeRemoteUrl('https://Host.Example.com/org/repo.git/')).toBe(normalizeRemoteUrl('HTTPS://host.example.com/org/repo'));
    expect(normalizeRemoteUrl('/srv/repos/thing/')).toBe('/srv/repos/thing');

    // Not equal: different repository, and a case-sensitive path.
    expect(normalizeRemoteUrl('https://host/org/repo')).not.toBe(normalizeRemoteUrl('https://host/org/other'));
    expect(normalizeRemoteUrl('https://host/org/Repo')).not.toBe(normalizeRemoteUrl('https://host/org/repo'));
    // A local-only source.
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl('   ')).toBeNull();
  });

  it('normalizeLocalDir folds separators and trailing slashes', () => {
    expect(normalizeLocalDir('topics/ops/')).toBe('topics/ops');
    expect(normalizeLocalDir(String.raw`topics\ops`)).toBe('topics/ops');
    expect(normalizeLocalDir('  topics/ops  ')).toBe('topics/ops');
    expect(normalizeLocalDir(null)).toBeNull();
    expect(normalizeLocalDir('')).toBeNull();
  });
});
