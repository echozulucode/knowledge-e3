import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

describe('bug report e2e', () => {
  let app: INestApplication;
  beforeEach(async () => {
    app = await makeApp();
  });
  afterEach(async () => app.close());

  it('accepts a bug report from an authenticated user and persists it', async () => {
    const { cookie } = await seedAdminAndLogin(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/bug-report')
      .set('Cookie', cookie)
      .send({
        body: 'Save spinner stuck.',
        context: { browser: 'firefox', last_actions: ['type', 'click save'] },
      })
      .expect(201);
    const id = res.body.id as string;
    const db = app.get<Kysely<Database>>(KYSELY);
    const row = await db.selectFrom('bug_reports').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row).toBeDefined();
    expect(row!.status).toBe('new');
    expect(JSON.parse(row!.context_json)).toMatchObject({ browser: 'firefox' });
  });

  it('accepts a bug report from an anonymous user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/bug-report')
      .send({ body: 'Login is broken.', context: {} })
      .expect(201);
  });
});
