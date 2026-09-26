/**
 * Per-source git transport credentials, server side (issue 122).
 *
 * `packages/repo-sync/tests/git-credentials.test.ts` proves the plumbing — what
 * git is handed and what it puts on the wire. What this file proves is the
 * wiring around it: that the registry row a source is saved with is the
 * credential its sync actually uses, that a source which is not in `review`
 * mode can carry one, that a failing authenticated fetch records an error an
 * operator can read and nothing else, and that "Test connection" asks the same
 * question the engine does.
 *
 * The remote is a local HTTP listener that demands basic auth and then refuses,
 * so every case runs against a real git transport without a network, a token
 * that exists anywhere, or a byte written outside a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { resolveGitCredential } from '@echozedlabs/repo-sync';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { SourceRegistryService, gitCredentialOf } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';

const A_TOKEN = 'ghp_only_source_a_may_ever_send_this';
const B_TOKEN = 'ghp_only_source_b_may_ever_send_this';
const TOUCHED = ['E3_SOURCE_A_TOKEN', 'E3_SOURCE_B_TOKEN', 'GIT_HTTPS_TOKEN'];

describe('git transport credentials (issue 122)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let registry: SourceRegistryService;
  let sync: SyncService;
  let repos: RepoConfigService;
  let cookie: string;
  let tmp: string;
  let server: Server;
  let seen: { url: string; auth: string | undefined }[];
  let base: string;

  beforeEach(async () => {
    for (const k of TOUCHED) delete process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'e3-git-cred-'));
    process.env['GIT_MIRROR_ROOT'] = join(tmp, 'wiki');
    seen = [];
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      if (!req.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="knowledge-e3"' });
        res.end();
        return;
      }
      res.writeHead(403);
      res.end('no repository here');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    registry = app.get(SourceRegistryService);
    sync = app.get(SyncService);
    repos = app.get(RepoConfigService);
  });

  afterEach(async () => {
    await app.close();
    await new Promise((done) => server.close(done));
    delete process.env['GIT_MIRROR_ROOT'];
    for (const k of TOUCHED) delete process.env[k];
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The `user:password` pair of the last request that carried one. */
  function sentCredential(): string {
    const header = [...seen].reverse().find((r) => r.auth)?.auth ?? '';
    return Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  }

  it('a direct (non-review) source can be saved with a credential variable, and reports presence only', async () => {
    process.env['E3_SOURCE_A_TOKEN'] = A_TOKEN;
    // The Sources form used to drop the host fields for anything but `review`,
    // so a private repository on a `direct` source had nowhere to name its token.
    const put = await request(app.getHttpServer())
      .put('/api/v1/admin/sources/topic:private')
      .set('Cookie', cookie)
      .send({
        remote_url: `${base}/acme/private.git`,
        mode: 'direct',
        host_kind: 'github',
        host_token_env: 'E3_SOURCE_A_TOKEN',
      })
      .expect(200);
    expect(put.body.source).toMatchObject({
      mode: 'direct',
      host_kind: 'github',
      host_token_env: 'E3_SOURCE_A_TOKEN',
      host_token_present: true,
    });
    expect(JSON.stringify(put.body)).not.toContain(A_TOKEN);
    expect(JSON.stringify(put.body)).not.toContain(A_TOKEN.slice(0, 8));
  });

  it('two sources naming different variables each resolve their own token, and neither sees the other’s', async () => {
    process.env['E3_SOURCE_A_TOKEN'] = A_TOKEN;
    process.env['E3_SOURCE_B_TOKEN'] = B_TOKEN;
    await registry.upsert('topic:a', { remote_url: `${base}/acme/a.git`, host_kind: 'github', host_token_env: 'E3_SOURCE_A_TOKEN' });
    await registry.upsert('topic:b', { remote_url: `${base}/acme/b.git`, host_kind: 'github', host_token_env: 'E3_SOURCE_B_TOKEN' });

    const credOf = async (id: string) => resolveGitCredential(gitCredentialOf((await registry.get(id))!));
    const a = (await credOf('topic:a'))!;
    const b = (await credOf('topic:b'))!;
    expect(a.tokenEnvName).toBe('E3_SOURCE_A_TOKEN');
    expect(b.tokenEnvName).toBe('E3_SOURCE_B_TOKEN');
    expect(a.secrets).toEqual([A_TOKEN]);
    expect(b.secrets).toEqual([B_TOKEN]);
    // Nothing that is safe to log, or visible in `ps`, carries either token.
    expect([...a.args, ...b.args, a.tokenEnvName, b.tokenEnvName].join(' ')).not.toContain(A_TOKEN);
  });

  it('the sync engine authenticates as the source, and records a failure without the token in it', async () => {
    process.env['E3_SOURCE_A_TOKEN'] = A_TOKEN;
    process.env['E3_SOURCE_B_TOKEN'] = B_TOKEN;
    await registry.upsert('topic:a', { remote_url: `${base}/acme/a.git`, host_kind: 'github', host_token_env: 'E3_SOURCE_A_TOKEN' });
    await registry.upsert('topic:b', { remote_url: `${base}/acme/b.git`, host_kind: 'github', host_token_env: 'E3_SOURCE_B_TOKEN' });

    // The remote answers 403 after the credential, so the cycle fails — the
    // point is which credential reached it, and what was written down after.
    await sync.runNow('topic:a').catch(() => undefined);
    expect(sentCredential()).toBe(`x-access-token:${A_TOKEN}`);

    seen = [];
    await sync.runNow('topic:b').catch(() => undefined);
    expect(sentCredential()).toBe(`x-access-token:${B_TOKEN}`);
    expect(seen.map((r) => r.auth ?? '').join('\n')).not.toContain(Buffer.from(`x-access-token:${A_TOKEN}`).toString('base64'));

    const rows = await db.selectFrom('content_sources').select(['id', 'last_error']).execute();
    const errors = rows.map((r) => r.last_error ?? '').join('\n');
    expect(errors).not.toBe('');
    for (const token of [A_TOKEN, B_TOKEN]) expect(errors).not.toContain(token);

    // And nothing about it reached the admin API either.
    const list = await request(app.getHttpServer()).get('/api/v1/admin/sources').set('Cookie', cookie).expect(200);
    const wire = JSON.stringify(list.body);
    for (const token of [A_TOKEN, B_TOKEN]) {
      expect(wire).not.toContain(token);
      expect(wire).not.toContain(token.slice(0, 8));
    }
  });

  it('a source with no variable of its own falls back to GIT_HTTPS_TOKEN', async () => {
    process.env['GIT_HTTPS_TOKEN'] = 'the-instance-wide-one';
    await registry.upsert('topic:fallback', { remote_url: `${base}/acme/fallback.git` });
    await sync.runNow('topic:fallback').catch(() => undefined);
    expect(sentCredential()).toBe('x-access-token:the-instance-wide-one');
  });

  it('with no credential at all the cycle fails with an authentication error instead of hanging on a prompt', async () => {
    await registry.upsert('topic:none', { remote_url: `${base}/acme/none.git` });
    await sync.runNow('topic:none').catch(() => undefined);
    const row = await db.selectFrom('content_sources').select('last_error').where('id', '=', 'topic:none').executeTakeFirstOrThrow();
    expect(row.last_error ?? '').toMatch(/could not read Username|Authentication failed|terminal prompts disabled/i);
    // It never got past the 401 challenge.
    expect(seen.every((r) => !r.auth)).toBe(true);
  });

  describe('Test connection', () => {
    it('says which variable is missing when the source names one the server does not have', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/repos/test')
        .set('Cookie', cookie)
        .send({ remote_url: `${base}/acme/a.git`, host_token_env: 'E3_SOURCE_A_TOKEN', host_kind: 'github' })
        .expect(201);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain('E3_SOURCE_A_TOKEN');
      expect(res.body.message).toMatch(/not set in this server's environment/);
      // It did not even try: there was nothing to try with.
      expect(seen).toEqual([]);
    });

    it('uses the same credential path the engine does, and reports the variable, never the value', async () => {
      process.env['E3_SOURCE_A_TOKEN'] = A_TOKEN;
      const result = await repos.testConnection(`${base}/acme/a.git`, {
        tokenEnv: 'E3_SOURCE_A_TOKEN',
        hostKind: 'github',
      });
      expect(sentCredential()).toBe(`x-access-token:${A_TOKEN}`);
      // The listener refuses everyone, so the probe reports a failure — with
      // git's own words, minus anything that could be the token.
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(A_TOKEN);
      expect(JSON.stringify(result)).not.toContain(A_TOKEN.slice(0, 8));
    });
  });
});
