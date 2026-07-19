/**
 * Attachment upload + download serving e2e (ADR-0003 §7).
 *
 * The "deep research" case: a knowledge item is Markdown plus a downloadable PDF
 * or zip for humans. Non-image attachments must be served as downloads (with a
 * human filename and nosniff), never inline; images stay inline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('deep research body'), Buffer.from('\n%%EOF')]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip payload')]);

describe('attachments e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-attach-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });
  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
  });

  function upload(bytes: Buffer, mime: string, filename?: string) {
    let url = '/api/v1/images';
    if (filename) url += `?filename=${encodeURIComponent(filename)}`;
    return request(app.getHttpServer()).post(url).set('Cookie', cookie).set('Content-Type', mime).send(bytes);
  }

  it('uploads a PDF and serves it as a named download with nosniff', async () => {
    const res = await upload(PDF, 'application/pdf', 'deep-research.pdf').expect(201);
    expect(res.body.mime).toBe('application/pdf');
    expect(res.body.original_filename).toBe('deep-research.pdf');
    expect(res.body.url).toBe(`/assets/${res.body.file}`);

    const served = await request(app.getHttpServer()).get(res.body.url).set('Cookie', cookie).expect(200);
    expect(served.headers['content-type']).toContain('application/pdf');
    expect(served.headers['content-disposition']).toBe('attachment; filename="deep-research.pdf"');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it('uploads a zip (opaque) and serves it as a download', async () => {
    const res = await upload(ZIP, 'application/zip', 'corpus.zip').expect(201);
    expect(res.body.mime).toBe('application/zip');

    const served = await request(app.getHttpServer()).get(res.body.url).set('Cookie', cookie).expect(200);
    expect(served.headers['content-disposition']).toContain('attachment');
    expect(served.headers['content-disposition']).toContain('corpus.zip');
  });

  it('serves an image inline (no Content-Disposition) but still nosniff', async () => {
    const res = await upload(PNG, 'image/png').expect(201);
    const served = await request(app.getHttpServer()).get(res.body.url).set('Cookie', cookie).expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['content-disposition']).toBeUndefined();
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it('falls back to the stored name when no original filename was given', async () => {
    const res = await upload(PDF, 'application/pdf').expect(201);
    expect(res.body.original_filename).toBeNull();
    const served = await request(app.getHttpServer()).get(res.body.url).set('Cookie', cookie).expect(200);
    expect(served.headers['content-disposition']).toBe(`attachment; filename="${res.body.file}"`);
  });

  it('admin list reports attachments largest-first with usage', async () => {
    await upload(PNG, 'image/png').expect(201);
    await upload(PDF, 'application/pdf', 'big.pdf').expect(201);
    const list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200)).body.images;
    expect(list.length).toBe(2);
    // Largest first — the reclaim view.
    expect(list[0].byte_size).toBeGreaterThanOrEqual(list[1].byte_size);
    for (const a of list) expect(a.orphan).toBe(true); // not referenced yet
  });
});
