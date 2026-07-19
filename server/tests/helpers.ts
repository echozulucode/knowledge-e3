import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { AuthService } from '../src/auth/auth.service.js';

export async function makeApp(): Promise<INestApplication> {
  // Each test gets a fresh in-memory SQLite database via a unique DB_URL.
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // Use the SAME wiring the server ships (parsers, /assets mapping, prefix,
  // validation) rather than re-declaring it here — a hand-maintained copy of
  // this stack is what hid the production /assets 404 from these very tests.
  // SPA serving is off: tests exercise the API, not the built client.
  configureApp(app, { webDist: null });
  await app.init();
  return app;
}

export async function seedAdminAndLogin(
  app: INestApplication,
  username = 'admin',
  password = 'admin-password-123',
): Promise<{ cookie: string; userId: string }> {
  const auth = app.get(AuthService);
  const user = await auth.createUser({
    email: `${username}@example.com`,
    username,
    password,
    role: 'admin',
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = arr.find((c: string) => c.startsWith('kp_session='));
  if (!cookieHeader) throw new Error('No session cookie returned');
  return { cookie: cookieHeader.split(';')[0]!, userId: user.id };
}

export async function seedUserAndLogin(
  app: INestApplication,
  username = 'alice',
  password = 'alice-password-123',
): Promise<{ cookie: string; userId: string }> {
  const auth = app.get(AuthService);
  const user = await auth.createUser({
    email: `${username}@example.com`,
    username,
    password,
    role: 'user',
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = arr.find((c: string) => c.startsWith('kp_session='));
  if (!cookieHeader) throw new Error('No session cookie returned');
  return { cookie: cookieHeader.split(';')[0]!, userId: user.id };
}
