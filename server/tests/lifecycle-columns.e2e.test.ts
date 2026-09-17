/**
 * Indexed lifecycle/trust columns on `pages` (plan §7.4): every write path fills
 * them from frontmatter, readers (search, items, health) are unchanged, and a
 * rebuild/import fills the same columns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { deriveDisplayState } from '@echozedlabs/content-model';
import { trustTier } from '@echozedlabs/okf';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { PagesService } from '../src/pages/pages.service.js';
import { displayStateFromColumns, forViewer, lifecycleColumnsFrom, listForViewer, redactSourceForViewer } from '../src/pages/lifecycle-columns.js';
import { withLifecycleSignals } from '../src/query/knowledge-query.service.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';

const LIFECYCLE_COLUMNS = ['lifecycle_status', 'stale_after', 'trust_tier', 'last_verified_at', 'generated_by', 'superseded_by'] as const;
const HUMAN = { verified: [{ by: 'human:a', at: '2026-01-01T00:00:00.000Z' }] };

describe('display state from columns', () => {
  it('matches content-model derivation over frontmatter for every state', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const cases: [Record<string, unknown>, 'draft' | 'published'][] = [
      [{}, 'draft'],
      [{}, 'published'],
      [{ stale_after: '2020-01-01' }, 'published'],
      [{ stale_after: '2999-01-01' }, 'published'],
      [{ stale_after: '2020-01-01' }, 'draft'],
      [{ status: 'deprecated', superseded_by: 'new-way' }, 'published'],
      [{ status: 'deprecated', replaced_by: 'new-way' }, 'published'],
      [{ status: 'deprecated' }, 'published'],
      [{ status: 'deprecated', stale_after: '2020-01-01' }, 'published'],
      [{ status: 'draft', stale_after: '2020-01-01' }, 'published'],
    ];
    for (const [fm, status] of cases) {
      const expected = deriveDisplayState(fm, status, now);
      const columns = lifecycleColumnsFrom(fm, status);
      expect(displayStateFromColumns({ status, ...columns }, now), JSON.stringify([fm, status])).toBe(expected.display_state);
      expect(columns).toEqual({
        lifecycle_status: expected.lifecycle_status,
        stale_after: expected.stale_after,
        trust_tier: expected.trust_tier,
        last_verified_at: expected.last_verified_at,
        generated_by: expected.generated_by,
        superseded_by: expected.superseded_by,
      });
    }
    expect(lifecycleColumnsFrom({ status: 'deprecated', superseded_by: 'new-way' }, 'published')).toMatchObject({ lifecycle_status: 'deprecated', superseded_by: 'new-way' });
  });

  it('stores YAML dates the way readers see them (ISO strings, as in frontmatter_json)', () => {
    const columns = lifecycleColumnsFrom({ stale_after: new Date('2020-01-01T00:00:00.000Z') }, 'published');
    expect(columns.stale_after).toBe('2020-01-01T00:00:00.000Z');
  });

  it('withLifecycleSignals prefers the columns when the row carries them', () => {
    const base = { frontmatter: { stale_after: '2999-01-01' }, status: 'published' as const } as unknown as ItemView;
    const fromColumns = withLifecycleSignals({
      ...base,
      lifecycle_status: 'deprecated',
      stale_after: '2020-01-01',
      trust_tier: 'human-reviewed',
      last_verified_at: '2026-01-01T00:00:00.000Z',
      generated_by: null,
      superseded_by: 'new-way',
    });
    expect(fromColumns).toMatchObject({ display_state: 'superseded', lifecycle_status: 'deprecated', trust_tier: 'human-reviewed', stale: true, stale_after: '2020-01-01', superseded_by: 'new-way' });
    // No columns (rows written before them): frontmatter derivation as before.
    expect(withLifecycleSignals({ ...base, trust_tier: null })).toMatchObject({ display_state: 'published', lifecycle_status: 'stable', trust_tier: 'unverified', stale: false, stale_after: '2999-01-01' });
  });
});

/**
 * What a caller is told about where an item's file lives (reader UX plan §6,
 * R4.5). Pure, so the ladder is stated once here rather than inferred from the
 * two controllers that apply it.
 */
