import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('auth e2e', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await makeApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('rejects login with bad credentials', async () => {
    await seedAdminAndLogin(app);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'wrong' })
      .expect(401);
  });

  it('rejects /me when not logged in', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('returns the user from /me when logged in', async () => {
    const { cookie } = await seedAdminAndLogin(app);
    const res = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.role).toBe('admin');
  });

  it('logs out and invalidates the session', async () => {
    const { cookie } = await seedAdminAndLogin(app);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('admin can create a regular user via POST /admin/users', async () => {
    const { cookie } = await seedAdminAndLogin(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/users')
      .set('Cookie', cookie)
      .send({ email: 'bob@example.com', username: 'bob', password: 'bob-password-1' })
      .expect(201);
    expect(res.body.user.username).toBe('bob');
    expect(res.body.user.role).toBe('user');
  });

  it('non-admin cannot create users', async () => {
    const { cookie: adminCookie } = await seedAdminAndLogin(app);
    await request(app.getHttpServer())
      .post('/api/v1/admin/users')
      .set('Cookie', adminCookie)
      .send({ email: 'alice@example.com', username: 'alice', password: 'aaaaaaaa' })
      .expect(201);

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'aaaaaaaa' })
      .expect(200);
    const setCookie = loginRes.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const cookie = arr.find((c: string) => c.startsWith('kp_session='))!.split(';')[0];

    await request(app.getHttpServer())
      .post('/api/v1/admin/users')
      .set('Cookie', cookie!)
      .send({ email: 'carol@example.com', username: 'carol', password: 'cccccccc' })
      .expect(403);
  });

  it('change password requires correct old password', async () => {
    const { cookie } = await seedAdminAndLogin(app);
    await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set('Cookie', cookie)
      .send({ old_password: 'wrong', new_password: 'new-password-123' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set('Cookie', cookie)
      .send({ old_password: 'admin-password-123', new_password: 'new-password-123' })
      .expect(204);
  });

  it('change password rotates sessions: old cookie is invalidated, new cookie works (P2-6)', async () => {
    const { cookie: oldCookie } = await seedAdminAndLogin(app);

    const res = await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set('Cookie', oldCookie)
      .send({ old_password: 'admin-password-123', new_password: 'new-password-123' })
      .expect(204);

    // A fresh session cookie is issued for the caller.
    const setCookie = res.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const newCookie = arr.find((c: string) => c.startsWith('kp_session='))!.split(';')[0];
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(oldCookie);

    // The old cookie no longer authenticates.
    await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', oldCookie).expect(401);
    // The new cookie does.
    await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', newCookie).expect(200);
  });

  it('healthz responds without auth', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/healthz').expect(200);
    expect(res.text).toBe('ok');
  });

  it('successful login Set-Cookie has HttpOnly and SameSite=Lax', async () => {
    const auth = app.get(await import('../src/auth/auth.service.js').then((m) => m.AuthService));
    await auth.createUser({ email: 'cookie@example.com', username: 'cookieadmin', password: 'cookie-pass-12', role: 'admin' });
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'cookieadmin', password: 'cookie-pass-12' })
      .expect(200);
    const setCookie = loginRes.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const session = arr.find((c: string) => c.startsWith('kp_session='));
    expect(session).toBeDefined();
    expect(session!.toLowerCase()).toMatch(/httponly/);
    expect(session!).toMatch(/SameSite=Lax/i);
  });

  it('rate limit: 5 failed attempts return 401, 6th returns 429', async () => {
    const auth = app.get(await import('../src/auth/auth.service.js').then((m) => m.AuthService));
    await auth.createUser({ email: 'ratelimit@example.com', username: 'ratelimit', password: 'correct-password-1', role: 'user' });

    // 5 failed attempts should each return 401.
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'ratelimit', password: 'wrong-password' })
        .expect(401);
      expect(res.body.message).toContain('Invalid credentials');
    }

    // 6th attempt should return 429 (throttled).
    const throttledRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'ratelimit', password: 'wrong-password' })
      .expect(429);
    expect(throttledRes.body.message).toContain('Too many failed attempts');
    expect(throttledRes.body.retry_after_seconds).toBeGreaterThan(0);
  });

  it('rate limit: successful login resets the counter', async () => {
    const auth = app.get(await import('../src/auth/auth.service.js').then((m) => m.AuthService));
    await auth.createUser({ email: 'reset@example.com', username: 'reset', password: 'correct-password-1', role: 'user' });

    // 5 failed attempts.
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'reset', password: 'wrong-password' })
        .expect(401);
    }

    // Successful login resets the counter.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'reset', password: 'correct-password-1' })
      .expect(200);

    // After reset, we can attempt again without 429.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'reset', password: 'wrong-password' })
      .expect(401);
  });

  it('rate limit: different usernames have independent throttle counters', async () => {
    const auth = app.get(await import('../src/auth/auth.service.js').then((m) => m.AuthService));
    await auth.createUser({ email: 'alice@example.com', username: 'alice', password: 'alice-pass', role: 'user' });
    await auth.createUser({ email: 'bob@example.com', username: 'bob', password: 'bob-pass', role: 'user' });

    // 5 failed attempts for alice.
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ username: 'alice', password: 'wrong' })
        .expect(401);
    }

    // alice should now be throttled.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'wrong' })
      .expect(429);

    // bob should not be throttled; one failed attempt is fine.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'bob', password: 'wrong' })
      .expect(401);

    // bob can still attempt to log in.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'bob', password: 'bob-pass' })
      .expect(200);
  });
});
