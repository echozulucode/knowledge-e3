/**
 * Frontmatter cover images are public assets.
 *
 * Eric, 2026-09-12: *"I want the site to be browseable by anonymous users by
 * default … but all cover images should be accessible by anonymous users."*
 *
 * `/assets/<file>` is served by filename alone, so `image_links` is the ONLY
 * thing that makes an asset anonymously readable (`isPubliclyLinked`). Those
 * rows were derived from the page BODY only, and a `cover:` lives in the
 * frontmatter — so every cover on every published post 404'd for exactly the
 * reader it exists for, looked orphaned in the admin media list (and was
 * therefore deletable), and was dropped from a full-fidelity export.
 *
 * These tests assert the HTTP STATUS of the asset fetch, not the presence of an
 * `<img>`: a rendered `<img>` with a broken src is precisely the bug, so only
 * the byte fetch proves the fix.
 *
 * The gate itself is untouched and must stay untouched: "published page in a
 * non-private topic". Widening what counts as a *reference* must not widen what
 * counts as *public*, which is what the draft and private-topic cases pin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService } from '../src/items/items.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { migrateSqlite } from '../src/db/migrations.js';

/**
 * Distinct valid 1×1 PNGs. Uploads are content-addressed and deduped by sha256,
 * so a test that needs two independent assets needs two different byte strings.
 */
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4/58BAAT/Af9dfQKHAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z/AfAAQAAf8iCjrwAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+P8fAAMBAf+2EqLVAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC',
].map((b64) => Buffer.from(b64, 'base64'));

