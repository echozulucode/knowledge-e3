import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';

// A tiny valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Images e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let items: ItemsService;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-assets-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    items = app.get(ItemsService);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
  });

  async function upload(bytes: Buffer, mime = 'image/png') {
    const res = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', mime)
      .send(bytes)
      .expect(201);
    return res.body as { id: string; url: string; file: string; mime: string; byte_size: number };
  }

  it('uploads, serves, dedupes, and content-addresses', async () => {
    const a = await upload(PNG);
    expect(a.url).toBe(`/assets/${a.file}`);
    expect(a.byte_size).toBe(PNG.length);

    // Served bytes round-trip with the right content type — fetched via the URL
    // we actually STORE (`a.url`), which is what a rendered <img> requests. This
    // previously fetched /api/v1/assets/<file> instead: a URL nothing embeds, so
    // the suite passed while every image 404'd in production.
    const served = await request(app.getHttpServer())
      .get(a.url)
      .set('Cookie', cookie)
      .buffer()
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);

    // Identical bytes dedupe to the same stored file.
    const b = await upload(PNG);
    expect(b.file).toBe(a.file);
  });

  it('tracks usage and flags orphans', async () => {
    const img = await upload(PNG);

    // Initially unreferenced → orphan.
    let list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200)).body.images;
    expect(list).toHaveLength(1);
    expect(list[0].orphan).toBe(true);
    expect(list[0].used_by).toBe(0);

    // Reference it from a page → no longer an orphan.
    await items.create(adminId, {
      title: 'Has Image',
      body: `Here is a picture:\n\n![shot](${img.url})\n`,
      status: 'published',
    });
    list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200)).body.images;
    expect(list[0].used_by).toBe(1);
    expect(list[0].orphan).toBe(false);
  });

  it('deletes an image and its bytes', async () => {
    const img = await upload(PNG);
    await request(app.getHttpServer()).delete(`/api/v1/admin/images/${img.id}`).set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/assets/${img.file}`).set('Cookie', cookie).expect(404);
    const list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200)).body.images;
    expect(list).toHaveLength(0);
  });

  it('hides draft-only assets from anonymous visitors on a public instance', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/admin/access')
      .set('Cookie', cookie)
      .send({ read_mode: 'public' })
      .expect(200);

    const img = await upload(PNG);

    // Embedded only in a DRAFT: an anonymous visitor must not get the bytes,
    // and the response must not be marked cacheable by shared proxies.
    const draft = await items.create(adminId, {
      title: 'Draft With Image',
      body: `![shot](${img.url})`,
      status: 'draft',
    });
    await request(app.getHttpServer()).get(img.url).expect(404);
    const asAuthor = await request(app.getHttpServer()).get(img.url).set('Cookie', cookie).expect(200);
    expect(asAuthor.headers['cache-control']).toContain('private');

    // Once a PUBLISHED page embeds it, the same asset becomes public and
    // shared-cacheable.
    await items.create(adminId, {
      title: 'Published With Image',
      body: `![shot](${img.url})`,
      status: 'published',
    });
    const anon = await request(app.getHttpServer()).get(img.url).expect(200);
    expect(anon.headers['cache-control']).toContain('public');
    expect(draft.id).toBeTruthy();
  });

  it('requires admin to manage; rejects off-allowlist and mislabelled files; blocks traversal', async () => {
    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', alice.cookie).expect(403);

    // A type off the allowlist is rejected.
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/x-msdownload')
      .send(Buffer.from('MZ\x90\x00 executable'))
      .expect(400);

    // A file CLAIMING to be an image but whose bytes are not — the signature
    // check must refuse it rather than store a script as an inline "image".
    await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('<script>alert(1)</script>'))
      .expect(400);

    await request(app.getHttpServer()).get('/api/v1/assets/..%2f..%2fkp.sqlite').set('Cookie', cookie).expect(404);
  });
});
