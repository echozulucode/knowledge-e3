import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';
import { extractTarGz } from '../src/okf/tar.js';

// A tiny valid 1x1 PNG (magic bytes pass the attachment policy).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Collect a binary response body into a single Buffer. */
function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('OKF full-fidelity archive (assets) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-okf-assets-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
  });

  it('carries referenced assets in the archive and restores them on import', async () => {
    // 1. Upload an image.
    const up = (
      await request(app.getHttpServer())
        .post('/api/v1/images')
        .set('Cookie', cookie)
        .set('Content-Type', 'image/png')
        .query({ filename: 'diagram.png' })
        .send(PNG)
        .expect(201)
    ).body as { id: string; url: string; file: string };
    expect(up.url).toBe(`/assets/${up.file}`);

    // 2. Reference it from a published page.
    const page = await app.get(ItemsService).create(adminId, {
      title: 'Has Image',
      body: `# Has Image\n\n![diagram](${up.url})\n`,
      status: 'published',
    });

    // 3. Export the archive — it must carry the bytes AND the sidecar descriptor.
    const archive = (
      await request(app.getHttpServer())
        .get('/api/v1/okf/export/archive')
        .set('Cookie', cookie)
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
    ).body as Buffer;
    const entries = extractTarGz(archive);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain(`assets/${up.file}`);
    expect(paths).toContain(`assets/${up.file}.meta.json`);
    expect(entries.find((e) => e.path === `assets/${up.file}`)!.bytes.equals(PNG)).toBe(true);

    // 4. Simulate loss. The management API deliberately refuses to delete a
    // referenced asset, so first remove the live reference. The already-created
    // archive still contains the original page and asset.
    await app.get(ItemsService).update(
      { id: adminId, role: 'admin' },
      page.id,
      page.version_token,
      { body: '# Has Image\n\nAsset temporarily lost.\n' },
    );
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/images/${up.id}`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer()).get(up.url).set('Cookie', cookie).expect(404);

    // 5. Import the archive — assets are restored (bytes + descriptor + index row).
    const imp = (
      await request(app.getHttpServer())
        .post('/api/v1/okf/import/archive')
        .set('Cookie', cookie)
        .set('Content-Type', 'application/gzip')
        .send(archive)
        .expect(201)
    ).body as { assets_imported: number; assets_failed: number };
    expect(imp.assets_imported).toBeGreaterThanOrEqual(1);
    expect(imp.assets_failed).toBe(0);

    // 6. The asset serves again, byte-identical.
    const served = (
      await request(app.getHttpServer())
        .get(up.url)
        .set('Cookie', cookie)
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
    ).body as Buffer;
    expect(served.equals(PNG)).toBe(true);
  });
});
