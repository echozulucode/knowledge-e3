import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../src/storage/revision-mirror.port.js';
import { NoopRevisionMirrorAdapter } from '../src/storage/noop-revision-mirror.adapter.js';
import { seedAdminAndLogin } from './helpers.js';

describe('storage mirror state schema', () => {
  it('creates an optional revision_mirror_state table for out-of-band storage mirrors', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);

      const columns = await tableColumns(db, 'revision_mirror_state');
      expect(columns).toEqual(
        expect.arrayContaining([
          'page_id',
          'backend',
          'path',
          'last_synced_version_token',
          'last_commit',
          'last_ref',
          'dirty',
          'error',
          'created_at',
          'updated_at',
          'last_synced_at',
        ]),
      );
    } finally {
      await db.destroy();
    }
  });
});

describe('revision mirror adapter seam', () => {
  let app: INestApplication;
  let cookie: string;
  const mirrorCalls: unknown[] = [];

  afterEach(async () => {
    mirrorCalls.length = 0;
    await app?.close();
  });

  it('uses the default no-op revision mirror without changing normal item saves', async () => {
    app = await makeAppWithMirror(new NoopRevisionMirrorAdapter());
    ({ cookie } = await seedAdminAndLogin(app));

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Noop Mirror Item', body: 'still database first' })
      .expect(201);

    expect(created.body.item).toMatchObject({
      title: 'Noop Mirror Item',
      version_token: 1,
    });
    expect(created.body.item.body_markdown).toContain('still database first');
  });

  it('calls RevisionMirrorPort after item create and update with persisted version metadata', async () => {
    app = await makeAppWithMirror({
      afterItemVersionPersisted: async (event) => {
        mirrorCalls.push(event);
      },
    });
    ({ cookie } = await seedAdminAndLogin(app));

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Mirrored Item', body: 'v1' })
      .expect(201);

    const id = created.body.item.id as string;
    const versionId = created.body.item.current_version_id as string;

    await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', '1')
      .send({ body: 'v2' })
      .expect(200);

    expect(mirrorCalls).toHaveLength(2);
    expect(mirrorCalls[0]).toMatchObject({
      itemId: id,
      versionId,
      versionToken: 1,
      title: 'Mirrored Item',
      slug: 'mirrored-item',
      rawMarkdown: expect.stringContaining('v1'),
    });
    expect(mirrorCalls[1]).toMatchObject({
      itemId: id,
      versionToken: 2,
      rawMarkdown: expect.stringContaining('v2'),
    });
  });

  it('does not roll back database item saves when the mirror adapter fails', async () => {
    app = await makeAppWithMirror({
      afterItemVersionPersisted: async () => {
        throw new Error('mirror unavailable');
      },
    });
    ({ cookie } = await seedAdminAndLogin(app));

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Mirror Failure Still Saves', body: 'db wins' })
      .expect(201);

    const got = await request(app.getHttpServer())
      .get(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(got.body.item).toMatchObject({
      title: 'Mirror Failure Still Saves',
      version_token: 1,
    });
    expect(got.body.item.body_markdown).toContain('db wins');
  });
});

async function makeAppWithMirror(mirror: RevisionMirrorPort): Promise<INestApplication> {
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REVISION_MIRROR)
    .useValue(mirror)
    .compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

async function tableColumns(db: Kysely<Database>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return result.rows.map((row) => row.name);
}