describe('frontmatter cover assets', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let cookie: string;
  let adminId: string;
  let items: ItemsService;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-cover-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    items = app.get(ItemsService);
    // The instance-wide default is already `public`; set it explicitly so these
    // tests are about the ASSET gate and nothing else.
    await request(app.getHttpServer())
      .put('/api/v1/admin/access')
      .set('Cookie', cookie)
      .send({ read_mode: 'public' })
      .expect(200);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
  });

  async function upload(bytes: Buffer) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(bytes)
      .expect(201);
    return res.body as { id: string; url: string; file: string };
  }

  it('serves a cover referenced only from frontmatter to an anonymous visitor', async () => {
    const img = await upload(PNGS[0]!);

    // The body does NOT mention the asset — a real blog post's cover never does.
    await items.create(adminId, {
      title: 'Post With Cover',
      body: 'No image embed anywhere in this body.\n',
      status: 'published',
      frontmatter: { cover: img.url },
    });

    const anon = await request(app.getHttpServer()).get(img.url).expect(200);
    // Public means shared-cacheable too: a CDN in front of the instance must be
    // allowed to keep the cover, or the fix only half works under load.
    expect(anon.headers['cache-control']).toContain('public');
  });

  it('accepts cover_image and hero_image, and nothing else', async () => {
    const [coverImage, heroImage, decoy] = [PNGS[1]!, PNGS[2]!, PNGS[3]!];
    const a = await upload(coverImage);
    const b = await upload(heroImage);
    const c = await upload(decoy);

    await items.create(adminId, {
      title: 'Cover Image Key',
      body: 'x',
      status: 'published',
      frontmatter: { cover_image: a.url },
    });
    await items.create(adminId, {
      title: 'Hero Image Key',
      body: 'x',
      status: 'published',
      frontmatter: { hero_image: b.url },
    });
    // The decoy names the asset from keys the renderers never read as an image.
    // Linking those would let arbitrary prose silently publish an asset AND pin
    // it undeletable, so the extractor's key set is enumerated, not sniffed.
    await items.create(adminId, {
      title: 'Mentions An Asset In Prose',
      body: 'x',
      status: 'published',
      frontmatter: { description: `see ${c.url}`, thumbnail: c.url, sources: [c.url] },
    });

    await request(app.getHttpServer()).get(a.url).expect(200);
    await request(app.getHttpServer()).get(b.url).expect(200);
    await request(app.getHttpServer()).get(c.url).expect(404);
  });

  it('ignores an off-instance cover URL', async () => {
    // `https://cdn…/x.png` names nothing on this instance, so it grants nothing
    // — the same rule `declareSiteAssets` applies to an off-instance logo.
    await items.create(adminId, {
      title: 'Remote Cover',
      body: 'x',
      status: 'published',
      frontmatter: { cover: 'https://cdn.example.com/assets/elsewhere.png' },
    });
    const links = await db.selectFrom('image_links').selectAll().execute();
    expect(links).toHaveLength(0);
  });

  it("keeps a draft's cover non-public", async () => {
    const img = await upload(PNGS[4]!);
    await items.create(adminId, {
      title: 'Unpublished Post',
      body: 'x',
      status: 'draft',
      frontmatter: { cover: img.url },
    });

    await request(app.getHttpServer()).get(img.url).expect(404);
    // Its author still sees it, and the response is not shared-cacheable.
    const asAuthor = await request(app.getHttpServer()).get(img.url).set('Cookie', cookie).expect(200);
    expect(asAuthor.headers['cache-control']).toContain('private');
  });

  it("keeps a private topic's cover non-public but readable by signed-in members", async () => {
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Closed Topic', visibility: 'private' })
      .expect(201);

    const img = await upload(PNGS[5]!);
    await items.create(adminId, {
      title: 'Private Post With Cover',
      body: 'x',
      status: 'published',
      frontmatter: { topic: 'Closed Topic', cover: img.url },
    });

    await request(app.getHttpServer()).get(img.url).expect(404);
    // Private narrows ANONYMOUS exposure only; it is not an ACL.
    const member = await seedUserAndLogin(app, 'cover-reader', 'cover-reader-password-123');
    await request(app.getHttpServer()).get(img.url).set('Cookie', member.cookie).expect(200);
  });

  it('counts a cover-only asset as used, so it is neither an orphan nor deletable', async () => {
    const img = await upload(PNGS[6]!);
    let list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200))
      .body.images;
    expect(list[0]).toMatchObject({ used_by: 0, orphan: true });

    await items.create(adminId, {
      title: 'Cover Only',
      body: 'x',
      status: 'published',
      frontmatter: { cover: img.url },
    });

    list = (await request(app.getHttpServer()).get('/api/v1/admin/images').set('Cookie', cookie).expect(200))
      .body.images;
    expect(list[0]).toMatchObject({ used_by: 1, orphan: false });

    // The same rows that publish it also protect it from a reclaim sweep.
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/images/${img.id}`)
      .set('Cookie', cookie)
      .expect(409);
  });

  it('drops the old link when the cover is swapped for another asset', async () => {
    const before = await upload(PNGS[0]!);
    const after = await upload(PNGS[5]!);
    const page = await items.create(adminId, {
      title: 'Cover Swap',
      body: 'x',
      status: 'published',
      frontmatter: { cover: before.url },
    });
    await request(app.getHttpServer()).get(before.url).expect(200);

    // The save path REBUILDS the page's whole link set rather than adding to it
    // (`syncImageLinksInTx` deletes first). Widening what counts as a reference
    // must not make a reference permanent: the replaced cover goes back to
    // non-public, and only the new one is served. Frontmatter keys themselves
    // are additive on update (`computeUpdate` merges), so a swap — not a
    // removal — is what an author can actually express here.
    await items.update({ id: adminId, role: 'admin' }, page.id, page.version_token, {
      frontmatter: { cover: after.url },
    });
    await request(app.getHttpServer()).get(after.url).expect(200);
    await request(app.getHttpServer()).get(before.url).expect(404);
  });

  it('rebuilds the cover link from the git files alone', async () => {
    const img = await upload(PNGS[1]!);
    const rebuild = app.get(IndexRebuildService);

    // A rebuild that linked fewer assets than a save would silently un-publish
    // every cover on the instance the first time disaster recovery ran.
    const concept = {
      path: 'concepts/has-cover.md',
      content: [
        '---',
        'type: concept',
        'title: Has Cover',
        'e3_id: page_hascover',
        'e3_status: published',
        `cover: ${img.url}`,
        '---',
        '',
        'Body with no embed.',
        '',
      ].join('\n'),
    };
    const report = await rebuild.rebuildFromFiles([concept], { actorId: adminId });
    expect(report.pages).toBe(1);

    const links = await db.selectFrom('image_links').selectAll().execute();
    expect(links).toHaveLength(1);
    await request(app.getHttpServer()).get(img.url).expect(200);
  });

  it('backfills covers linked before the fix shipped', async () => {
    const img = await upload(PNGS[2]!);
    const page = await items.create(adminId, {
      title: 'Published Before The Fix',
      body: 'x',
      status: 'published',
      frontmatter: { cover: img.url },
    });

    // Reproduce the pre-fix state exactly: the page and the asset both exist,
    // the frontmatter names the cover, and `image_links` has nothing — which is
    // what every instance's database looks like on upgrade.
    await db.deleteFrom('image_links').where('page_id', '=', page.id).execute();
    await request(app.getHttpServer()).get(img.url).expect(404);

    await migrateSqlite(db);

    const links = await db.selectFrom('image_links').where('page_id', '=', page.id).selectAll().execute();
    expect(links).toHaveLength(1);
    const anon = await request(app.getHttpServer()).get(img.url).expect(200);
    expect(anon.headers['cache-control']).toContain('public');

    // Idempotent: running it again inserts nothing new and throws nothing.
    await migrateSqlite(db);
    expect(await db.selectFrom('image_links').where('page_id', '=', page.id).selectAll().execute()).toHaveLength(1);
  });

  it('backfills without granting anything the gate would refuse', async () => {
    const draftImg = await upload(PNGS[3]!);
    const privateImg = await upload(PNGS[4]!);
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Backfill Closed', visibility: 'private' })
      .expect(201);

    await items.create(adminId, {
      title: 'Backfill Draft',
      body: 'x',
      status: 'draft',
      frontmatter: { cover: draftImg.url },
    });
    await items.create(adminId, {
      title: 'Backfill Private',
      body: 'x',
      status: 'published',
      frontmatter: { topic: 'Backfill Closed', cover: privateImg.url },
    });
    await db.deleteFrom('image_links').execute();

    await migrateSqlite(db);

    // The rows come back — the backfill is about REFERENCES — but the gate
    // still says no, because it asks about status and topic, not linkage.
    expect(await db.selectFrom('image_links').selectAll().execute()).toHaveLength(2);
    await request(app.getHttpServer()).get(draftImg.url).expect(404);
    await request(app.getHttpServer()).get(privateImg.url).expect(404);
  });
});
