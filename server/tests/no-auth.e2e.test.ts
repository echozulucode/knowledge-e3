/**
 * Authentication cannot be turned off.
 *
 * This file used to prove the opposite: that `KNOWLEDGE_E3_AUTH_MODE=disabled`
 * made every request the local admin. That mode is gone
 * (the admin UX review §6, answer 5: "at minimum we need an admin
 * password"). What must hold now:
 *   - a leftover `disabled` in env or the config file STOPS the boot with the fix
 *     in the message, rather than being quietly read as `session`;
 *   - with no setting at all, sessions are required (the default);
 *   - the system actor that disabled mode used to hand every request is still a
 *     row for system writes, but can never sign in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { assertAuthenticationEnabled, LOCAL_SYSTEM_ACTOR } from '../src/auth/auth-mode.js';
import { AuthService } from '../src/auth/auth.service.js';
import { hashPassword } from '../src/auth/password.js';
import { resetServerConfig } from '../src/config/server-config.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { makeApp } from './helpers.js';

/** Boot the app the way the e2e harness does, closing whatever was built if init throws. */
async function tryBoot(): Promise<INestApplication> {
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, { webDist: null });
  try {
    await app.init();
    return app;
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
}

describe('authentication cannot be disabled', () => {
  const previousAuthMode = process.env['KNOWLEDGE_E3_AUTH_MODE'];
  const previousConfig = process.env['KNOWLEDGE_E3_CONFIG'];
  let app: INestApplication | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (previousAuthMode === undefined) delete process.env['KNOWLEDGE_E3_AUTH_MODE'];
    else process.env['KNOWLEDGE_E3_AUTH_MODE'] = previousAuthMode;
    if (previousConfig === undefined) delete process.env['KNOWLEDGE_E3_CONFIG'];
    else process.env['KNOWLEDGE_E3_CONFIG'] = previousConfig;
    resetServerConfig();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('refuses to boot when KNOWLEDGE_E3_AUTH_MODE=disabled, naming the fix', async () => {
    process.env['KNOWLEDGE_E3_AUTH_MODE'] = 'disabled';
    resetServerConfig();

    expect(() => assertAuthenticationEnabled()).toThrow(/Authentication cannot be disabled \(KNOWLEDGE_E3_AUTH_MODE=disabled\)/);
    expect(() => assertAuthenticationEnabled()).toThrow(/create an admin account with `pnpm --filter @echozedlabs\/server seed`/);
    await expect(tryBoot()).rejects.toThrow(/Authentication cannot be disabled/);
  });

  it('refuses to boot when the config file says auth.mode: disabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'e3-noauth-'));
    const file = join(tempDir, 'knowledge-e3.config.yaml');
    writeFileSync(file, 'auth:\n  mode: disabled\n', 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    delete process.env['KNOWLEDGE_E3_AUTH_MODE'];
    resetServerConfig();

    await expect(tryBoot()).rejects.toThrow(/Authentication cannot be disabled \(auth\.mode: disabled in .*knowledge-e3\.config\.yaml\)/);
  });

  it('an env override of session does not rescue a config file that still says disabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'e3-noauth-'));
    const file = join(tempDir, 'knowledge-e3.config.yaml');
    writeFileSync(file, 'auth: { mode: disabled }\n', 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    process.env['KNOWLEDGE_E3_AUTH_MODE'] = 'session';
    resetServerConfig();

    expect(() => assertAuthenticationEnabled()).toThrow(/Authentication cannot be disabled/);
  });

  it('refuses an unknown KNOWLEDGE_E3_AUTH_MODE rather than guessing', () => {
    process.env['KNOWLEDGE_E3_AUTH_MODE'] = 'off';
    expect(() => assertAuthenticationEnabled()).toThrow(/KNOWLEDGE_E3_AUTH_MODE: expected "session"/);
  });

  it('boots with KNOWLEDGE_E3_AUTH_MODE=session', async () => {
    process.env['KNOWLEDGE_E3_AUTH_MODE'] = 'session';
    resetServerConfig();
    app = await makeApp();
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('requires a session by default: no /me, no writes, no admin routes without signing in', async () => {
    delete process.env['KNOWLEDGE_E3_AUTH_MODE'];
    resetServerConfig();
    app = await makeApp();
    const http = app.getHttpServer();

    await request(http).get('/api/v1/me').expect(401);
    await request(http)
      .post('/api/v1/pages')
      .send({ title: 'No session', body: 'Refused.', status: 'draft' })
      .expect(401);
    await request(http)
      .post('/api/v1/admin/users')
      .send({ email: 'x@example.com', username: 'x-user', password: 'x-password-123' })
      .expect(401);
    await request(http).get('/api/v1/admin/users').expect(401);
  });

  it('the system actor exists for system writes but can never sign in, even with the old fixed password', async () => {
    delete process.env['KNOWLEDGE_E3_AUTH_MODE'];
    resetServerConfig();
    app = await makeApp();
    const http = app.getHttpServer();
    const db = app.get<Kysely<Database>>(KYSELY);

    const system = await app.get(AuthService).ensureLocalSystemActor();
    expect(system.id).toBe(LOCAL_SYSTEM_ACTOR.id);

    // A row written by the removed mode carried a hash of this fixed string.
    // Put that hash back and prove sign-in still refuses the account.
    const legacyPassword = `disabled-auth-${LOCAL_SYSTEM_ACTOR.id}`;
    await db
      .updateTable('users')
      .set({ password_hash: await hashPassword(legacyPassword) })
      .where('id', '=', LOCAL_SYSTEM_ACTOR.id)
      .execute();

    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ username: LOCAL_SYSTEM_ACTOR.username, password: legacyPassword })
      .expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