describe('source visibility by viewer', () => {
  const SOURCE = {
    id: 'topic:other-team-docs',
    role: 'reference',
    mode: 'read-only',
    path: 'concepts/retry-budget.md',
    url: 'https://github.com/other-team/docs/blob/main/concepts/retry-budget.md',
  } as const;
  const ADMIN = { id: 'u1', role: 'admin' } as never;
  const USER = { id: 'u2', role: 'user' } as never;

  it('hands an operator the whole ref, because Admin → Sources is where it is read', () => {
    expect(redactSourceForViewer({ ...SOURCE }, 'admin')).toEqual(SOURCE);
    expect(forViewer({ source: { ...SOURCE } }, ADMIN).source).toEqual(SOURCE);
  });

  it('keeps the door but never the repository path for a signed-in reader', () => {
    const view = forViewer({ source: { ...SOURCE } }, USER);
    expect(view.source).toEqual({ id: SOURCE.id, role: SOURCE.role, mode: SOURCE.mode, path: null, url: SOURCE.url });
  });

  it('offers an anonymous visitor neither the path nor a door they cannot open', () => {
    const view = forViewer({ source: { ...SOURCE } }, undefined);
    expect(view.source).toEqual({ id: SOURCE.id, role: SOURCE.role, mode: SOURCE.mode, path: null, url: null });
  });

  it('ships no source ref at all on a list row below an operator', () => {
    const rows = [{ id: 'a', source: { ...SOURCE } }, { id: 'b', source: null }];
    expect(listForViewer(rows, USER)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(listForViewer(rows, undefined)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(listForViewer(rows, ADMIN)).toEqual(rows);
  });
});

describe('lifecycle columns e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let pages: PagesService;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    pages = app.get(PagesService);
    db = app.get<Kysely<Database>>(KYSELY);
  });
  afterEach(async () => app.close());

  async function columnsOf(id: string) {
    return db.selectFrom('pages').select([...LIFECYCLE_COLUMNS, 'file_digest', 'file_path', 'source_id']).where('id', '=', id).executeTakeFirstOrThrow();
  }

  it('fills the columns on create and update; search, items and facets read the same values', async () => {
    const term = 'lifecyclecolumnterm';
    const plain = await pages.create(adminId, { title: 'Plain', body: term, status: 'published' });
    const stale = await pages.create(adminId, { title: 'Stale', body: term, status: 'published', frontmatter: { stale_after: '2000-01-01' } });
    const machine = await pages.create(adminId, { title: 'Machine', body: term, status: 'published', frontmatter: { generated: { by: 'process:x', at: '2026-01-01T00:00:00.000Z' } } });
    const human = await pages.create(adminId, { title: 'Human', body: term, status: 'published', frontmatter: HUMAN });
    const draft = await pages.create(adminId, { title: 'Draft', body: term, status: 'draft' });

    expect(await columnsOf(plain.id)).toEqual({
      lifecycle_status: 'stable',
      stale_after: null,
      trust_tier: 'unverified',
      last_verified_at: null,
      generated_by: null,
      superseded_by: null,
      file_digest: null,
      file_path: null,
      source_id: null,
    });
    expect(await columnsOf(stale.id)).toMatchObject({ lifecycle_status: 'stable', stale_after: '2000-01-01', trust_tier: 'unverified' });
    expect(await columnsOf(machine.id)).toMatchObject({ trust_tier: 'unverified', generated_by: 'process:x' });
    expect(await columnsOf(human.id)).toMatchObject({ trust_tier: 'human-reviewed', last_verified_at: '2026-01-01T00:00:00.000Z' });
    expect(await columnsOf(draft.id)).toMatchObject({ lifecycle_status: 'draft', trust_tier: 'unverified' });

    // An update re-derives from the new frontmatter.
    const admin = { id: adminId, role: 'admin' as const };
    await pages.update(admin, stale.id, stale.version_token, { frontmatter: { stale_after: '2999-01-01', ...HUMAN } });
    expect(await columnsOf(stale.id)).toMatchObject({ stale_after: '2999-01-01', trust_tier: 'human-reviewed' });
    await pages.update(admin, draft.id, draft.version_token, { status: 'published' });
    expect(await columnsOf(draft.id)).toMatchObject({ lifecycle_status: 'stable' });

    // Search hits and the trust facet are what frontmatter derivation gives.
    await pages.update(admin, stale.id, stale.version_token + 1, { frontmatter: { stale_after: '2000-01-01' } });
    const res = await request(app.getHttpServer()).get(`/api/v1/search?q=${term}`).set('Cookie', cookie).expect(200);
    const byTitle = new Map<string, { trust_tier: string; stale: boolean }>(res.body.results.map((r: { title: string; trust_tier: string; stale: boolean }) => [r.title, r]));
    expect(byTitle.get('Plain')).toMatchObject({ trust_tier: 'unverified', stale: false });
    expect(byTitle.get('Stale')).toMatchObject({ trust_tier: 'human-reviewed', stale: true });
    expect(byTitle.get('Machine')).toMatchObject({ trust_tier: 'unverified', stale: false });
    expect(byTitle.get('Human')).toMatchObject({ trust_tier: 'human-reviewed', stale: false });

    const expectedFacet = new Map<string, number>();
    for (const hit of res.body.results as { id: string }[]) {
      const row = await db
        .selectFrom('pages')
        .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .select('page_versions.frontmatter_json')
        .where('pages.id', '=', hit.id)
        .executeTakeFirstOrThrow();
      const tier = trustTier(JSON.parse(row.frontmatter_json) as Record<string, unknown>);
      expectedFacet.set(tier, (expectedFacet.get(tier) ?? 0) + 1);
    }
    const actualFacet = new Map<string, number>(res.body.facets.trust_tiers.map((f: { value: string; count: number }) => [f.value, f.count]));
    expect(actualFacet).toEqual(expectedFacet);

    // Item reads derive display_state exactly as before.
    const view = async (id: string) => (await request(app.getHttpServer()).get(`/api/v1/items/${id}`).set('Cookie', cookie).expect(200)).body.item;
    expect(await view(plain.id)).toMatchObject({ display_state: 'published', trust_tier: 'unverified', stale: false });
    expect(await view(stale.id)).toMatchObject({ display_state: 'needs-review', stale: true, stale_after: '2000-01-01' });
    expect(await view(machine.id)).toMatchObject({ display_state: 'published', generated_by: 'process:x' });
  });

  it('falls back to frontmatter for rows written without the columns', async () => {
    const term = 'nocolumnsterm';
    const human = await pages.create(adminId, { title: 'Legacy Row', body: term, status: 'published', frontmatter: { ...HUMAN, stale_after: '2000-01-01' } });
    await db
      .updateTable('pages')
      .set({ lifecycle_status: null, stale_after: null, trust_tier: null, last_verified_at: null, generated_by: null, superseded_by: null })
      .where('id', '=', human.id)
      .execute();
    const res = await request(app.getHttpServer()).get(`/api/v1/search?q=${term}`).set('Cookie', cookie).expect(200);
    expect(res.body.results[0]).toMatchObject({ id: human.id, trust_tier: 'human-reviewed', stale: true });
  });

  it('OKF import fills the columns on create and on update', async () => {
    const importer = app.get(OkfImportService);
    const actor = { id: adminId, role: 'admin' as const };
    const concept = (staleAfter: string) =>
      [
        '---',
        'type: Knowledge Page',
        'title: Imported Lifecycle',
        'e3_status: published',
        `stale_after: ${staleAfter}`,
        'verified:',
        '  - by: human:reviewer',
        '    at: 2026-02-01T00:00:00Z',
        'generated:',
        '  by: process:importer',
        '  at: 2026-01-01T00:00:00Z',
        '---',
        '',
        'Imported body.',
        '',
      ].join('\n');

    const first = await importer.importBundleFiles(actor, [{ path: 'concepts/imported-lifecycle.md', content: concept('2020-01-01') }]);
    expect(first.created).toBe(1);
    const id = first.ids[0]!;
    expect(await columnsOf(id)).toMatchObject({
      lifecycle_status: 'stable',
      stale_after: '2020-01-01',
      trust_tier: 'human-reviewed',
      last_verified_at: '2026-02-01T00:00:00.000Z',
      generated_by: 'process:importer',
    });

    const second = await importer.importBundleFiles(actor, [{ path: 'concepts/imported-lifecycle.md', content: concept('2999-01-01') }]);
    expect(second.updated).toBe(1);
    expect(await columnsOf(id)).toMatchObject({ stale_after: '2999-01-01', trust_tier: 'human-reviewed' });
  });

  it('a rebuild from git fills the columns from the latest revision', async () => {
    const items = app.get(ItemsService);
    const rebuild = app.get(IndexRebuildService);
    const dir = mkdtempSync(join(tmpdir(), 'e3-lifecycle-rebuild-'));
    const adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
    try {
      const created = await items.create(adminId, {
        title: 'Rebuilt Lifecycle',
        body: 'First revision.',
        status: 'published',
        frontmatter: { stale_after: '2020-01-01', ...HUMAN },
      });
      const v2 = await items.update({ id: adminId, role: 'admin' }, created.id, created.version_token, {
        body: 'Second revision.',
        frontmatter: { stale_after: '2999-01-01' },
      });
      for (const item of [created, v2]) {
        await adapter.afterItemVersionPersisted({
          itemId: item.id,
          versionId: item.current_version_id ?? 'unknown',
          versionToken: item.version_token,
          actorId: adminId,
          title: item.title,
          slug: item.slug,
          rawMarkdown: item.raw_markdown,
          status: item.status,
          spaceId: item.space_id,
          ownerId: item.owner_id,
          tags: item.tags,
          categories: item.categories,
          groups: item.groups,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        });
        await adapter.flush();
      }

      const report = await rebuild.rebuildFromDir(dir, { actorId: adminId });
      expect(report.pages).toBe(1);
      expect(await columnsOf(created.id)).toMatchObject({
        lifecycle_status: 'stable',
        stale_after: '2999-01-01',
        trust_tier: 'human-reviewed',
        last_verified_at: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
