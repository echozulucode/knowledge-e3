/**
 * Wave 3 e2e — config storage (password policy + user prefs) and the CSRF
 * origin-verification guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('config + csrf e2e (Wave 3)', () => {
  let app: INestApplication;
  let adminCookie: string;
  let aliceCookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie: adminCookie } = await seedAdminAndLogin(app));
    ({ cookie: aliceCookie } = await seedUserAndLogin(app, 'alice', 'alice-password-123'));
  });
  afterEach(async () => app.close());

  describe('password policy', () => {
    it('is admin-only', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/auth/password-policy').set('Cookie', aliceCookie).expect(403);
      await request(app.getHttpServer())
        .put('/api/v1/admin/auth/password-policy')
        .set('Cookie', aliceCookie)
        .send({ min_length: 12, require_number: true, require_symbol: true, require_uppercase: true })
        .expect(403);
    });

    it('returns the default policy and persists updates', async () => {
      const def = await request(app.getHttpServer()).get('/api/v1/admin/auth/password-policy').set('Cookie', adminCookie).expect(200);
      expect(def.body.policy).toEqual({ min_length: 8, require_number: false, require_symbol: false, require_uppercase: false });

      const put = await request(app.getHttpServer())
        .put('/api/v1/admin/auth/password-policy')
        .set('Cookie', adminCookie)
        .send({ min_length: 12, require_number: true, require_symbol: true, require_uppercase: true })
        .expect(200);
      expect(put.body.policy.min_length).toBe(12);

      const after = await request(app.getHttpServer()).get('/api/v1/admin/auth/password-policy').set('Cookie', adminCookie).expect(200);
      expect(after.body.policy.require_symbol).toBe(true);
    });

    it('enforces the policy on user creation and password change', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/admin/auth/password-policy')
        .set('Cookie', adminCookie)
        .send({ min_length: 10, require_number: true, require_symbol: true, require_uppercase: true })
        .expect(200);

      // Weak password (passes the DTO's MinLength(8) but fails the policy).
      await request(app.getHttpServer())
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({ email: 'weak@example.com', username: 'weaky', password: 'lowercaseonly' })
        .expect(400);

      // Strong password satisfies the policy.
      await request(app.getHttpServer())
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({ email: 'strong@example.com', username: 'strongy', password: 'Strong-Pass-1!' })
        .expect(201);

      // changePassword is policy-checked too.
      await request(app.getHttpServer())
        .post('/api/v1/me/password')
        .set('Cookie', aliceCookie)
        .send({ old_password: 'alice-password-123', new_password: 'stilltoolower' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/me/password')
        .set('Cookie', aliceCookie)
        .send({ old_password: 'alice-password-123', new_password: 'Brand-New-9!' })
        .expect(204);
    });
  });

  describe('user prefs', () => {
    it('round-trips per-user preferences and is isolated per user', async () => {
      const empty = await request(app.getHttpServer()).get('/api/v1/me/prefs').set('Cookie', aliceCookie).expect(200);
      expect(empty.body.prefs).toEqual({});

      const set = await request(app.getHttpServer())
        .put('/api/v1/me/prefs')
        .set('Cookie', aliceCookie)
        .send({ key: 'theme', value: 'dark' })
        .expect(200);
      expect(set.body.prefs.theme).toBe('dark');

      const get = await request(app.getHttpServer()).get('/api/v1/me/prefs').set('Cookie', aliceCookie).expect(200);
      expect(get.body.prefs.theme).toBe('dark');

      // The admin has their own (empty) prefs.
      const adminPrefs = await request(app.getHttpServer()).get('/api/v1/me/prefs').set('Cookie', adminCookie).expect(200);
      expect(adminPrefs.body.prefs).toEqual({});
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/prefs').expect(401);
    });
  });

  describe('csrf origin guard', () => {
    it('blocks a mutating request from a disallowed Origin (before auth)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.example.com')
        .send({ username: 'admin', password: 'admin-password-123' })
        .expect(403);

      // Even with a valid session cookie, a cross-origin mutation is refused.
      await request(app.getHttpServer())
        .put('/api/v1/me/prefs')
        .set('Cookie', aliceCookie)
        .set('Origin', 'https://evil.example.com')
        .send({ key: 'theme', value: 'dark' })
        .expect(403);
    });

    it('allows requests with no Origin and with a localhost Origin', async () => {
      // No Origin (server-to-server / same-origin nav): normal handling.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'admin', password: 'admin-password-123' })
        .expect(200);

      // Localhost Origin is allowed in non-production.
      await request(app.getHttpServer())
        .put('/api/v1/me/prefs')
        .set('Cookie', aliceCookie)
        .set('Origin', 'http://localhost:5173')
        .send({ key: 'theme', value: 'light' })
        .expect(200);
    });

    it('does not interfere with safe (GET) cross-origin reads', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Cookie', aliceCookie)
        .set('Origin', 'https://evil.example.com')
        .expect(200);
    });
  });
});
