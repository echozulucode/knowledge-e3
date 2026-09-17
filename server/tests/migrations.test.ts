import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';

describe('SQLite migrations', () => {
  it('adds internal space columns to existing dev databases bootstrapped before topic support shipped', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await db.schema
        .createTable('pages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('slug', 'text', (c) => c.notNull().unique())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
        .addColumn('owner_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('deleted_at', 'text')
        .addColumn('version_token', 'integer', (c) => c.notNull().defaultTo(1))
        .addColumn('current_version_id', 'text')
        .execute();

      await sql`
        INSERT INTO pages (
          id, slug, title, status, owner_id, created_at, updated_at,
          deleted_at, version_token, current_version_id
        ) VALUES (
          'page_old', 'old-page', 'Old Page', 'draft', NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          NULL, 1, NULL
        )
      `.execute(db);

      await migrateSqlite(db);

      const columns = await tableColumns(db, 'pages');
      expect(columns).toContain('space_id');

      const oldPage = await db
        .selectFrom('pages')
        .select(['id', 'space_id'])
        .where('id', '=', 'page_old')
        .executeTakeFirstOrThrow();
      expect(oldPage.space_id).toBe('space_default');

      await db
        .insertInto('pages')
        .values({
          id: 'page_new',
          slug: 'new-page',
          title: 'New Page',
          status: 'draft',
          owner_id: null,
          space_id: 'space_default',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          deleted_at: null,
          version_token: 1,
          current_version_id: null,
        })
        .execute();
    } finally {
      await db.destroy();
    }
  });

  it('adds the lifecycle/trust columns and content_outbox, and backfills the columns from the current version', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);
      expect(await tableColumns(db, 'pages')).toEqual(
        expect.arrayContaining([
          'lifecycle_status',
          'stale_after',
          'trust_tier',
          'last_verified_at',
          'generated_by',
          'superseded_by',
          'file_digest',
          'file_path',
          'source_id',
        ]),
      );
      expect(await tableColumns(db, 'content_outbox')).toEqual([
        'id',
        'page_id',
        'source_id',
        'file_path',
        'file_digest',
        'actor_id',
        'kind',
        'created_at',
        'processed_at',
        'error',
      ]);

      // Rows written before the columns existed (NULL trust_tier) are filled on
      // the next migration run; a row whose frontmatter is unreadable is skipped.
      const now = '2026-01-01T00:00:00.000Z';
      await db
        .insertInto('users')
        .values({ id: 'u1', email: 'u1@example.com', username: 'u1', password_hash: 'x', role: 'admin', created_at: now, deleted_at: null })
        .execute();
      const page = (id: string, versionId: string) => ({
        id,
        slug: id,
        title: id,
        status: 'published' as const,
        owner_id: 'u1',
        space_id: 'space_default',
        created_at: now,
        updated_at: now,
        deleted_at: null,
        version_token: 1,
        current_version_id: versionId,
      });
      const version = (id: string, pageId: string, frontmatterJson: string) => ({
        id,
        page_id: pageId,
        body_markdown: '',
        raw_markdown: '',
        frontmatter_json: frontmatterJson,
        parsed_ast_json: '{}',
        created_at: now,
        created_by: 'u1',
        parent_version_id: null,
      });
      await db.insertInto('pages').values([page('p_ok', 'v_ok'), page('p_bad', 'v_bad')]).execute();
      await db
        .insertInto('page_versions')
        .values([
          version('v_ok', 'p_ok', JSON.stringify({ title: 'p_ok', verified: [{ by: 'human:a', at: now }], stale_after: '2020-01-01', generated: { by: 'process:x' } })),
          version('v_bad', 'p_bad', 'not json'),
        ])
        .execute();

      await migrateSqlite(db);

      const rows = await db.selectFrom('pages').select(['id', 'lifecycle_status', 'stale_after', 'trust_tier', 'last_verified_at', 'generated_by']).orderBy('id').execute();
      expect(rows).toEqual([
        { id: 'p_bad', lifecycle_status: null, stale_after: null, trust_tier: null, last_verified_at: null, generated_by: null },
        { id: 'p_ok', lifecycle_status: 'stable', stale_after: '2020-01-01', trust_tier: 'human-reviewed', last_verified_at: now, generated_by: 'process:x' },
      ]);
    } finally {
      await db.destroy();
    }
  });

  /**
   * The `pages_fts` columns added since the original title/body/tags index:
   * description (reader UX plan §5.4), then Topic, category and group names and
   * aliases (R3.3). An FTS5 virtual table cannot be ALTERed, so the migration
   * rebuilds it — which makes "does it work on a database that already has rows"
   * the question that matters. This test builds the OLD four-column index, fills
   * it, and then runs the migration over it, twice.
   */
  it('rebuilds pages_fts with the description and taxonomy columns without losing what was already indexed', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);

      // Put the database back the way it looked before §5.4: pages_fts with
      // title/body/tags only, populated, and no backfill marker.
      await sql`DROP TABLE pages_fts`.execute(db);
      await sql`
        CREATE VIRTUAL TABLE pages_fts USING fts5(
          page_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61'
        )
      `.execute(db);

      const now = '2026-01-01T00:00:00.000Z';
      await db
        .insertInto('users')
        .values({ id: 'u1', email: 'u1@example.com', username: 'u1', password_hash: 'x', role: 'admin', created_at: now, deleted_at: null })
        .execute();
      const page = (id: string, versionId: string) => ({
        id,
        slug: id,
        title: id,
        status: 'published' as const,
        owner_id: 'u1',
        space_id: 'space_default',
        created_at: now,
        updated_at: now,
        deleted_at: null,
        version_token: 1,
        current_version_id: versionId,
      });
      const version = (id: string, pageId: string, frontmatterJson: string) => ({
        id,
        page_id: pageId,
        body_markdown: 'body text',
        raw_markdown: '',
        frontmatter_json: frontmatterJson,
        parsed_ast_json: '{}',
        created_at: now,
        created_by: 'u1',
        parent_version_id: null,
      });
      await db
        .insertInto('pages')
        .values([page('p_desc', 'v_desc'), page('p_summary', 'v_summary'), page('p_none', 'v_none'), page('p_bad', 'v_bad')])
        .execute();
      await db
        .insertInto('page_versions')
        .values([
          version('v_desc', 'p_desc', JSON.stringify({ description: 'Cordon and drain a node safely', aliases: ['Nodewrangler'] })),
          version('v_summary', 'p_summary', JSON.stringify({ summary: 'The older spelling of the same field' })),
          version('v_none', 'p_none', JSON.stringify({ title: 'p_none' })),
          version('v_bad', 'p_bad', 'not json'),
        ])
        .execute();
      // Taxonomy the old index never carried: a curated category whose LABEL
      // differs from its key, and a group.
      await db.insertInto('primary_categories').values({ slug: 'ops', name: 'Operations Quartermaster', created_at: now, updated_at: now, archived_at: null }).execute();
      await db.insertInto('page_categories').values({ page_id: 'p_desc', category: 'ops' }).execute();
      await db.insertInto('groups').values({ id: 'group_fleet', slug: 'fleet', name: 'Fleet Wranglers', description: null, space_id: null, created_at: now, updated_at: now, archived_at: null }).execute();
      await db.insertInto('page_groups').values({ page_id: 'p_summary', group_id: 'group_fleet' }).execute();
      for (const id of ['p_desc', 'p_summary', 'p_none', 'p_bad']) {
        await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${id}, ${id}, 'body text', 'atag')`.execute(db);
      }
      // More rows than the copy's batch size, so the rowid paging is exercised
      // rather than assumed: a batch loop that fails to advance never returns.
      const BULK = 600;
      for (let i = 0; i < BULK; i += 1) {
        await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${`p_bulk_${i}`}, 'bulk', 'body text', 'atag')`.execute(db);
      }

      await migrateSqlite(db);

      expect(await tableColumns(db, 'pages_fts')).toEqual(FTS_COLUMNS_NOW);
      // Nothing that was indexed before is gone, and no staging table is left behind.
      expect(await ftsMatch(db, 'body')).toHaveLength(4 + BULK);
      expect(await ftsMatch(db, 'atag')).toHaveLength(4 + BULK);
      expect(await ftsMatch(db, 'p_summary')).toEqual(['p_summary']);
      const leftovers = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name LIKE 'pages_fts_next%'`.execute(db);
      expect(leftovers.rows).toEqual([]);

      // The descriptions are backfilled from the rows that are already there —
      // no rebuild from git — under both frontmatter spellings, and a page whose
      // frontmatter will not parse is skipped rather than blocking boot.
      expect(await ftsMatch(db, 'cordon')).toEqual(['p_desc']);
      expect(await ftsMatch(db, 'spelling')).toEqual(['p_summary']);
      // …and so are the taxonomy names and aliases, from the joins.
      expect(await ftsMatch(db, 'quartermaster')).toEqual(['p_desc']);
      expect(await ftsMatch(db, 'wranglers')).toEqual(['p_summary']);
      expect(await ftsMatch(db, 'nodewrangler')).toEqual(['p_desc']);
      expect(await ftsMatch(db, 'topic:default')).toHaveLength(4);

      // Idempotent: the second run finds the column already there and leaves the
      // index alone.
      await migrateSqlite(db);
      expect(await tableColumns(db, 'pages_fts')).toEqual(FTS_COLUMNS_NOW);
      expect(await ftsMatch(db, 'cordon')).toEqual(['p_desc']);
      const rowCount = await sql<{ n: number }>`SELECT count(*) AS n FROM pages_fts`.execute(db);
      expect(Number(rowCount.rows[0]!.n)).toBe(4 + BULK);
    } finally {
      await db.destroy();
    }
  });

  it('brings the five-column (description) pages_fts forward, keeping the descriptions it already held', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);
      await sql`DROP TABLE pages_fts`.execute(db);
      await sql`
        CREATE VIRTUAL TABLE pages_fts USING fts5(
          page_id UNINDEXED, title, body, tags, description, tokenize = 'porter unicode61'
        )
      `.execute(db);
      // An orphan row (no `pages` row): its description exists only in the index,
      // so a copy that re-derived it from frontmatter would lose it.
      await sql`INSERT INTO pages_fts (page_id, title, body, tags, description) VALUES ('p_orphan', 'orphan', 'body', '', 'Heliograph summary')`.execute(db);

      await migrateSqlite(db);

      expect(await tableColumns(db, 'pages_fts')).toEqual(FTS_COLUMNS_NOW);
      expect(await ftsMatch(db, 'heliograph')).toEqual(['p_orphan']);
      const leftovers = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name LIKE 'pages_fts_next%'`.execute(db);
      expect(leftovers.rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

/** Kept as a separate describe so it reads as its own migration's record. */
describe('page_authors migration', () => {
  it('creates page_authors and backfills normalized authors from existing frontmatter, once', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);
      await sql`DROP TABLE page_authors`.execute(db);
      const now = '2026-01-01T00:00:00.000Z';
      await db.insertInto('users').values({ id: 'u1', email: 'u1@example.com', username: 'u1', password_hash: 'x', role: 'admin', created_at: now, deleted_at: null }).execute();
      const rows: [string, string][] = [
        ['p_list', JSON.stringify({ authors: ['Émilie du Châtelet', ' émilie  DU châtelet '], author: 'Voltaire' })],
        ['p_single', JSON.stringify({ author: 'Grace Hopper' })],
        ['p_none', JSON.stringify({ title: 'none' })],
        ['p_bad', 'not json'],
      ];
      for (const [id, fm] of rows) {
        await db.insertInto('pages').values({ id, slug: id, title: id, status: 'published', owner_id: 'u1', space_id: 'space_default', created_at: now, updated_at: now, deleted_at: null, version_token: 1, current_version_id: `v_${id}` }).execute();
        await db.insertInto('page_versions').values({ id: `v_${id}`, page_id: id, body_markdown: '', raw_markdown: '', frontmatter_json: fm, parsed_ast_json: '{}', created_at: now, created_by: 'u1', parent_version_id: null }).execute();
      }

      await migrateSqlite(db);
      const authors = async () => (await db.selectFrom('page_authors').selectAll().orderBy('page_id').orderBy('author').execute()).map((r) => `${r.page_id}:${r.author}`);
      expect(await authors()).toEqual(['p_list:voltaire', 'p_list:émilie du châtelet', 'p_single:grace hopper']);

      // Idempotent: a second boot neither duplicates nor re-derives.
      await db.deleteFrom('page_authors').where('page_id', '=', 'p_single').execute();
      await migrateSqlite(db);
      expect(await authors()).toEqual(['p_list:voltaire', 'p_list:émilie du châtelet']);

      const indexes = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_page_authors_author', 'idx_pages_last_verified')`.execute(db);
      expect(indexes.rows.map((r) => r.name).sort()).toEqual(['idx_page_authors_author', 'idx_pages_last_verified']);
    } finally {
      await db.destroy();
    }
  });
});

/** The live `pages_fts` column list the migrations must converge on. */
const FTS_COLUMNS_NOW = ['page_id', 'title', 'body', 'tags', 'description', 'topic', 'categories', 'groups', 'aliases'];

/** The page ids `pages_fts` matches for a term, sorted. */
async function ftsMatch(db: Kysely<Database>, term: string): Promise<string[]> {
  const result = await sql<{ page_id: string }>`SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${term}`.execute(db);
  return result.rows.map((row) => row.page_id).sort();
}

async function tableColumns(db: Kysely<Database>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return result.rows.map((row) => row.name);
}
