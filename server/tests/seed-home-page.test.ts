import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeKysely, KYSELY } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import {
  FIRST_MVP_SEED_ITEMS,
  FIRST_MVP_SEED_SERIES,
  FIRST_MVP_SEED_UPDATES,
  HOME_PINNED_TOPICS,
  HOME_UPDATES_TAG,
  SEED_COVERS,
  SEED_SERIES_SLUG,
  seedCoverImages,
  seedCoverPng,
  seedCoverUrl,
  seedFirstMvpCorpus,
  seedHomePage,
  type SeedCoverKey,
} from '../src/seed.js';
import { PIN_ICONS, PINNED_TOPICS_KEY, SECTIONS_KEY } from '../src/config/config.service.js';
import { resetServerConfig } from '../src/config/server-config.js';
import { slugify } from '../src/common/slug.js';
import { makeApp, seedAdminAndLogin } from './helpers.js';

/**
 * `just seed` has to produce a front page that DEMONSTRATES the design rather
 * than an empty frame (Eric, 2026-09-12). The front page reads exactly three
 * things, and this asserts the seed writes all three: a cross-topic Updates
 * Section, items carrying its tag in more than one topic, and a pin list - plus,
 * since the first design review (home plan R2.5, R2.11), patterned covers on
 * some pins and some stories, and a series with its landing item.
 *
 * The idempotency assertions are the ones that would catch the tempting
 * mistakes: "write the same value again" is not idempotent for CONFIGURATION,
 * because a tenant who has retagged the Section or unpinned a topic would have
 * `just seed` silently undo it on the next run; and a second corpus run that
 * duplicated the series would put every part on the series page twice.
 */

async function freshDb(): Promise<Kysely<Database>> {
  const db: Kysely<Database> = makeKysely({ url: ':memory:', driver: 'sqlite' });
  await migrateSqlite(db);
  await db
    .insertInto('users')
    .values({
      id: 'u_seed',
      email: 'admin@local',
      username: 'admin',
      password_hash: 'x',
      role: 'admin',
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  return db;
}

/** Decode a truecolour, filter-0 PNG as `seedCoverPng` writes it. */
function decodeSeedPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatLength = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  return { width, height, pixels: raw };
}

describe('seed covers', () => {
  it('renders each cover byte-identically every time, so its content-addressed name is stable', () => {
    for (const key of Object.keys(SEED_COVERS) as SeedCoverKey[]) {
      expect(seedCoverPng(key).equals(seedCoverPng(key)), key).toBe(true);
    }
    const urls = (Object.keys(SEED_COVERS) as SeedCoverKey[]).map(seedCoverUrl);
    expect(new Set(urls).size, 'every topic gets its own cover').toBe(urls.length);
    for (const url of urls) expect(url).toMatch(/^\/assets\/[0-9a-f]{16}\.png$/);
  });

  it('draws a pattern, not a flat fill - the flat gradient read as a failed image', () => {
    for (const key of Object.keys(SEED_COVERS) as SeedCoverKey[]) {
      const { width, height, pixels } = decodeSeedPng(seedCoverPng(key));
      // 16:9, the lead story's own shape; a thumbnail centre-crops the motif.
      expect([width, height]).toEqual([800, 450]);
      const stride = width * 3 + 1;
      const light = SEED_COVERS[key].rgb.map((c) => c + Math.floor(((255 - c) * 62) / 100));
      let ink = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const px = y * stride + 1 + x * 3;
          if (pixels[px] === light[0] && pixels[px + 1] === light[1] && pixels[px + 2] === light[2]) ink += 1;
        }
      }
      // A real motif: a visible share of the image is drawn, and most is not.
      const share = ink / (width * height);
      expect(share, `${key} ink share`).toBeGreaterThan(0.05);
      expect(share, `${key} ink share`).toBeLessThan(0.6);
    }
  });
});

