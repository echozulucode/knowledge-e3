/**
 * Admin → Files (the admin UX review §4.9): the library list pages,
 * filters and totals in SQL, and a file's detail names the items that use it.
 *
 * "Used by N" was a dead end: the count said a file could not be deleted but not
 * which item held it. The detail route closes that, and because it names items
 * (titles of drafts, of private-topic items, of trashed items) it must stay
 * admin-only — the authorization cases here pin that nothing reaches a member
 * or an anonymous visitor.
 *
 * The site's own chrome (a pinned-topic cover) links no item, so it used to look
 * orphaned and be deletable; the site-asset case pins that it is neither.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';
import { resetServerConfig } from '../src/config/server-config.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PNG2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
// Sizes differ on purpose so "largest" has one right order.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('x'.repeat(400)), Buffer.from('\n%%EOF')]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('z'.repeat(300))]);
const CSV = Buffer.from('a,b\n1,2\n'.repeat(20));

interface Listed {
  id: string;
  file: string;
  url: string;
  mime: string;
  original_filename: string | null;
  used_by: number;
  site_asset: boolean;
  orphan: boolean;
}

describe('Files admin e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let items: ItemsService;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-files-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    items = app.get(ItemsService);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
    // The pinned-cover registry is module state; never let it outlive a test.
    resetServerConfig();
  });

  async function upload(bytes: Buffer, mime: string, filename: string): Promise<Listed> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/images?filename=${encodeURIComponent(filename)}`)
      .set('Cookie', cookie)
      .set('Content-Type', mime)
      .send(bytes)
      .expect(201);
    return res.body as Listed;
  }

  const list = async (qs = '') =>
    (await request(app.getHttpServer()).get(`/api/v1/admin/images${qs}`).set('Cookie', cookie).expect(200)).body as {
      images: Listed[];
      total: number;
      limit: number | null;
      offset: number;
      summary: { count: number; total_bytes: number; unused: number; reclaimable_bytes: number };
    };

  async function seedLibrary() {
    const png = await upload(PNG, 'image/png', 'Diagram.png');
    const pdf = await upload(PDF, 'application/pdf', 'research-notes.pdf');
    const zip = await upload(ZIP, 'application/zip', 'corpus.zip');
    const csv = await upload(CSV, 'text/csv', 'numbers.csv');
    await items.create(adminId, { title: 'Uses the diagram', body: `![d](${png.url})`, status: 'published' });
    return { png, pdf, zip, csv };
  }

  it('without parameters returns the whole library largest-first, plus totals', async () => {
    const { png, pdf, zip, csv } = await seedLibrary();
    const body = await list();
    expect([PDF.length, ZIP.length, CSV.length, PNG.length]).toEqual([...[PDF.length, ZIP.length, CSV.length, PNG.length]].sort((a, b) => b - a));
    expect(body.images.map((i) => i.id)).toEqual([pdf.id, zip.id, csv.id, png.id]);
    expect(body.total).toBe(4);
    expect(body.limit).toBeNull();
    expect(body.summary).toEqual({
      count: 4,
      total_bytes: PNG.length + PDF.length + ZIP.length + CSV.length,
      unused: 3,
      reclaimable_bytes: PDF.length + ZIP.length + CSV.length,
    });
  });

  it('filters by type, usage and name, and pages with a total', async () => {
    const { png, pdf, zip, csv } = await seedLibrary();
    const ids = (b: { images: Listed[] }) => b.images.map((i) => i.id).sort();

    expect(ids(await list('?type=image'))).toEqual([png.id]);
    expect(ids(await list('?type=document'))).toEqual([pdf.id, csv.id].sort());
    expect(ids(await list('?type=other'))).toEqual([zip.id]);
    expect(ids(await list('?usage=used'))).toEqual([png.id]);
    expect(ids(await list('?usage=unused'))).toEqual([pdf.id, zip.id, csv.id].sort());
    // Case-insensitive, literal substring of the download name.
    expect(ids(await list('?q=RESEARCH'))).toEqual([pdf.id]);
    expect((await list('?q=%25')).total).toBe(0);

    const byName = await list('?sort=name');
    expect(byName.images.map((i) => i.original_filename)).toEqual(['corpus.zip', 'Diagram.png', 'numbers.csv', 'research-notes.pdf']);

    const first = await list('?sort=name&limit=2');
    expect(first).toMatchObject({ total: 4, limit: 2, offset: 0 });
    expect(first.images.map((i) => i.original_filename)).toEqual(['corpus.zip', 'Diagram.png']);
    const second = await list('?sort=name&limit=2&offset=2');
    expect(second.images.map((i) => i.original_filename)).toEqual(['numbers.csv', 'research-notes.pdf']);
    // Totals describe the library, not the filtered page.
    expect((await list('?type=image&limit=1')).summary.count).toBe(4);

    const newest = await list('?sort=newest&limit=1');
    expect(newest.images[0]!.id).toBe(csv.id);

    for (const bad of ['?type=video', '?usage=maybe', '?sort=oldest', '?limit=0', '?offset=-1', '?limit=abc']) {
      await request(app.getHttpServer()).get(`/api/v1/admin/images${bad}`).set('Cookie', cookie).expect(400);
    }
  });

  it("names every item that uses a file — drafts, private topics and trashed items — with the uploader", async () => {
    const png = await upload(PNG, 'image/png', 'shared.png');
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Secret Ops', visibility: 'private' })
      .expect(201);
    const published = await items.create(adminId, { title: 'Public Guide', body: `![s](${png.url})`, status: 'published' });
    const draft = await items.create(adminId, { title: 'Draft Plan', body: `[file](${png.url})`, status: 'draft' });
    const hidden = await items.create(adminId, {
      title: 'Private Runbook',
      body: `![s](${png.url})`,
      status: 'published',
      frontmatter: { topic: 'Secret Ops' },
    });
    const trashed = await items.create(adminId, { title: 'Aardvark Old Note', body: `![s](${png.url})`, status: 'published' });
    await request(app.getHttpServer()).delete(`/api/v1/pages/${trashed.id}`).set('Cookie', cookie).expect(204);

    const res = await request(app.getHttpServer()).get(`/api/v1/admin/images/${png.id}`).set('Cookie', cookie).expect(200);
    const image = res.body.image;
    expect(image).toMatchObject({ id: png.id, used_by: 4, orphan: false, site_asset: false, created_by: adminId, created_by_username: 'admin' });
    // Live items by title, then the trashed one (it still blocks deletion).
    expect(image.used_by_items.map((i: { title: string }) => i.title)).toEqual(['Draft Plan', 'Private Runbook', 'Public Guide', 'Aardvark Old Note']);
    const byId = new Map(image.used_by_items.map((i: { item_id: string }) => [i.item_id, i]));
    expect(byId.get(draft.id)).toMatchObject({ status: 'draft', deleted: false });
    expect(byId.get(published.id)).toMatchObject({ status: 'published', deleted: false, slug: expect.any(String) });
    expect(byId.get(hidden.id)).toMatchObject({ topic: { name: 'Secret Ops', visibility: 'private' } });
    expect(byId.get(trashed.id)).toMatchObject({ deleted: true });

    await request(app.getHttpServer()).get('/api/v1/admin/images/does-not-exist').set('Cookie', cookie).expect(404);
  });

  it('gives a member and an anonymous visitor nothing — no titles, no counts', async () => {
    const png = await upload(PNG, 'image/png', 'shared.png');
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Secret Ops', visibility: 'private' })
      .expect(201);
    await items.create(adminId, {
      title: 'Private Runbook',
      body: `![s](${png.url})`,
      status: 'published',
      frontmatter: { topic: 'Secret Ops' },
    });

    const member = await seedUserAndLogin(app, 'curious-member', 'curious-member-password-123');
    for (const path of [`/api/v1/admin/images/${png.id}`, '/api/v1/admin/images', '/api/v1/admin/images?usage=used']) {
      const denied = await request(app.getHttpServer()).get(path).set('Cookie', member.cookie).expect(403);
      expect(JSON.stringify(denied.body)).not.toContain('Private Runbook');
      expect(denied.body.image).toBeUndefined();
      expect(denied.body.images).toBeUndefined();
      const anon = await request(app.getHttpServer()).get(path).expect(401);
      expect(JSON.stringify(anon.body)).not.toContain('Private Runbook');
    }
  });

  it("treats a pinned-topic cover as used by the site: not unused, not reclaimable, not deletable", async () => {
    const cover = await upload(PNG2, 'image/png', 'cover.png');
    const spare = await upload(PNG, 'image/png', 'spare.png');
    await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send({ name: 'ops', slug: 'ops' }).expect(201);
    await request(app.getHttpServer())
      .put('/api/v1/site/pinned')
      .set('Cookie', cookie)
      .send({ pinned: [{ topic: 'ops', cover: cover.url }] })
      .expect(200);

    const body = await list();
    const row = body.images.find((i) => i.id === cover.id)!;
    expect(row).toMatchObject({ used_by: 0, site_asset: true, orphan: false });
    expect(body.summary).toMatchObject({ count: 2, unused: 1, reclaimable_bytes: PNG.length });
    expect((await list('?usage=unused')).images.map((i) => i.id)).toEqual([spare.id]);
    expect((await list('?usage=used')).images.map((i) => i.id)).toEqual([cover.id]);

    const refused = await request(app.getHttpServer()).delete(`/api/v1/admin/images/${cover.id}`).set('Cookie', cookie).expect(409);
    expect(refused.body.message).toContain('used by the site');
    await request(app.getHttpServer()).delete(`/api/v1/admin/images/${spare.id}`).set('Cookie', cookie).expect(200);
  });
});
