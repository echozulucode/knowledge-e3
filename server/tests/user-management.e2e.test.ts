/**
 * Wave 2 — admin user management e2e.
 *
 * Covers GET /admin/users (list), PATCH /admin/users/:id (role + enable/disable),
 * and POST /admin/users/:id/reset-password, including admin gating and the
 * lockout guardrails (no self-disable, no self-demote, no removing the last admin).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import type { Kysely } from 'kysely';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

describe('admin user management e2e (Wave 2)', () => {
  let app: INestApplication;
  let adminCookie: string;
  let adminId: string;
  let aliceCookie: string;
  let aliceId: string;
  let bobCookie: string;
  let bobId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie, userId: adminId } = await seedAdminAndLogin(app));
    ({ cookie: aliceCookie, userId: aliceId } = await seedUserAndLogin(app, 'alice', 'alice-password-123'));
    ({ cookie: bobCookie, userId: bobId } = await seedUserAndLogin(app, 'bob', 'bob-password-123'));
  });
  afterEach(async () => app.close());

  describe('admin gating', () => {
    it('returns 403 for non-admins on list / update / reset-password', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/users').set('Cookie', aliceCookie).expect(403);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${bobId}`)
        .set('Cookie', aliceCookie)
        .send({ role: 'admin' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${bobId}/reset-password`)
        .set('Cookie', aliceCookie)
        .expect(403);
    });
  });

  describe('list', () => {
    it('lists real accounts with derived status, excluding the local-system actor', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/users').set('Cookie', adminCookie).expect(200);
      const usernames = res.body.users.map((u: { username: string }) => u.username);
      expect(usernames).toEqual(expect.arrayContaining(['admin', 'alice', 'bob']));
      expect(usernames).not.toContain('local-system');
      const alice = res.body.users.find((u: { username: string }) => u.username === 'alice');
      expect(alice.status).toBe('active');
      expect(alice.role).toBe('user');
    });

    it('filters by role and status', async () => {
      const admins = await request(app.getHttpServer())
        .get('/api/v1/admin/users?role=admin')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(admins.body.users.map((u: { username: string }) => u.username)).toEqual(['admin']);

      await request(app.getHttpServer()).patch(`/api/v1/admin/users/${bobId}`).set('Cookie', adminCookie).send({ disabled: true }).expect(200);
      const disabled = await request(app.getHttpServer())
        .get('/api/v1/admin/users?status=disabled')
        .set('Cookie', adminCookie)
        .expect(200);
      expect(disabled.body.users.map((u: { username: string }) => u.username)).toEqual(['bob']);
    });
  });

  describe('list: server paging, sorting, filters, total (review §4.3)', () => {
    type Row = { username: string; email: string; role: string; status: string; last_seen_at: string | null };
    const list = async (qs: string) =>
      (await request(app.getHttpServer()).get(`/api/v1/admin/users${qs}`).set('Cookie', adminCookie).expect(200)).body as {
        users: Row[];
        total: number;
        limit: number;
        offset: number;
      };

    /** 12 more accounts on top of admin/alice/bob: 15 real accounts in all. */
    async function seedMany() {
      const auth = app.get(AuthService);
      for (let i = 0; i < 12; i += 1) {
        const n = String(i).padStart(2, '0');
        await auth.createUser({
          email: `member${n}@corp.example`,
          username: `member-${n}`,
          password: 'member-password-123',
          role: i % 4 === 0 ? 'admin' : 'user',
        });
      }
    }

    it('keeps { users } and adds total/limit/offset; defaults to 50, oldest first', async () => {
      await app.get(AuthService).ensureLocalSystemActor();
      const body = await list('');
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
      // The system actor is neither listed nor counted.
      expect(body.total).toBe(3);
      expect(body.users.map((u) => u.username)).toEqual(['admin', 'alice', 'bob']);
    });

    it('pages with limit/offset against a total that covers every match', async () => {
      await seedMany();
      const first = await list('?limit=5&offset=0');
      const second = await list('?limit=5&offset=5');
      const last = await list('?limit=5&offset=10');
      const beyond = await list('?limit=5&offset=15');
      expect([first.total, second.total, last.total, beyond.total]).toEqual([15, 15, 15, 15]);
      expect(first.users).toHaveLength(5);
      expect(last.users).toHaveLength(5);
      expect(beyond.users).toHaveLength(0);
      const seen = [...first.users, ...second.users, ...last.users].map((u) => u.username);
      expect(new Set(seen).size).toBe(15);
    });

    it('clamps limit to 200 and refuses malformed paging or sort values', async () => {
      expect((await list('?limit=5000')).limit).toBe(200);
      for (const qs of ['?limit=0', '?limit=abc', '?offset=-1', '?sort=password', '?direction=up']) {
        await request(app.getHttpServer()).get(`/api/v1/admin/users${qs}`).set('Cookie', adminCookie).expect(400);
      }
    });

    it('sorts by username (case-insensitive), role, status and created, both directions', async () => {
      await seedMany();
      const byName = await list('?sort=username&direction=desc&limit=3');
      expect(byName.users.map((u) => u.username)).toEqual(['member-11', 'member-10', 'member-09']);
      const byNameAsc = await list('?sort=username&limit=2');
      expect(byNameAsc.users.map((u) => u.username)).toEqual(['admin', 'alice']);

      const byRole = await list('?sort=role&direction=asc&limit=200');
      const roles = byRole.users.map((u) => u.role);
      expect(roles.indexOf('user')).toBeGreaterThan(roles.lastIndexOf('admin'));

      await request(app.getHttpServer()).patch(`/api/v1/admin/users/${bobId}`).set('Cookie', adminCookie).send({ disabled: true }).expect(200);
      const byStatus = await list('?sort=status&direction=desc&limit=1');
      expect(byStatus.users[0]).toMatchObject({ username: 'bob', status: 'disabled' });

      const newest = await list('?sort=created&direction=desc&limit=1');
      expect(newest.users[0]!.username).toBe('member-11');
    });

    it('sorts by last seen, most recent first, never-seen last', async () => {
      await seedMany();
      // Pin the times: the admin's own list request slides the admin's session,
      // so sign-in order alone would make the admin the most recent every time.
      const db = app.get<Kysely<Database>>(KYSELY);
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      await db.updateTable('sessions').set({ last_seen_at: future }).where('user_id', '=', aliceId).execute();
      await db.updateTable('sessions').set({ last_seen_at: '2020-01-01T00:00:00.000Z' }).where('user_id', '=', bobId).execute();
      const body = await list('?sort=last_seen&direction=desc&limit=200');
      expect(body.users[0]!.username).toBe('alice');
      expect(body.users[2]!.username).toBe('bob');
      const seen = body.users.filter((u) => u.last_seen_at !== null).map((u) => u.username);
      expect(seen.sort()).toEqual(['admin', 'alice', 'bob']);
      expect(body.users.slice(-12).every((u) => u.last_seen_at === null)).toBe(true);
    });

    it('filters q (username or email, case-insensitive, literal), role and status in SQL, with a matching total', async () => {
      await seedMany();
      const corp = await list('?q=CORP.example&limit=5');
      expect(corp.total).toBe(12);
      expect(corp.users).toHaveLength(5);

      const one = await list('?q=member-07');
      expect(one.users.map((u) => u.username)).toEqual(['member-07']);

      // `_` and `%` are characters, not LIKE wildcards.
      expect((await list('?q=member_0')).total).toBe(0);
      expect((await list('?q=%25')).total).toBe(0);

      const admins = await list('?role=admin&status=active');
      // admin + member-00, -04, -08
      expect(admins.total).toBe(4);

      await request(app.getHttpServer()).patch(`/api/v1/admin/users/${bobId}`).set('Cookie', adminCookie).send({ disabled: true }).expect(200);
      const active = await list('?status=active&q=b');
      expect(active.users.map((u) => u.username)).not.toContain('bob');
      expect((await list('?status=disabled')).total).toBe(1);
    });
  });

  describe('get one', () => {
    it('returns one account for the user sheet; 404 for unknown ids and the system actor; admin only', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/admin/users/${bobId}`).set('Cookie', adminCookie).expect(200);
      expect(res.body.user).toMatchObject({ id: bobId, username: 'bob', role: 'user', status: 'active' });
      expect(res.body.user.last_seen_at).toEqual(expect.any(String));

      await app.get(AuthService).ensureLocalSystemActor();
      await request(app.getHttpServer()).get('/api/v1/admin/users/local-system').set('Cookie', adminCookie).expect(404);
      await request(app.getHttpServer()).get('/api/v1/admin/users/nope').set('Cookie', adminCookie).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/admin/users/${bobId}`).set('Cookie', aliceCookie).expect(403);
    });
  });

  describe('create: duplicate errors name the field', () => {
    it('409 with reason username_taken or email_taken', async () => {
      const dupName = await request(app.getHttpServer())
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({ email: 'someone-new@example.com', username: 'alice', password: 'another-password-1' })
        .expect(409);
      expect(dupName.body).toMatchObject({ reason: 'username_taken', message: expect.stringMatching(/username/) });

      const dupEmail = await request(app.getHttpServer())
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({ email: 'alice@example.com', username: 'alice-two', password: 'another-password-1' })
        .expect(409);
      expect(dupEmail.body).toMatchObject({ reason: 'email_taken', message: expect.stringMatching(/email/) });
    });
  });

  describe('role changes', () => {
    it('promotes a user to admin and the change is reflected', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${aliceId}`)
        .set('Cookie', adminCookie)
        .send({ role: 'admin' })
        .expect(200);
      expect(res.body.user.role).toBe('admin');

      // Alice can now hit an admin-only endpoint.
      await request(app.getHttpServer()).get('/api/v1/admin/users').set('Cookie', aliceCookie).expect(200);
    });
  });

  describe('disable / enable', () => {
    it('disabling a user invalidates their sessions and blocks login; re-enabling restores it', async () => {
      // Bob is active and signed in.
      await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', bobCookie).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${bobId}`)
        .set('Cookie', adminCookie)
        .send({ disabled: true })
        .expect(200);

      // Existing session no longer resolves.
      await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', bobCookie).expect(401);
      // And he cannot sign back in.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'bob', password: 'bob-password-123' })
        .expect(401);

      // Re-enable.
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${bobId}`)
        .set('Cookie', adminCookie)
        .send({ disabled: false })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'bob', password: 'bob-password-123' })
        .expect(200);
    });
  });

  describe('reset password', () => {
    it('returns a temporary password, rotates sessions, and the user can sign in with it', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${aliceId}/reset-password`)
        .set('Cookie', adminCookie)
        .expect(201);
      const temp: string = res.body.temporary_password;
      expect(typeof temp).toBe('string');
      expect(temp.length).toBeGreaterThanOrEqual(8);

      // Old session invalidated.
      await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', aliceCookie).expect(401);
      // Old password no longer works; the temporary one does.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'alice', password: 'alice-password-123' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'alice', password: temp })
        .expect(200);
    });
  });

  describe('lockout guardrails', () => {
    it('an admin cannot disable or demote their own account', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${adminId}`)
        .set('Cookie', adminCookie)
        .send({ disabled: true })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/users/${adminId}`)
        .set('Cookie', adminCookie)
        .send({ role: 'user' })
        .expect(400);
    });

    it('the last active admin cannot be removed (service guard)', async () => {
      const auth = app.get(AuthService);
      // Acting as a different id so the self-guard is not what trips: the only
      // admin is `admin`, so disabling them must be refused.
      await expect(auth.updateUser(aliceId, adminId, { disabled: true })).rejects.toBeInstanceOf(BadRequestException);
      await expect(auth.updateUser(aliceId, adminId, { role: 'user' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // Keep ids referenced for clarity even if a future refactor drops some uses.
  void aliceId;
  void bobId;
});
