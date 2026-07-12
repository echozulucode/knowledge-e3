import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { makeApp } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

describe('no-auth local mode', () => {
  let app: INestApplication;
  const previousAuthMode = process.env['KNOWLEDGE_E3_AUTH_MODE'];

  beforeEach(async () => {
    process.env['KNOWLEDGE_E3_AUTH_MODE'] = 'disabled';
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
    if (previousAuthMode === undefined) {
      delete process.env['KNOWLEDGE_E3_AUTH_MODE'];
    } else {
      process.env['KNOWLEDGE_E3_AUTH_MODE'] = previousAuthMode;
    }
  });

  it('returns the stable local system actor from /me without a session cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me').expect(200);

    expect(res.body.user).toEqual({
      id: 'local-system',
      username: 'local-system',
      email: 'local-system@knowledge-e3.local',
      role: 'admin',
    });
  });

  it('attaches the local system actor to write paths that require CurrentUser', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .send({ title: 'No Auth Local Item', body: 'Created without a login.', status: 'draft' })
      .expect(201);

    expect(createRes.body.page.owner_id).toBe('local-system');
    expect(createRes.body.page.title).toBe('No Auth Local Item');
  });

  it('allows admin-only endpoints as the local system actor without creating a session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/users')
      .send({
        email: 'local-created@example.com',
        username: 'local-created',
        password: 'local-created-password',
      })
      .expect(201);

    expect(res.body.user.username).toBe('local-created');
    expect(res.body.user.role).toBe('user');
  });

  it('canonicalizes a drifted local system actor row before returning /me', async () => {
    const db = app.get<Kysely<Database>>(KYSELY);
    await db
      .insertInto('users')
      .values({
        id: 'local-system',
        email: 'drifted@example.com',
        username: 'drifted-local-user',
        password_hash: 'not-used-in-disabled-mode',
        role: 'user',
        created_at: new Date().toISOString(),
        deleted_at: null,
      })
      .execute();

    const res = await request(app.getHttpServer()).get('/api/v1/me').expect(200);
    expect(res.body.user).toEqual({
      id: 'local-system',
      username: 'local-system',
      email: 'local-system@knowledge-e3.local',
      role: 'admin',
    });

    const row = await db
      .selectFrom('users')
      .select(['email', 'username', 'role', 'deleted_at'])
      .where('id', '=', 'local-system')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      email: 'local-system@knowledge-e3.local',
      username: 'local-system',
      role: 'admin',
      deleted_at: null,
    });
  });
});
