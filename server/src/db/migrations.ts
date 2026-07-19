/**
 * Migrations for v0.1.
 *
 * In production (SQL Server) these would run via Umzug, with both `up` and `down`
 * scripts per spec section 13.3. For v0.1 we ship a single SQLite-targeted bootstrap
 * (used in dev and test) plus a parallel SQL Server reference (in `migrations.mssql.sql`)
 * to keep both dialects in sync.
 *
 * Discipline: every schema change in v0.1 is added here AND in the .mssql.sql file.
 * If the two drift, the production migration is wrong.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './schema.js';

export async function migrateSqlite(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  await db.schema
    .createTable('users')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('username', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('user'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('deleted_at', 'text')
    .execute();

  await db.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('ip_addr', 'text')
    .execute();

  await db.schema
    .createTable('spaces')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('archived_at', 'text')
    .execute();

  await sql`
    INSERT OR IGNORE INTO spaces (id, slug, name, description, created_at, updated_at, archived_at)
    VALUES ('space_default', 'default', 'Default', 'Default local knowledge topic', datetime('now'), datetime('now'), NULL)
  `.execute(db);

  await db.schema
    .createTable('pages')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('type', 'text')
    .addColumn('owner_id', 'text', (c) => c.references('users.id'))
    .addColumn('space_id', 'text', (c) => c.references('spaces.id').defaultTo('space_default'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('deleted_at', 'text')
    .addColumn('version_token', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('current_version_id', 'text')
    .execute();

  // `createTable(...).ifNotExists()` is not enough for dev databases that were
  // bootstrapped before topic support shipped. Bring those existing tables forward so
  // application writes can rely on the canonical schema without deleting data.
  await ensureColumn(db, 'pages', 'space_id', `ALTER TABLE pages ADD COLUMN space_id TEXT`);
  await sql`UPDATE pages SET space_id = 'space_default' WHERE space_id IS NULL`.execute(db);

  // Space visibility: 'public' | 'private', where private means "not exposed to
  // anonymous visitors". Signed-in users are unaffected by it — this composes
  // with the instance-wide read mode rather than duplicating it, so an admin can
  // open the instance to the internet while keeping named spaces off it.
  //
  // Defaults to 'public' on purpose: before this column existed, EVERY published
  // page was anonymously readable on a public instance, so 'public' is what the
  // data already means. Defaulting to 'private' would silently hide live content
  // on upgrade. Admins opt spaces out; nothing opts in behind their back.
  await ensureColumn(
    db,
    'spaces',
    'visibility',
    `ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
  );
  // `type` (OKF concept kind) drives "sections" (blogs, FAQs, best practices…),
  // mirrored from frontmatter into a column so it is cheaply filterable.
  await ensureColumn(db, 'pages', 'type', `ALTER TABLE pages ADD COLUMN type TEXT`);

  await db.schema
    .createTable('page_versions')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('body_markdown', 'text', (c) => c.notNull())
    .addColumn('raw_markdown', 'text', (c) => c.notNull())
    .addColumn('frontmatter_json', 'text', (c) => c.notNull())
    .addColumn('parsed_ast_json', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('parent_version_id', 'text')
    .execute();

  await db.schema
    .createTable('revision_mirror_state')
    .ifNotExists()
    .addColumn('page_id', 'text', (c) => c.primaryKey().references('pages.id'))
    .addColumn('backend', 'text')
    .addColumn('path', 'text')
    .addColumn('last_synced_version_token', 'integer')
    .addColumn('last_commit', 'text')
    .addColumn('last_ref', 'text')
    .addColumn('dirty', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('error', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('last_synced_at', 'text')
    .execute();

  await db.schema
    .createTable('space_repos')
    .ifNotExists()
    .addColumn('space_id', 'text', (c) => c.primaryKey().references('spaces.id'))
    .addColumn('remote_url', 'text', (c) => c.notNull())
    .addColumn('branch', 'text')
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable('page_tags')
    .ifNotExists()
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('tag', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('page_tags_pk', ['page_id', 'tag'])
    .execute();

  await db.schema
    .createTable('primary_categories')
    .ifNotExists()
    .addColumn('slug', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('archived_at', 'text')
    .execute();

  await db.schema
    .createTable('page_categories')
    .ifNotExists()
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('category', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('page_categories_pk', ['page_id', 'category'])
    .execute();

  await db.schema
    .createTable('groups')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('space_id', 'text', (c) => c.references('spaces.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('archived_at', 'text')
    .execute();
  await ensureColumn(db, 'groups', 'space_id', `ALTER TABLE groups ADD COLUMN space_id TEXT`);

  await db.schema
    .createTable('page_groups')
    .ifNotExists()
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('group_id', 'text', (c) => c.notNull().references('groups.id'))
    .addPrimaryKeyConstraint('page_groups_pk', ['page_id', 'group_id'])
    .execute();

  await db.schema
    .createTable('item_links')
    .ifNotExists()
    .addColumn('source_page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('target_ref', 'text', (c) => c.notNull())
    .addColumn('link_type', 'text', (c) => c.notNull())
    .addColumn('link_text', 'text', (c) => c.notNull())
    .addColumn('position', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('item_links_pk', ['source_page_id', 'position'])
    .execute();

  await db.schema
    .createTable('wikilinks')
    .ifNotExists()
    .addColumn('source_page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('target_title', 'text', (c) => c.notNull())
    .addColumn('position', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('wikilinks_pk', ['source_page_id', 'position'])
    .execute();

  await db.schema
    .createTable('images')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('file', 'text', (c) => c.notNull().unique())
    .addColumn('mime', 'text', (c) => c.notNull())
    .addColumn('byte_size', 'integer', (c) => c.notNull())
    .addColumn('sha256', 'text', (c) => c.notNull().unique())
    .addColumn('alt', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
    .execute();

  await db.schema
    .createTable('image_links')
    .ifNotExists()
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('image_id', 'text', (c) => c.notNull().references('images.id'))
    .addPrimaryKeyConstraint('image_links_pk', ['page_id', 'image_id'])
    .execute();
  // Per-repo import default for items whose frontmatter declares no lifecycle
  // state. Trust is a property of the SOURCE REPO, not of the instance, so this
  // belongs here rather than only in KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS (which
  // remains the instance-wide fallback). NULL = defer to that fallback.
  await ensureColumn(
    db,
    'space_repos',
    'default_status',
    `ALTER TABLE space_repos ADD COLUMN default_status TEXT`,
  );

  // Human-facing download name for an attachment. The stored `file` is an opaque
  // content-addressed name (ADR-0003); this is what a download is presented as.
  // NULL for pre-existing image rows (uploaded before attachments existed).
  await ensureColumn(
    db,
    'images',
    'original_filename',
    `ALTER TABLE images ADD COLUMN original_filename TEXT`,
  );

  // Publish date, stamped on the first draft->published transition and settable
  // from frontmatter (git-of-record). Distinct from updated_at so editing a
  // published post does not re-date or reorder it in a chronological feed (blogs).
  // Derived from frontmatter like every other column; NULL while unpublished.
  await ensureColumn(db, 'pages', 'published_at', `ALTER TABLE pages ADD COLUMN published_at TEXT`);
  // Backfill: existing published pages get their creation time as a sensible
  // first date, so a blog feed has something to order by immediately.
  await sql`UPDATE pages SET published_at = created_at WHERE published_at IS NULL AND status = 'published'`.execute(db);
  await db.schema
    .createIndex('idx_pages_published')
    .ifNotExists()
    .on('pages')
    .columns(['deleted_at', 'status', 'published_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_image_links_image')
    .ifNotExists()
    .on('image_links')
    .column('image_id')
    .execute();

  await db.schema
    .createTable('page_views')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('session_id', 'text')
    .addColumn('viewed_at', 'text', (c) => c.notNull())
    .addColumn('dwell_ms', 'integer')
    .execute();

  await db.schema
    .createTable('audit_log')
    .ifNotExists()
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('occurred_at', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text')
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('page_id', 'text')
    .addColumn('version_id', 'text')
    .addColumn('payload_json', 'text')
    .execute();

  await db.schema
    .createTable('bug_reports')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('reporter_id', 'text')
    .addColumn('page_id', 'text')
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('context_json', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('new'))
    .execute();

  // Indexes — match spec section 13.2
  await db.schema
    .createIndex('idx_pages_default_listing')
    .ifNotExists()
    .on('pages')
    .columns(['deleted_at', 'status', 'updated_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_pages_updated_at')
    .ifNotExists()
    .on('pages')
    .columns(['updated_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_pages_title')
    .ifNotExists()
    .on('pages')
    .column('title')
    .execute();
  await db.schema
    .createIndex('idx_page_versions_page_id')
    .ifNotExists()
    .on('page_versions')
    .columns(['page_id', 'created_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_item_links_target_ref')
    .ifNotExists()
    .on('item_links')
    .column('target_ref')
    .execute();
  await db.schema
    .createIndex('idx_item_links_source')
    .ifNotExists()
    .on('item_links')
    .column('source_page_id')
    .execute();
  await db.schema
    .createIndex('idx_item_links_text')
    .ifNotExists()
    .on('item_links')
    .column('link_text')
    .execute();
  await db.schema
    .createIndex('idx_wikilinks_target_title')
    .ifNotExists()
    .on('wikilinks')
    .column('target_title')
    .execute();
  await db.schema
    .createIndex('idx_wikilinks_source')
    .ifNotExists()
    .on('wikilinks')
    .column('source_page_id')
    .execute();
  await db.schema
    .createIndex('idx_page_views_page')
    .ifNotExists()
    .on('page_views')
    .columns(['page_id', 'viewed_at desc'])
    .execute();
  await db.schema
    .createIndex('idx_audit_log_occurred')
    .ifNotExists()
    .on('audit_log')
    .columns(['occurred_at desc'])
    .execute();

  // Composite indexes for the hot listing/backlink/lookup paths (issue P3-3 /
  // #59). All `ifNotExists`, so re-running the migration is a no-op.
  //
  // Sessions are looked up and deleted by user_id (session resolution and the
  // password-change session rotation) — without this it's a full scan.
  await db.schema
    .createIndex('idx_sessions_user')
    .ifNotExists()
    .on('sessions')
    .column('user_id')
    .execute();
  // Audit reads are typically "what did this actor do, most recent first".
  await db.schema
    .createIndex('idx_audit_log_actor_occurred')
    .ifNotExists()
    .on('audit_log')
    .columns(['actor_id', 'occurred_at desc'])
    .execute();
  // Backlinks filter item_links by (target_ref, link_type) together.
  await db.schema
    .createIndex('idx_item_links_target_type')
    .ifNotExists()
    .on('item_links')
    .columns(['target_ref', 'link_type'])
    .execute();
  // Space-scoped listing (browse-by-topic) filters space_id then orders by recency.
  await db.schema
    .createIndex('idx_pages_space_listing')
    .ifNotExists()
    .on('pages')
    .columns(['space_id', 'deleted_at', 'status', 'updated_at desc'])
    .execute();

  // System-wide configuration (admin-managed): one row per key, JSON value.
  // Holds e.g. the local password policy. Read/written via ConfigService.
  await db.schema
    .createTable('app_config')
    .ifNotExists()
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value_json', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('updated_by', 'text')
    .execute();

  // Per-user preferences (self-service): (user_id, key) → JSON value. Holds e.g.
  // the chosen theme so it follows the account across devices.
  await db.schema
    .createTable('user_prefs')
    .ifNotExists()
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value_json', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('user_prefs_pk', ['user_id', 'key'])
    .execute();

  // SQLite FTS5 virtual table for search.
  // Production (SQL Server) uses CONTAINSTABLE — see search service for the
  // dialect-aware adapter.
  await sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED,
      title,
      body,
      tags,
      tokenize = 'porter unicode61'
    )
  `.execute(db);
}

async function ensureColumn(
  db: Kysely<Database>,
  tableName: string,
  columnName: string,
  alterSql: string,
): Promise<void> {
  const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db);
  const exists = result.rows.some((row) => row.name === columnName);
  if (!exists) await sql.raw(alterSql).execute(db);
}
