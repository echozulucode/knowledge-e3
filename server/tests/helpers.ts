import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';

export async function makeApp(): Promise<INestApplication> {
  // Each test gets a fresh in-memory SQLite database via a unique DB_URL.
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // Match bootstrap: a high-limit parser scoped to OKF imports, a raw parser for
  // image uploads, plus a global parser for every other route. (Registering any
  // json parser makes Nest skip its own auto-registered one, so the global
  // parser here must be explicit.)
  app.use('/api/v1/okf/import', express.json({ limit: '50mb' }));
  app.use('/api/v1/images', express.raw({ type: () => true, limit: '25mb' }));
  app.use(express.json());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
  );
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
