/**
 * Issue 41 — the sign-in throttle.
 *
 * The old throttle was a process-local Map keyed by username only, consulted
 * AFTER the password was verified, and cleared by any success. Each case here
 * pins one of the holes that design left:
 *   - failures survive a restart, and two processes on one database share them;
 *   - one client spraying many usernames hits a per-IP limit;
 *   - a success from an IP does not reset that IP's bucket;
 *   - a caller over the limit is refused BEFORE the password is checked, so a
 *     correct guess no longer comes back 200;
 *   - 429 carries Retry-After; refusals and wrong-password responses say the
 *     same thing (and take comparable time) for real and unknown accounts;
 *   - every refusal is audited, with no password material.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { DEFAULT_LOGIN_THROTTLE, loginThrottleSettings, resetServerConfig } from '../src/config/server-config.js';
import { makeApp } from './helpers.js';

const ENV_KEYS = ['LOGIN_THROTTLE_WINDOW', 'LOGIN_THROTTLE_PER_USERNAME', 'LOGIN_THROTTLE_PER_IP'] as const;
const REAL_PASSWORD = 'correct-horse-battery-1';
const WRONG_PASSWORD = 'wrong-password-2718';

const temps: string[] = [];

/** An app on a FILE database, so a second instance can see what the first wrote. */
async function makeFileApp(dbUrl: string): Promise<{ app: INestApplication; db: Kysely<Database> }> {
  process.env['DB_URL'] = dbUrl;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, { webDist: null });
  await app.init();
  return { app, db: app.get<Kysely<Database>>(KYSELY) };
}

/** Close the app AND its DB handle — an open file handle blocks temp cleanup on Windows. */
async function closeFileApp(h: { app: INestApplication; db: Kysely<Database> }): Promise<void> {
  await h.app.close();
  await h.db.destroy().catch(() => undefined);
}

function login(app: INestApplication, username: string, password: string) {
  return request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password });
}

async function createUser(app: INestApplication, username: string, password = REAL_PASSWORD): Promise<void> {
  await app.get(AuthService).createUser({ email: `${username}@example.com`, username, password, role: 'user' });
}

