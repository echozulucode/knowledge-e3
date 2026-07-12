import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { seedFirstMvpCorpus } from '../src/seed.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

interface BundleFile {
  path: string;
  content: string;
}

describe('OKF HTTP bridge (/okf) e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    const db = app.get<Kysely<Database>>(KYSELY);
    await seedFirstMvpCorpus(db, login.userId);
  });

  afterEach(async () => app.close());

  it('exports a conformant OKF bundle as JSON for download', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/okf/export')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.okf_version).toBe('0.1');
    expect(res.body.item_count).toBeGreaterThan(0);
    expect(res.body.conformance.conformant).toBe(true);
    const files: BundleFile[] = res.body.files;
    expect(files.find((f) => f.path === 'index.md')?.content).toContain('okf_version: "0.1"');
    expect(files.some((f) => f.path.startsWith('concepts/'))).toBe(true);
  });

  it('round-trips: importing a downloaded bundle updates existing items', async () => {
    const exported = await request(app.getHttpServer())
      .get('/api/v1/okf/export')
      .set('Cookie', cookie)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: exported.body.files })
      .expect(201);

    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(exported.body.item_count);
    expect(res.body.ids).toHaveLength(exported.body.item_count);
  });

  it('exports a real .tar.gz bundle archive (concept files + index)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/okf/export/archive')
      .set('Cookie', cookie)
      .buffer()
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['content-disposition']).toContain('.tar.gz');
    expect(res.headers['x-okf-conformant']).toBe('true');

    // The gzip decodes to a ustar archive containing the bundle's files.
    const tar = gunzipSync(res.body as Buffer).toString('latin1');
    expect(tar).toContain('ustar');
    expect(tar).toContain('index.md');
    expect(tar).toContain('concepts/');
  });

  it('requires admin — a non-admin cannot export or import', async () => {
    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .get('/api/v1/okf/export')
      .set('Cookie', alice.cookie)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', alice.cookie)
      .send({ files: [] })
      .expect(403);
  });
});
