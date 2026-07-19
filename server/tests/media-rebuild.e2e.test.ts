/**
 * Media reindex on rebuild-from-git (ADR-0003, phase 1).
 *
 * The database is disposable: dropping it and rebuilding from the git-of-record
 * files must reproduce the media index too. Previously rebuild reconstructed
 * pages but never repopulated `images`/`image_links`, so after a rebuild the
 * admin media list was empty and orphan detection was dead. The fix indexes
 * from the git-tracked per-asset sidecar descriptors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ImagesService } from '../src/images/images.service.js';
import { AssetsService } from '../src/images/assets.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { descriptorSidecarName } from '../src/images/asset-descriptor.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('media reindex on rebuild', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let images: ImagesService;
  let assets: AssetsService;
  let rebuild: IndexRebuildService;
  let adminId: string;
  let assetsDir: string;

  beforeEach(async () => {
    // Point the asset store at a temp dir BEFORE the app builds AssetsService.
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-media-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    images = app.get(ImagesService);
    assets = app.get(AssetsService);
    rebuild = app.get(IndexRebuildService);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
  });

  it('writes a git-tracked sidecar descriptor on upload', async () => {
    const img = await images.upload(adminId, PNG, 'image/png');
    expect(existsSync(join(assetsDir, img.file))).toBe(true);
    expect(existsSync(join(assetsDir, descriptorSidecarName(img.file)))).toBe(true);

    const descriptors = assets.readDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ file: img.file, mime: 'image/png', byte_size: PNG.length });
  });

  it('repopulates images and image_links from sidecars on rebuild', async () => {
    const img = await images.upload(adminId, PNG, 'image/png');

    const concept = {
      path: 'concepts/has-image.md',
      content: [
        '---',
        'type: concept',
        'title: Has Image',
        'e3_id: page_hasimage',
        'e3_status: published',
        '---',
        '',
        `![shot](/assets/${img.file})`,
        '',
      ].join('\n'),
    };

    // Drop and rebuild the derived index from the files + sidecars alone.
    const report = await rebuild.rebuildFromFiles([concept], { actorId: adminId });
    expect(report.images).toBe(1);
    expect(report.pages).toBe(1);

    // The media index is back...
    const imageRows = await db.selectFrom('images').selectAll().execute();
    expect(imageRows).toHaveLength(1);
    expect(imageRows[0]!.file).toBe(img.file);
    // The stored file is the digest's 16-char prefix — content-addressing survives.
    expect(img.file.startsWith(imageRows[0]!.sha256.slice(0, 16))).toBe(true);

    // ...and the page→image link is reconstructed, so orphan detection works.
    const linkRows = await db.selectFrom('image_links').selectAll().execute();
    expect(linkRows).toHaveLength(1);

    const list = await images.list();
    expect(list[0]!.used_by).toBe(1);
    expect(list[0]!.orphan).toBe(false);
  });

  it('reassigns a descriptor authored by an unknown user to the rebuild actor', async () => {
    // Simulate a bundle from another instance: the sidecar names a user id that
    // does not exist here. The reindexed row must resolve to a real user, or the
    // post-rebuild foreign_key_check would fail.
    assets.writeDescriptor({
      schema_version: 1,
      file: 'deadbeefdeadbeef.png',
      sha256: 'deadbeef'.repeat(8),
      mime: 'image/png',
      byte_size: 68,
      original_filename: 'from-elsewhere.png',
      alt: null,
      provenance: 'uploaded',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'user_from_another_instance',
    });

    const report = await rebuild.rebuildFromFiles([], { actorId: adminId });
    expect(report.images).toBe(1);
    const row = await db.selectFrom('images').selectAll().executeTakeFirstOrThrow();
    expect(row.created_by).toBe(adminId);
  });
});