describe('login throttle (issue 41)', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
  });

  afterAll(() => {
    for (const dir of temps) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A handle released a moment ago can still hold a file on Windows.
      }
    }
  });

  it('defaults to 5 failures per username and 20 per IP in a 15-minute window', () => {
    expect(DEFAULT_LOGIN_THROTTLE).toEqual({ windowMs: 15 * 60_000, perUsername: 5, perIp: 20 });
    expect(loginThrottleSettings()).toEqual(DEFAULT_LOGIN_THROTTLE);
    process.env['LOGIN_THROTTLE_PER_IP'] = 'off';
    process.env['LOGIN_THROTTLE_WINDOW'] = '5m';
    expect(loginThrottleSettings()).toEqual({ windowMs: 5 * 60_000, perUsername: 5, perIp: null });
    process.env['LOGIN_THROTTLE_PER_USERNAME'] = 'five';
    expect(() => loginThrottleSettings()).toThrow(/LOGIN_THROTTLE_PER_USERNAME/);
  });

  describe('persistence', () => {
    it('keeps counting failures across a restart and across two processes on one database file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'e3-login-throttle-'));
      temps.push(dir);
      const dbUrl = join(dir, 'kp.sqlite');

      const first = await makeFileApp(dbUrl);
      await createUser(first.app, 'persisted');
      for (let i = 0; i < 3; i++) await login(first.app, 'persisted', WRONG_PASSWORD).expect(401);

      // A second instance on the same file, running at the same time.
      const second = await makeFileApp(dbUrl);
      await login(second.app, 'persisted', WRONG_PASSWORD).expect(401);
      await login(first.app, 'persisted', WRONG_PASSWORD).expect(401);
      await closeFileApp(first);
      await closeFileApp(second);

      // "Restart": a brand-new instance. The old in-memory throttle forgot everything here.
      const restarted = await makeFileApp(dbUrl);
      try {
        await login(restarted.app, 'persisted', WRONG_PASSWORD).expect(429);
        // Refused before verification: the right password does not get in either.
        await login(restarted.app, 'persisted', REAL_PASSWORD).expect(429);
      } finally {
        await closeFileApp(restarted);
      }
    });
  });

  describe('on one app', () => {
    let app: INestApplication;
    let db: Kysely<Database>;

    beforeEach(async () => {
      resetServerConfig();
      app = await makeApp();
      db = app.get<Kysely<Database>>(KYSELY);
    });
    afterEach(async () => app.close());

    it('refuses a correct password once the username is over its limit (no 429/200 oracle)', async () => {
      await createUser(app, 'victim');
      for (let i = 0; i < 5; i++) await login(app, 'victim', WRONG_PASSWORD).expect(401);
      const res = await login(app, 'victim', REAL_PASSWORD).expect(429);
      expect(res.body.message).toContain('Too many failed attempts');
      // Case variants are the same bucket, not five more guesses.
      await login(app, 'VICTIM', WRONG_PASSWORD).expect(429);
    });

    it('stops one IP spraying many usernames at the per-IP limit', async () => {
      process.env['LOGIN_THROTTLE_PER_IP'] = '6';
      // Six different names: each is far under its own username limit.
      for (let i = 0; i < 6; i++) await login(app, `spray-${i}`, WRONG_PASSWORD).expect(401);
      const res = await login(app, 'spray-fresh-name', WRONG_PASSWORD).expect(429);
      expect(res.body.retry_after_seconds).toBeGreaterThan(0);

      const [row] = await db.selectFrom('audit_log').selectAll().where('action', '=', 'auth.login_throttled').execute();
      expect(JSON.parse(row!.payload_json!).buckets).toEqual(['ip']);
    });

    it('does not reset the IP bucket when a login from that IP succeeds', async () => {
      process.env['LOGIN_THROTTLE_PER_IP'] = '4';
      await createUser(app, 'insider');
      for (let i = 0; i < 3; i++) await login(app, `guess-${i}`, WRONG_PASSWORD).expect(401);

      // The sprayer signs into an account they legitimately hold...
      await login(app, 'insider', REAL_PASSWORD).expect(200);
      // ...which neither counts as a failure nor wipes the three before it.
      await login(app, 'guess-3', WRONG_PASSWORD).expect(401);
      await login(app, 'guess-4', WRONG_PASSWORD).expect(429);
      await login(app, 'insider', REAL_PASSWORD).expect(429);
    });

    it('clears only the signed-in username\'s own bucket on success', async () => {
      await createUser(app, 'typo-prone');
      for (let i = 0; i < 4; i++) {
        await login(app, 'typo-prone', WRONG_PASSWORD).expect(401);
        await login(app, 'someone-else', WRONG_PASSWORD).expect(401);
      }
      await login(app, 'typo-prone', REAL_PASSWORD).expect(200);
      // typo-prone starts over...
      for (let i = 0; i < 4; i++) await login(app, 'typo-prone', WRONG_PASSWORD).expect(401);
      // ...someone-else does not: one more failure fills it, and the next is refused.
      await login(app, 'someone-else', WRONG_PASSWORD).expect(401);
      await login(app, 'someone-else', WRONG_PASSWORD).expect(429);
    });

    it('cannot be raced: a concurrent burst gets at most the limit through to verification', async () => {
      await createUser(app, 'burst');
      const statuses = (
        await Promise.all(Array.from({ length: 12 }, () => login(app, 'burst', WRONG_PASSWORD)))
      ).map((r) => r.status);
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(7);
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    });

    it('sends Retry-After on 429, matching the body', async () => {
      for (let i = 0; i < 5; i++) await login(app, 'retry', WRONG_PASSWORD).expect(401);
      const res = await login(app, 'retry', WRONG_PASSWORD).expect(429);
      const header = Number(res.headers['retry-after']);
      expect(Number.isInteger(header)).toBe(true);
      expect(header).toBeGreaterThan(0);
      expect(header).toBeLessThanOrEqual(15 * 60);
      expect(res.body.retry_after_seconds).toBe(header);
    });

    it('answers an unknown user exactly like a wrong password — message, lockout, and timing', async () => {
      await createUser(app, 'exists');

      const real = await login(app, 'exists', WRONG_PASSWORD).expect(401);
      const unknown = await login(app, 'never-registered', WRONG_PASSWORD).expect(401);
      expect(unknown.body).toEqual(real.body);

      for (let i = 0; i < 4; i++) {
        await login(app, 'exists', WRONG_PASSWORD).expect(401);
        await login(app, 'never-registered', WRONG_PASSWORD).expect(401);
      }
      const realLocked = await login(app, 'exists', WRONG_PASSWORD).expect(429);
      const unknownLocked = await login(app, 'never-registered', WRONG_PASSWORD).expect(429);
      expect(Object.keys(unknownLocked.body).sort()).toEqual(Object.keys(realLocked.body).sort());
      expect(unknownLocked.body.message).toBe(realLocked.body.message);

      // Timing: an unknown name used to be rejected before hashing, answering in
      // microseconds against scrypt's tens of milliseconds. Both paths now pay a
      // scrypt round. Compared as a generous ratio of medians so CI noise cannot
      // flake it; the gap it guards against is two orders of magnitude.
      process.env['LOGIN_THROTTLE_PER_USERNAME'] = 'off';
      process.env['LOGIN_THROTTLE_PER_IP'] = 'off';
      const time = async (username: string): Promise<number> => {
        const samples: number[] = [];
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          await login(app, username, WRONG_PASSWORD).expect(401);
          samples.push(performance.now() - start);
        }
        return samples.sort((a, b) => a - b)[1]!;
      };
      const realMs = await time('exists');
      const unknownMs = await time('never-registered');
      expect(unknownMs).toBeGreaterThan(realMs * 0.3);
    });

    it('audits auth.login_throttled with the normalized username and IP, and no password', async () => {
      for (let i = 0; i < 5; i++) await login(app, 'Audited', WRONG_PASSWORD).expect(401);
      await login(app, '  AUDITED ', WRONG_PASSWORD).expect(429);

      const rows = await db.selectFrom('audit_log').selectAll().where('action', '=', 'auth.login_throttled').execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBeNull();
      const raw = JSON.stringify(rows[0]);
      expect(raw).not.toContain(WRONG_PASSWORD);
      expect(raw).not.toContain('password');
      expect(JSON.parse(rows[0]!.payload_json!)).toEqual({
        username_attempted: 'audited',
        ip: expect.any(String),
        buckets: ['username'],
        retry_after_seconds: expect.any(Number),
      });
    });

    it('prunes attempts that have left the window', async () => {
      const old = Date.now() - 16 * 60_000;
      await db
        .insertInto('login_attempts')
        .values([
          { bucket: 'username', key: 'stale', attempted_at: old },
          { bucket: 'ip', key: '203.0.113.9', attempted_at: old },
        ])
        .execute();
      await login(app, 'anyone', WRONG_PASSWORD).expect(401);
      const left = await db.selectFrom('login_attempts').select('key').execute();
      expect(left.map((r) => r.key)).not.toContain('stale');
      expect(left.map((r) => r.key)).not.toContain('203.0.113.9');
    });
  });
});
