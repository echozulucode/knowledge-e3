/**
 * `pages_fts` taxonomy columns, `sort=verified` and `GET /search/overview`
 * (reader UX plan §5.4 R3.3, §5.5, §5.7 R3.6).
 *
 * The FTS assertions look at the index directly as well as through `/search`,
 * because the taxonomy LIKE net can reach some of the same items: a test that
 * only searched could pass with the new columns missing. Category LABELS are
 * the clean witness — the net matches the stored key, never the label.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { sql, type Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { PagesService, type PageView } from '../src/pages/pages.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';
import { ItemsService } from '../src/items/items.service.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';
import { FTS_COLUMN_WEIGHTS, ftsBm25Sql } from '../src/search/fts-index.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };

describe('search index columns, verified sort and overview', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let pages: PagesService;
  let adminId: string;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId, cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    pages = app.get(PagesService);
  });
  afterEach(async () => app.close());

  const http = () => request(app.getHttpServer());

  async function page(title: string, body: string, frontmatter: Record<string, unknown> = {}, opts: { tags?: string[]; status?: 'draft' | 'published'; now?: string } = {}): Promise<PageView> {
    return pages.create(adminId, {
      title,
      body,
      status: opts.status ?? 'published',
      tags: opts.tags ?? [],
      frontmatter,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  async function searchTitles(q: string, query: Record<string, string> = {}): Promise<string[]> {
    const res = await http().get('/api/v1/search').query({ q, limit: '100', ...query }).set('Cookie', cookie).expect(200);
    return res.body.results.map((hit: { title: string }) => hit.title);
  }

  /** Page ids the FTS index itself matches — no taxonomy net involved. */
  async function ftsIds(match: string): Promise<string[]> {
    const rows = await sql<{ page_id: string }>`SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${match}`.execute(db);
    return rows.rows.map((row) => row.page_id).sort();
  }

  async function curate(slug: string, name: string): Promise<void> {
    await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ slug, name }).expect(201);
  }

  describe('taxonomy and aliases are FTS text', () => {
    it('finds an item by a word that is only in its Topic name', async () => {
      const item = await page('Tide Tables', 'Nothing about the place it is filed.', { topic: 'Heliotrope Station' });
      await page('Decoy', 'Unrelated.');
      expect(await ftsIds('topic:heliotrope')).toEqual([item.id]);
      expect(await searchTitles('heliotrope')).toEqual(['Tide Tables']);
    });

    it('finds an item by a word that is only in its primary category LABEL', async () => {
      await curate('ops-qm', 'Quartermaster Logistics');
      const item = await page('Crate Ledger', 'Counting boxes.', { categories: ['ops-qm'] });
      expect(await ftsIds('categories:quartermaster')).toEqual([item.id]);
      expect(await searchTitles('quartermaster')).toEqual(['Crate Ledger']);
    });

    it('finds an item by a word that is only in a group name', async () => {
      const item = await page('Roster', 'Who is on shift.', { groups: ['Fleet Wranglers'] });
      expect(await ftsIds('groups:wranglers')).toEqual([item.id]);
      expect(await searchTitles('wranglers')).toEqual(['Roster']);
    });

    it('finds an item by an alias, and says so', async () => {
      const item = await page('Message Queuing Telemetry Transport', 'A lightweight publish/subscribe protocol.', { aliases: ['MQTT', 'mosquitto bus'] });
      await page('Broker Sizing', 'How many clients a single node carries.');
      expect(await ftsIds('aliases:mqtt')).toEqual([item.id]);

      const res = await http().get('/api/v1/search').query({ q: 'mqtt' }).set('Cookie', cookie).expect(200);
      expect(res.body.results.map((hit: { title: string }) => hit.title)).toEqual(['Message Queuing Telemetry Transport']);
      expect(res.body.results[0].matched_fields).toContain('aliases');
      expect(res.body.results[0].reasons).toContain('Alias: MQTT');
      // A single-string alias is accepted as well as a list.
      const single = await page('Constrained Application Protocol', 'UDP request/response.', { aliases: 'CoAP' });
      expect(await ftsIds('aliases:coap')).toEqual([single.id]);
    });

    it('follows a category relabel: the new label finds the item and the old one no longer does', async () => {
      await curate('ops-qm', 'Quartermaster Logistics');
      const item = await page('Crate Ledger', 'Counting boxes.', { categories: ['ops-qm'] });
      await http().put('/api/v1/taxonomy/categories/ops-qm').set('Cookie', cookie).send({ name: 'Harbormaster Logistics' }).expect(200);

      expect(await ftsIds('categories:harbormaster')).toEqual([item.id]);
      expect(await ftsIds('categories:quartermaster')).toEqual([]);
      expect(await searchTitles('harbormaster')).toEqual(['Crate Ledger']);
      expect(await searchTitles('quartermaster')).toEqual([]);
    });

    it('follows a group rename: the new name finds the item', async () => {
      // The slug stays in the column (items reference it), so only the new
      // name is a clean witness; the old words still match through the slug.
      const item = await page('Watch Bill', 'Who stands which watch.', { groups: ['Fleet Wranglers'] });
      await http().put('/api/v1/taxonomy/groups/group_fleet-wranglers').set('Cookie', cookie).send({ name: 'Obsidian Lookouts' }).expect(200);

      expect(await ftsIds('groups:obsidian')).toEqual([item.id]);
      expect(await searchTitles('obsidian')).toEqual(['Watch Bill']);
    });

    it('follows a Topic rename in the index', async () => {
      const item = await page('Tide Tables', 'Nothing about the place it is filed.', { topic: 'Heliotrope Station' });
      const topicId = item.space_id!;
      await http().put(`/api/v1/topics/${topicId}`).set('Cookie', cookie).send({ name: 'Zircon Station' }).expect(200);

      expect(await ftsIds('topic:zircon')).toEqual([item.id]);
      expect(await ftsIds('topic:heliotrope')).toEqual([]);
      expect(await searchTitles('zircon')).toEqual(['Tide Tables']);
    });

    it('follows an item moving to another group and being soft-deleted and restored', async () => {
      const item = await page('Roster', 'Who is on shift.', { groups: ['Fleet Wranglers'] });
      await pages.update({ id: adminId, role: 'admin' }, item.id, item.version_token, {
        title: 'Roster',
        body: 'Who is on shift.',
        status: 'published',
        frontmatter: { groups: ['Dock Pilots'] },
      });
      expect(await ftsIds('groups:wranglers')).toEqual([]);
      expect(await ftsIds('groups:pilots')).toEqual([item.id]);

      await pages.softDelete({ id: adminId, role: 'admin' }, item.id);
      expect(await ftsIds('groups:pilots')).toEqual([]);
      await pages.restore({ id: adminId, role: 'admin' }, item.id);
      expect(await ftsIds('groups:pilots')).toEqual([item.id]);
    });

    it('reproduces every FTS column byte for byte when the index is rebuilt from git', async () => {
      await curate('ops-qm', 'Quartermaster Logistics');
      const items = app.get(ItemsService);
      const created = await items.create(adminId, {
        title: 'Message Queuing Telemetry Transport',
        body: 'A lightweight publish/subscribe protocol.',
        status: 'published',
        tags: ['iot'],
        frontmatter: { topic: 'Heliotrope Station', categories: ['ops-qm'], groups: ['Fleet Wranglers'], aliases: ['MQTT'], description: 'Pub/sub for constrained devices.' },
      });
      const dir = mkdtempSync(join(tmpdir(), 'e3-fts-rebuild-'));
      try {
        const adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
        await adapter.afterItemVersionPersisted({
          itemId: created.id,
          versionId: created.current_version_id ?? 'unknown',
          versionToken: created.version_token,
          actorId: adminId,
          title: created.title,
          slug: created.slug,
          rawMarkdown: created.raw_markdown,
          status: created.status,
          spaceId: created.space_id,
          ownerId: created.owner_id,
          tags: created.tags,
          categories: created.categories,
          groups: created.groups,
          createdAt: created.created_at,
          updatedAt: created.updated_at,
        });
        await adapter.flush();

        const row = async () =>
          (await sql<Record<string, string>>`SELECT page_id, title, tags, description, topic, categories, groups, aliases FROM pages_fts WHERE page_id = ${created.id}`.execute(db)).rows;
        const before = await row();
        expect(before).toEqual([
          {
            page_id: created.id,
            title: 'Message Queuing Telemetry Transport',
            tags: 'iot',
            description: 'Pub/sub for constrained devices.',
            topic: 'Heliotrope Station',
            categories: 'ops-qm Quartermaster Logistics',
            groups: 'Fleet Wranglers',
            aliases: 'MQTT',
          },
        ]);

        await app.get(IndexRebuildService).rebuildFromDir(dir, { actorId: adminId });

        expect(await row()).toEqual(before);
        expect(await searchTitles('quartermaster')).toEqual(['Message Queuing Telemetry Transport']);
        expect(await searchTitles('mqtt')).toEqual(['Message Queuing Telemetry Transport']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('weights the columns title > aliases > tags > taxonomy > description > body', () => {
      const w = FTS_COLUMN_WEIGHTS;
      expect(w.title).toBeGreaterThan(w.aliases);
      expect(w.aliases).toBeGreaterThan(w.tags);
      expect(w.tags).toBeGreaterThan(w.topic);
      expect(w.topic).toBe(w.categories);
      expect(w.categories).toBe(w.groups);
      expect(w.groups).toBeGreaterThan(w.description);
      expect(w.description).toBeGreaterThan(w.body);
      // page_id (UNINDEXED) takes the leading positional weight.
      expect(ftsBm25Sql().compile(db).sql).toBe('bm25(pages_fts, 0, 10, 1, 6, 3, 4, 4, 4, 8)');
    });
  });

  describe('sort=verified', () => {
    it('orders the most recently verified first and never-verified items last', async () => {
      const verifiedBy = (by: string, at: string) => ({ verified: [{ by, at }] });
      await page('Checked Long Ago', 'x', verifiedBy('human:ada', '2026-01-10T00:00:00Z'), { tags: ['vsort'], now: '2026-01-10T00:00:00.000Z' });
      await page('Never Checked, Edited Today', 'x', {}, { tags: ['vsort'], now: '2026-09-12T00:00:00.000Z' });
      await page('Checked Recently By A Machine', 'x', verifiedBy('agent:lint', '2026-08-01T00:00:00Z'), { tags: ['vsort'], now: '2026-08-01T00:00:00.000Z' });
      await page('Never Checked, Older', 'x', {}, { tags: ['vsort'], now: '2026-02-01T00:00:00.000Z' });

      const res = await http().get('/api/v1/search').query({ tag: 'vsort', sort: 'verified' }).set('Cookie', cookie).expect(200);
      expect(res.body.results.map((hit: { title: string }) => hit.title)).toEqual([
        'Checked Recently By A Machine',
        'Checked Long Ago',
        'Never Checked, Edited Today',
        'Never Checked, Older',
      ]);
      expect(res.body.total).toBe(4);
    });
  });

  describe('GET /search/overview', () => {
    async function seedLibrary(): Promise<void> {
      await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Open Harbor', slug: 'open-harbor' }).expect(201);
      await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Secret Harbor', slug: 'secret-harbor', visibility: 'private' }).expect(201);
      await curate('ops-qm', 'Quartermaster Logistics');
      const verified = (by: string, at: string) => ({ verified: [{ by, at }] });

      await page('Public Runbook', 'x', { topic: 'Open Harbor', type: 'Runbook', categories: ['ops-qm'], ...verified('human:ada', '2026-08-01T00:00:00Z') }, { tags: ['cranes', 'shared'], now: '2026-08-01T00:00:00.000Z' });
      await page('Public FAQ', 'x', { topic: 'Open Harbor', type: 'FAQ' }, { tags: ['shared'], now: '2026-09-01T00:00:00.000Z' });
      await page('Private Runbook', 'x', { topic: 'Secret Harbor', type: 'Runbook', categories: ['ops-qm'], ...verified('agent:lint', '2026-09-05T00:00:00Z') }, { tags: ['classified', 'shared'], now: '2026-09-05T00:00:00.000Z' });
      await page('Draft Notes', 'x', { topic: 'Open Harbor', type: 'Runbook' }, { tags: ['drafty'], status: 'draft', now: '2026-09-10T00:00:00.000Z' });
    }

    const labels = (values: { label: string; count: number }[]) => Object.fromEntries(values.map((v) => [v.label, v.count]));

    it('counts only what an anonymous reader may read: no private Topic, no drafts', async () => {
      await seedLibrary();
      const res = await http().get('/api/v1/search/overview').expect(200);
      const body = res.body;

      expect(body.total).toBe(2);
      expect(labels(body.topics)).toEqual({ 'Open Harbor': 2 });
      expect(labels(body.types)).toEqual({ Runbook: 1, FAQ: 1 });
      expect(labels(body.categories)).toEqual({ 'ops-qm': 1 });
      expect(labels(body.tags)).toEqual({ shared: 2, cranes: 1 });
      expect(body.recently_verified.map((i: { title: string }) => i.title)).toEqual(['Public Runbook']);
      expect(body.recently_updated.map((i: { title: string }) => i.title)).toEqual(['Public FAQ', 'Public Runbook']);
      expect(JSON.stringify(body)).not.toContain('Secret Harbor');
      expect(JSON.stringify(body)).not.toContain('classified');
    });

    it('includes private Topics for a signed-in admin, still published only, with Topic labels and trust signals on the items', async () => {
      await seedLibrary();
      const res = await http().get('/api/v1/search/overview').set('Cookie', cookie).expect(200);
      const body = res.body;

      expect(body.total).toBe(3);
      expect(labels(body.topics)).toEqual({ 'Open Harbor': 2, 'Secret Harbor': 1 });
      expect(labels(body.types)).toEqual({ Runbook: 2, FAQ: 1 });
      expect(body.tags.map((t: { label: string }) => t.label)).not.toContain('drafty');
      expect(body.recently_verified.map((i: { title: string }) => i.title)).toEqual(['Private Runbook', 'Public Runbook']);
      expect(body.recently_verified[0]).toMatchObject({
        status: 'published',
        type: 'Runbook',
        topic: 'secret-harbor',
        topic_name: 'Secret Harbor',
        trust_tier: 'machine-confirmed',
        categories: ['ops-qm'],
        tags: ['classified', 'shared'],
      });
      expect(body.recently_updated.map((i: { title: string }) => i.title)).toEqual(['Private Runbook', 'Public FAQ', 'Public Runbook']);
    });

    it('agrees with search: every count is what the same viewer\'s filtered search reports', async () => {
      await seedLibrary();
      const query = app.get(KnowledgeQueryService);
      const overview = await query.searchOverview(ANON);
      for (const topic of overview.topics) {
        const set = await query.search({ space: topic.label, status: 'published' }, ANON);
        expect({ topic: topic.label, total: set.total }).toEqual({ topic: topic.label, total: topic.count });
      }
      for (const tag of overview.tags) {
        const set = await query.search({ tag: tag.label }, ANON);
        expect({ tag: tag.label, total: set.total }).toEqual({ tag: tag.label, total: tag.count });
      }
      const all = await query.search({ sort: 'newest', limit: 100 }, ANON);
      expect(all.total).toBe(overview.total);
    });

    it('caps tags at 24, most used first', async () => {
      for (let i = 0; i < 30; i += 1) {
        const tags = Array.from({ length: i + 1 }, (_, n) => `t${String(n).padStart(2, '0')}`);
        await page(`Tagged ${i}`, 'x', {}, { tags });
      }
      const res = await http().get('/api/v1/search/overview').expect(200);
      expect(res.body.tags).toHaveLength(24);
      expect(res.body.tags[0]).toMatchObject({ label: 't00', count: 30 });
      expect(res.body.recently_updated).toHaveLength(6);
    });
  });
});
