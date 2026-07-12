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
import { AuthService } from '../src/auth/auth.service.js';

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
