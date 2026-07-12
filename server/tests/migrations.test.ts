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
});

async function tableColumns(db: Kysely<Database>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db);
  return result.rows.map((row) => row.name);
}