describe('seedHomePage', () => {
  let assetsDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    assetsDir = mkdtempSync(join(tmpdir(), 'ke3-seed-assets-'));
    previous = process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    else process.env['KNOWLEDGE_E3_ASSETS_DIR'] = previous;
    rmSync(assetsDir, { recursive: true, force: true });
  });

  it('configures a cross-topic Updates section and a pin list, once', async () => {
    const db = await freshDb();
    try {
      const first = await seedHomePage(db, 'u_seed');
      expect(first.sections).toBe(1);
      expect(first.pins).toBeGreaterThanOrEqual(2);
      expect(first.pins).toBeLessThanOrEqual(4);

      const sections = JSON.parse(
        (await db.selectFrom('app_config').select('value_json').where('key', '=', SECTIONS_KEY).executeTakeFirstOrThrow()).value_json,
      ) as Record<string, unknown>[];
      expect(sections).toHaveLength(1);
      // Renamed from News at Eric's request (R2.1); the feed's heading is this name.
      expect(sections[0]).toMatchObject({ name: 'Updates', slug: 'updates' });
      expect(HOME_UPDATES_TAG).toBe('update');
      // No `space`: that absence is what makes the feed span every topic.
      expect(sections[0]!['space']).toBeUndefined();
      expect(sections[0]!['tags']).toEqual([HOME_UPDATES_TAG]);
      // `order: 0` is the seed claiming the lead and leaving 1, 2, 3 free.
      expect(sections[0]!['order']).toBe(0);

      const pins = JSON.parse(
        (await db.selectFrom('app_config').select('value_json').where('key', '=', PINNED_TOPICS_KEY).executeTakeFirstOrThrow()).value_json,
      ) as Record<string, unknown>[];
      expect(pins.every((p) => typeof p['color'] === 'string')).toBe(true);
      // Every pin has an icon from the closed list, so a coverless card still
      // fills its thumbnail slot with something deliberate.
      expect(pins.every((p) => (PIN_ICONS as readonly string[]).includes(String(p['icon'])))).toBe(true);
      // Covers on SOME pins: a fresh instance shows the thumbnail and the icon
      // fallback side by side, as the same component.
      const withCover = pins.filter((p) => typeof p['cover'] === 'string');
      expect(withCover.length).toBeGreaterThanOrEqual(1);
      expect(withCover.length).toBeLessThan(pins.length);
      expect(first.covers).toBe(withCover.length);
      const images = await db.selectFrom('images').select(['file', 'mime', 'byte_size']).execute();
      for (const pin of withCover) {
        const cover = String(pin['cover']);
        expect(cover).toMatch(/^\/assets\/[0-9a-f]{16}\.png$/);
        const image = images.find((row) => `/assets/${row.file}` === cover);
        expect(image, `images row for ${cover}`).toBeTruthy();
        expect(image!.mime).toBe('image/png');
        expect(image!.byte_size).toBeGreaterThan(0);
        expect(existsSync(join(assetsDir, image!.file))).toBe(true);
      }
      // The written cover is exactly the seed's content-addressed cover for that topic.
      const seededPin = HOME_PINNED_TOPICS.find((p) => p.topic === withCover[0]!['topic'])!;
      expect(withCover[0]!['cover']).toBe(seedCoverUrl(seededPin.cover!));

      // Run two: a no-op. Not "the same value written again" — nothing written.
      const second = await seedHomePage(db, 'u_seed');
      expect(second).toEqual({ sections: 0, pins: 0, covers: 0 });

      // And a curator's edit survives the next run.
      await db
        .updateTable('app_config')
        .set({ value_json: JSON.stringify([]) })
        .where('key', '=', PINNED_TOPICS_KEY)
        .execute();
      await seedHomePage(db, 'u_seed');
      const afterEdit = JSON.parse(
        (await db.selectFrom('app_config').select('value_json').where('key', '=', PINNED_TOPICS_KEY).executeTakeFirstOrThrow()).value_json,
      ) as unknown[];
      expect(afterEdit, 'an empty pin list is a decision, and the seed must not overrule it').toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('seeds updates the Updates section can actually resolve, across several topics, some with covers', async () => {
    const db = await freshDb();
    try {
      await seedFirstMvpCorpus(db, 'u_seed');

      const tagged = await db
        .selectFrom('pages')
        .innerJoin('page_tags', 'page_tags.page_id', 'pages.id')
        .innerJoin('spaces', 'spaces.id', 'pages.space_id')
        .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .select(['pages.title', 'pages.published_at', 'pages.status', 'pages.type', 'spaces.slug as topic', 'page_versions.frontmatter_json'])
        .where('page_tags.tag', '=', HOME_UPDATES_TAG)
        .where('pages.deleted_at', 'is', null)
        .execute();

      expect(tagged).toHaveLength(FIRST_MVP_SEED_UPDATES.length);
      expect(tagged.every((row) => row.status === 'published')).toBe(true);
      // The `published_at` COLUMN, not only the frontmatter: it is what
      // `sort: 'published'` orders the feed by, so "newest first" is only
      // visible on the page if this is filled in.
      expect(tagged.every((row) => typeof row.published_at === 'string' && row.published_at !== '')).toBe(true);
      expect(tagged.every((row) => row.type === 'Blog Post')).toBe(true);
      // The whole point of a cross-topic section: a seed that tagged them all in
      // one topic would render identically and demonstrate nothing.
      expect(new Set(tagged.map((row) => row.topic)).size).toBeGreaterThan(1);

      // Covers on some stories and not others, so the feed shows both the
      // thumbnail row and the text-only row (R2.11).
      const covers = tagged.map((row) => (JSON.parse(row.frontmatter_json) as Record<string, unknown>)['cover']);
      const withCover = covers.filter((c): c is string => typeof c === 'string');
      expect(withCover.length).toBeGreaterThanOrEqual(1);
      expect(withCover.length).toBeLessThan(tagged.length);
      // The lead (newest) story has one, so the wide lead card shows it.
      const lead = [...tagged].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0]!;
      expect((JSON.parse(lead.frontmatter_json) as Record<string, unknown>)['cover']).toMatch(/^\/assets\/[0-9a-f]{16}\.png$/);
    } finally {
      await db.destroy();
    }
  });

  it('seeds a series: a published Series item and three ordered Blog Post parts', async () => {
    const db = await freshDb();
    try {
      await seedFirstMvpCorpus(db, 'u_seed');

      const series = await db
        .selectFrom('pages')
        .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .select(['pages.slug', 'pages.title', 'pages.status', 'pages.type', 'pages.published_at', 'page_versions.frontmatter_json'])
        .where('pages.slug', '=', SEED_SERIES_SLUG)
        .where('pages.deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      expect(SEED_SERIES_SLUG).toBe('getting-started');
      expect(slugify(FIRST_MVP_SEED_SERIES.title), 'the Series item slug is what the parts name').toBe(SEED_SERIES_SLUG);
      expect(series).toMatchObject({ title: 'Getting started', status: 'published', type: 'Series' });
      expect(series.published_at).toBeTruthy();
      const seriesFm = JSON.parse(series.frontmatter_json) as Record<string, unknown>;
      expect(seriesFm['description']).toBeTruthy();
      expect(seriesFm['cover']).toBe(seedCoverUrl('getting-started'));

      const parts = await db
        .selectFrom('pages')
        .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .innerJoin('spaces', 'spaces.id', 'pages.space_id')
        .select(['pages.title', 'pages.status', 'pages.type', 'pages.published_at', 'spaces.slug as topic', 'page_versions.frontmatter_json'])
        .where('page_versions.frontmatter_json', 'like', `%"series":"${SEED_SERIES_SLUG}"%`)
        .where('pages.deleted_at', 'is', null)
        .execute();
      expect(parts).toHaveLength(3);
      expect(parts.every((p) => p.status === 'published' && p.type === 'Blog Post' && !!p.published_at)).toBe(true);
      const ordered = parts
        .map((p) => ({ ...p, fm: JSON.parse(p.frontmatter_json) as Record<string, unknown> }))
        .sort((a, b) => Number(a.fm['series_order']) - Number(b.fm['series_order']));
      // A NUMBER after the YAML round trip, which is what the feed orders by.
      expect(ordered.map((p) => p.fm['series_order'])).toEqual([1, 2, 3]);
      expect(ordered.map((p) => p.title)).toEqual(FIRST_MVP_SEED_SERIES.parts.map((p) => p.title));
      // A Blog Post's publish requirements hold for the parts too.
      expect(ordered.every((p) => Array.isArray(p.fm['authors']) && (p.fm['authors'] as unknown[]).length > 0)).toBe(true);
      expect(new Set(ordered.map((p) => p.topic)).size, 'the series crosses topics').toBe(3);

      // Idempotent: a second run creates nothing, so the series page never lists a part twice.
      const again = await seedFirstMvpCorpus(db, 'u_seed');
      expect(again.itemsCreated).toBe(0);
      const count = await db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('n')).where('deleted_at', 'is', null).executeTakeFirstOrThrow();
      // +1 for the migration's own default-topic index item, if any.
      expect(Number(count.n)).toBeGreaterThanOrEqual(FIRST_MVP_SEED_ITEMS.length);
      const dupes = await db
        .selectFrom('pages')
        .select(['title', (eb) => eb.fn.countAll<number>().as('n')])
        .where('deleted_at', 'is', null)
        .groupBy('title')
        .having((eb) => eb.fn.countAll(), '>', 1)
        .execute();
      expect(dupes).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('writes every cover and links the seeded items that name one, once', async () => {
    const db = await freshDb();
    try {
      await seedFirstMvpCorpus(db, 'u_seed');
      const first = await seedCoverImages(db, 'u_seed');
      expect(first.covers).toBe(Object.keys(SEED_COVERS).length);
      const withCover = FIRST_MVP_SEED_ITEMS.filter((item) => 'cover' in item && item.cover);
      expect(first.linked).toBe(withCover.length);

      const links = await db
        .selectFrom('image_links')
        .innerJoin('pages', 'pages.id', 'image_links.page_id')
        .innerJoin('images', 'images.id', 'image_links.image_id')
        .select(['pages.title', 'images.file'])
        .execute();
      expect(links.map((l) => l.title).sort()).toEqual(withCover.map((i) => i.title).sort());
      for (const item of withCover) {
        const link = links.find((l) => l.title === item.title)!;
        expect(`/assets/${link.file}`).toBe(seedCoverUrl((item as { cover: SeedCoverKey }).cover));
      }

      const sidecar = readdirSidecar(assetsDir);
      const second = await seedCoverImages(db, 'u_seed');
      expect(second).toEqual({ covers: first.covers, linked: 0 });
      expect(await db.selectFrom('images').select('id').execute()).toHaveLength(Object.keys(SEED_COVERS).length);
      // The git-tracked sidecars are write-once: a re-seed must not churn them.
      expect(readdirSidecar(assetsDir)).toEqual(sidecar);
    } finally {
      await db.destroy();
    }
  });
});

/** Every sidecar descriptor's content, by name — to prove a re-run rewrote none. */
function readdirSidecar(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(SEED_COVERS) as SeedCoverKey[]) {
    const file = `${seedCoverUrl(key).slice('/assets/'.length)}.meta.json`;
    out[file] = readFileSync(join(dir, file), 'utf8');
  }
  return out;
}

/**
 * The seed through the product, as the reader the front page is for: an
 * anonymous visitor. A cover that loads only for its signed-in author is the
 * likeliest regression (R2.11), and only the byte fetch proves it does not.
 */
describe('a seeded instance, anonymously', () => {
  let app: INestApplication;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'ke3-seed-http-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
    resetServerConfig();
  });

  it('serves story covers, pin covers and the series in reading order', async () => {
    const { cookie, userId } = await seedAdminAndLogin(app);
    await request(app.getHttpServer()).put('/api/v1/admin/access').set('Cookie', cookie).send({ read_mode: 'public' }).expect(200);
    const db = app.get<Kysely<Database>>(KYSELY);
    await seedFirstMvpCorpus(db, userId);
    await seedCoverImages(db, userId);

    // Before any pin exists, so the grant can only be the story's image link.
    const stories = FIRST_MVP_SEED_UPDATES.filter((s) => s.cover);
    for (const story of stories) {
      const served = await request(app.getHttpServer()).get(seedCoverUrl(story.cover!)).expect(200);
      expect(served.headers['content-type']).toContain('image/png');
    }
    await request(app.getHttpServer()).get(seedCoverUrl(FIRST_MVP_SEED_SERIES.cover)).expect(200);

    await seedHomePage(db, userId);

    const pins = (await request(app.getHttpServer()).get('/api/v1/site/pinned').expect(200)).body.pinned as Record<string, unknown>[];
    expect(pins.map((p) => p['icon'])).toEqual(HOME_PINNED_TOPICS.map((p) => p.icon));
    // `architecture` has a cover only a pin uses: served purely on the pin's grant.
    const pinOnly = pins.find((p) => p['topic'] === 'architecture')!;
    await request(app.getHttpServer()).get(String(pinOnly['cover'])).expect(200);

    const feed = await request(app.getHttpServer()).get(`/api/v1/feed/series/${SEED_SERIES_SLUG}`).expect(200);
    const items = feed.body.items as { title: string; series_order: number | null }[];
    expect(items.map((i) => i.series_order)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.title)).toEqual(FIRST_MVP_SEED_SERIES.parts.map((p) => p.title));
  });
});
