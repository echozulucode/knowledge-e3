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
import { Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './schema.js';
import { lifecycleColumnsFrom } from '../pages/lifecycle-columns.js';
import { createFtsTableSql, ftsTaxonomyFor, FTS_COLUMNS, insertFtsRow, insertPageAuthors, reindexPageFts } from '../search/fts-index.js';
import { COVER_FRONTMATTER_KEYS, extractAssetFiles } from '../pages/image-links.js';

const logger = new Logger('migrations');

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
  // Topic presentation profile + landing page (plan §3.1). 'wiki' is today's
  // behaviour, so existing topics render exactly as they did before the columns.
  await ensureColumn(
    db,
    'spaces',
    'presentation',
    `ALTER TABLE spaces ADD COLUMN presentation TEXT NOT NULL DEFAULT 'wiki'`,
  );
  await ensureColumn(db, 'spaces', 'landing_markdown', `ALTER TABLE spaces ADD COLUMN landing_markdown TEXT`);
  await ensureColumn(db, 'spaces', 'start_here', `ALTER TABLE spaces ADD COLUMN start_here TEXT`);
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

  // Indexed lifecycle/trust columns (plan §7.4), derived from the current
  // version's frontmatter at write time so search/health read columns instead of
  // parsing every row's frontmatter_json. file_digest/file_path/source_id record
  // the canonical file a row derives from (write-path inversion, §7.3).
  for (const column of [
    'lifecycle_status',
    'stale_after',
    'trust_tier',
    'last_verified_at',
    'generated_by',
    'superseded_by',
    'file_digest',
    'file_path',
    'source_id',
  ]) {
    await ensureColumn(db, 'pages', column, `ALTER TABLE pages ADD COLUMN ${column} TEXT`);
  }
  await backfillLifecycleColumns(db);
  // `sort=verified` and the search overview's `recently_verified` read pages in
  // this order. SQLite sorts NULL lowest, so under DESC the never-verified rows
  // come last and a LIMIT walks the verified ones first, straight off the index.
  await db.schema
    .createIndex('idx_pages_last_verified')
    .ifNotExists()
    .on('pages')
    .columns(['last_verified_at desc', 'updated_at desc'])
    .execute();

  // Review policy (plan §8.2 `review`): the change request an item's edits are
  // staged on. Additive and nullable — an item in a `direct` source never has them.
  for (const column of [
    'review_state',
    'review_url',
    'review_branch',
    'review_change_id',
    'review_opened_at',
    'review_closed_at',
  ]) {
    await ensureColumn(db, 'pages', column, `ALTER TABLE pages ADD COLUMN ${column} TEXT`);
  }
  await db.schema
    .createIndex('idx_pages_review')
    .ifNotExists()
    .on('pages')
    .columns(['source_id', 'review_state'])
    .execute();

  // Durable outbox for the write-path inversion (plan §7.3): one row per indexed
  // file change, written with the index and marked processed once the git mirror
  // has committed the file. No FK on page_id: a 'delete' row outlives its page.
  await db.schema
    .createTable('content_outbox')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('page_id', 'text', (c) => c.notNull())
    .addColumn('source_id', 'text')
    .addColumn('file_path', 'text')
    .addColumn('file_digest', 'text')
    .addColumn('actor_id', 'text')
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('processed_at', 'text')
    .addColumn('error', 'text')
    .execute();
  await db.schema
    .createIndex('idx_content_outbox_pending')
    .ifNotExists()
    .on('content_outbox')
    .columns(['processed_at', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_image_links_image')
    .ifNotExists()
    .on('image_links')
    .column('image_id')
    .execute();
  await backfillCoverImageLinks(db);

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

  // Source registry (plan §7.4, Appendix B). Supersedes `space_repos` and
  // `app_config['git.main_remote']`: both are copied in once (below) and never
  // written again; RepoConfigService is a facade over this table from then on.
  await db.schema
    .createTable('content_sources')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('space_id', 'text', (c) => c.references('spaces.id'))
    .addColumn('local_dir', 'text', (c) => c.notNull())
    .addColumn('remote_url', 'text')
    .addColumn('branch', 'text')
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('mode', 'text', (c) => c.notNull())
    .addColumn('branch_prefix', 'text', (c) => c.defaultTo('e3/'))
    .addColumn('host_kind', 'text')
    .addColumn('host_base_url', 'text')
    .addColumn('host_token_env', 'text')
    .addColumn('sync_every_seconds', 'integer')
    .addColumn('webhook_secret_env', 'text')
    .addColumn('default_status', 'text')
    .addColumn('include_globs', 'text')
    .addColumn('exclude_globs', 'text')
    .addColumn('default_type', 'text')
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('last_synced_at', 'text')
    .addColumn('last_error', 'text')
    .execute();
  await db.schema
    .createIndex('idx_content_sources_space')
    .ifNotExists()
    .on('content_sources')
    .column('space_id')
    .execute();
  // Dual-writer detection (plan §8.3): two enabled writable sources may not
  // share a `(remote_url, branch)` pair, and no two enabled sources may share a
  // working tree. Deliberately NON-unique: the comparison is on the *normalized*
  // URL (trailing `.git`, scp-vs-ssh spelling, host case), which SQLite cannot
  // express, and the rule exempts disabled and `read-only` rows — so the
  // enforcement lives in `SourceRegistryService.assertNoCollision`. A unique
  // index here would also fail `migrateSqlite` on an existing installation that
  // already has a colliding pair, which nothing previously prevented.
  await db.schema
    .createIndex('idx_content_sources_remote')
    .ifNotExists()
    .on('content_sources')
    .columns(['remote_url', 'branch'])
    .execute();
  await db.schema
    .createIndex('idx_content_sources_local_dir')
    .ifNotExists()
    .on('content_sources')
    .column('local_dir')
    .execute();
  // Non-OKF Markdown import (plan §8.3), added after the table shipped.
  await ensureColumn(db, 'content_sources', 'include_globs', `ALTER TABLE content_sources ADD COLUMN include_globs TEXT`);
  await ensureColumn(db, 'content_sources', 'exclude_globs', `ALTER TABLE content_sources ADD COLUMN exclude_globs TEXT`);
  await ensureColumn(db, 'content_sources', 'default_type', `ALTER TABLE content_sources ADD COLUMN default_type TEXT`);
  await copyLegacyRepoConfig(db);

  // Conflict queue (plan §8.1) and inbound lint failures (§12 decision 6).
  // No FK on page_id: a conflict on a file that never indexed has none.
  await db.schema
    .createTable('sync_conflicts')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('source_id', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('page_id', 'text')
    .addColumn('ours', 'text')
    .addColumn('theirs', 'text')
    .addColumn('base', 'text')
    .addColumn('detected_at', 'text', (c) => c.notNull())
    .addColumn('resolved_at', 'text')
    .addColumn('resolution', 'text')
    .addColumn('resolved_by', 'text')
    .execute();
  await db.schema
    .createTable('sync_diagnostics')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('source_id', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('page_id', 'text')
    .addColumn('diagnostics_json', 'text', (c) => c.notNull())
    .addColumn('detected_at', 'text', (c) => c.notNull())
    .addColumn('cleared_at', 'text')
    .addColumn('commented_at', 'text')
    .execute();
  await ensureColumn(db, 'sync_diagnostics', 'commented_at', `ALTER TABLE sync_diagnostics ADD COLUMN commented_at TEXT`);

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

  // Personal access tokens (bearer auth for MCP clients / scripts). The raw
  // token is never stored — only its sha256 — and lookups are by that hash.
  await db.schema
    .createTable('api_tokens')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('scope', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text')
    .addColumn('last_used_at', 'text')
    .addColumn('revoked_at', 'text')
    .execute();
  await db.schema
    .createIndex('idx_api_tokens_user')
    .ifNotExists()
    .on('api_tokens')
    .column('user_id')
    .execute();

  // SQLite FTS5 virtual table for search.
  // Production (SQL Server) uses CONTAINSTABLE — see search service for the
  // dialect-aware adapter.
  //
  // `description` is indexed alongside title/body/tags (reader UX plan §5.4):
  // every publishable item carries one (the publish lint gate requires it), and
  // it is the best short summary of an item there is. Leaving it out made the
  // author's own one-line answer invisible to the search that answers questions.
  // Topic, categories, groups and aliases followed (R3.3). The column list and
  // the bm25 weights live in one place, `search/fts-index.ts`.
  await createFtsTableSql('pages_fts', { ifNotExists: true }).execute(db);
  await upgradeFtsColumns(db);
  await createPageAuthors(db);
  await repairDanglingPageGroups(db);

  // Sign-in throttle (issue 41). One row per attempt that was allowed to reach
  // password verification, in each bucket it counts against: `username` (the
  // normalized attempted name) and `ip`. In the database rather than in memory so
  // a restart does not wipe a lockout and every process on the same file shares
  // one count. `attempted_at` is epoch milliseconds so the sliding-window
  // comparison is an integer range scan on the composite index; rows older than
  // the window are pruned on write (LoginThrottleService), so the table holds at
  // most one window of traffic.
  await db.schema
    .createTable('login_attempts')
    .ifNotExists()
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('bucket', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('attempted_at', 'integer', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('idx_login_attempts_bucket_key')
    .ifNotExists()
    .on('login_attempts')
    .columns(['bucket', 'key', 'attempted_at'])
    .execute();
  await db.schema
    .createIndex('idx_login_attempts_attempted')
    .ifNotExists()
    .on('login_attempts')
    .column('attempted_at')
    .execute();
}

/**
 * Bring an existing `pages_fts` forward to the column set `FTS_COLUMNS` names —
 * from the original title/body/tags table, or from the title/body/tags/
 * description one, to title/body/tags/description/topic/categories/groups/
 * aliases.
 *
 * An FTS5 virtual table cannot be `ALTER`ed, so the index is rebuilt: a new
 * table beside the old one, every existing row copied across with the missing
 * columns filled in, then the swap. Three properties matter, because
 * migrations run in-process at boot and a half-applied one is an outage:
 *
 *   - **Atomic.** The whole rebuild is one transaction. FTS5's storage is
 *     ordinary SQLite tables, DDL included, so it either lands or it does not —
 *     there is no state in which `pages_fts` exists with only some of its rows.
 *   - **Idempotent.** Guarded on the live column list already being the current
 *     one, so the next boot (and every boot after) does nothing.
 *   - **Linear.** The index is copied in batches by rowid, and each batch's
 *     missing text (description, Topic, category and group names, aliases) is
 *     read with a handful of set-based joins over that batch's page ids —
 *     frontmatter and taxonomy only, never bodies. `UPDATE … WHERE page_id = ?`
 *     would have been the obvious backfill and is quadratic: `page_id` is
 *     UNINDEXED, so each one scans the table.
 *
 * Title, body and tags come from the existing index, never from git: this is
 * columns being added to an index that is already correct, not the
 * disaster-recovery rebuild `IndexRebuildService` performs. (A row whose page
 * is gone is carried across as it was; this migration adds columns, it does not
 * garbage-collect.)
 */
async function upgradeFtsColumns(db: Kysely<Database>): Promise<void> {
  const existing = await ftsColumnNames(db);
  const current = ['page_id', ...FTS_COLUMNS];
  if (existing.length === current.length && existing.every((name, i) => name === current[i])) return;
  const hadDescription = existing.includes('description');

  await db.transaction().execute(async (tx) => {
    // Guard against a staging table left by an interrupted earlier attempt.
    await sql`DROP TABLE IF EXISTS pages_fts_next`.execute(tx);
    await createFtsTableSql('pages_fts_next').execute(tx);

    let after = 0;
    for (;;) {
      const batch = await sql<FtsRow>`
        SELECT rowid AS rowid, page_id, title, body, tags${sql.raw(hadDescription ? ', description' : '')}
        FROM pages_fts WHERE rowid > ${after} ORDER BY rowid LIMIT ${FTS_COPY_BATCH}
      `.execute(tx);
      if (!batch.rows.length) break;
      const extra = await ftsTaxonomyFor(tx, batch.rows.map((row) => row.page_id));
      for (const row of batch.rows) {
        const text = extra.get(row.page_id);
        await insertFtsRow(tx, 'pages_fts_next', {
          page_id: row.page_id,
          title: row.title,
          body: row.body,
          tags: row.tags,
          // Keep what an existing description column held; backfill it from
          // frontmatter only when the column is new.
          description: hadDescription ? (row.description ?? '') : (text?.description ?? ''),
          topic: text?.topic ?? '',
          categories: text?.categories ?? '',
          groups: text?.groups ?? '',
          aliases: text?.aliases ?? '',
        });
        after = row.rowid;
      }
    }

    await sql`DROP TABLE pages_fts`.execute(tx);
    await sql`ALTER TABLE pages_fts_next RENAME TO pages_fts`.execute(tx);
  });
  logger.log(`pages_fts rebuilt with columns ${FTS_COLUMNS.join(', ')}`);
}

/**
 * `page_authors`: the `author:` filter's lookup (reader UX plan §5.2). Authors
 * live in frontmatter JSON, and matching them there would mean parsing every
 * row's JSON per query — and folding case with SQLite's ASCII-only `lower()`.
 * So the normalized names are stored, indexed by name.
 *
 * Created and backfilled in ONE transaction when the table is absent, so a boot
 * interrupted mid-backfill leaves no table and the next boot starts over, rather
 * than leaving an empty table that looks migrated. Backfill reads frontmatter
 * and taxonomy in batches of page ids (never bodies).
 */
async function createPageAuthors(db: Kysely<Database>): Promise<void> {
  const existing = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page_authors'`.execute(db);
  if (existing.rows.length) return;
  await db.transaction().execute(async (tx) => {
    await tx.schema
      .createTable('page_authors')
      .addColumn('page_id', 'text', (c) => c.notNull().references('pages.id'))
      .addColumn('author', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('page_authors_pk', ['page_id', 'author'])
      .execute();
    await tx.schema.createIndex('idx_page_authors_author').on('page_authors').columns(['author', 'page_id']).execute();

    let after = '';
    for (;;) {
      const batch = await tx
        .selectFrom('pages')
        .select('id')
        .where('id', '>', after)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .limit(FTS_COPY_BATCH)
        .execute();
      if (!batch.length) break;
      const text = await ftsTaxonomyFor(tx, batch.map((row) => row.id));
      await insertPageAuthors(tx, [...text].map(([page_id, entry]) => ({ page_id, authors: entry.authors })));
      after = batch[batch.length - 1]!.id;
    }
  });
}

/** Rows are copied in batches so a large index never sits in memory at once. */
const FTS_COPY_BATCH = 500;

interface FtsRow {
  rowid: number;
  page_id: string;
  title: string;
  body: string;
  tags: string;
  description?: string;
}

/** The live `pages_fts` column names, in declaration order. */
async function ftsColumnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ name: string }>`PRAGMA table_info(pages_fts)`.execute(db);
  return result.rows.map((row) => row.name);
}

/** app_config marker: the one-time copy below has run. */
const LEGACY_REPOS_COPIED_KEY = 'migrations.content_sources_copied';

/**
 * One-time copy of the pre-registry repo configuration into `content_sources`:
 * every `space_repos` row becomes `topic:<slug>` (authoritative, direct, at
 * `topics/<slug>`) and `app_config['git.main_remote']` becomes `main`. Guarded
 * by a marker so a binding the admin later removes from the registry does not
 * come back on the next boot; rows that already exist are left alone.
 */
async function copyLegacyRepoConfig(db: Kysely<Database>): Promise<void> {
  const done = await db
    .selectFrom('app_config')
    .select('key')
    .where('key', '=', LEGACY_REPOS_COPIED_KEY)
    .executeTakeFirst();
  if (done) return;
  const now = new Date().toISOString();

  const repos = await db
    .selectFrom('space_repos as r')
    .innerJoin('spaces as s', 's.id', 'r.space_id')
    .select(['r.space_id', 'r.remote_url', 'r.branch', 'r.enabled', 'r.default_status', 'r.created_at', 'r.updated_at', 's.slug'])
    .execute();
  for (const r of repos) {
    await db
      .insertInto('content_sources')
      .values({
        id: `topic:${r.slug}`,
        space_id: r.space_id,
        local_dir: `topics/${r.slug}`,
        remote_url: r.remote_url,
        branch: r.branch,
        role: 'authoritative',
        mode: 'direct',
        branch_prefix: 'e3/',
        host_kind: null,
        host_base_url: null,
        host_token_env: null,
        sync_every_seconds: null,
        webhook_secret_env: null,
        default_status: r.default_status,
        include_globs: null,
        exclude_globs: null,
        default_type: null,
        enabled: r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_synced_at: null,
        last_error: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  const main = await db
    .selectFrom('app_config')
    .select('value_json')
    .where('key', '=', 'git.main_remote')
    .executeTakeFirst();
  if (main) {
    try {
      const cfg = JSON.parse(main.value_json) as { remote_url?: string; branch?: string | null; enabled?: boolean };
      if (cfg.remote_url) {
        await db
          .insertInto('content_sources')
          .values({
            id: 'main',
            space_id: null,
            local_dir: 'main',
            remote_url: cfg.remote_url,
            branch: cfg.branch ?? null,
            role: 'authoritative',
            mode: 'direct',
            branch_prefix: 'e3/',
            host_kind: null,
            host_base_url: null,
            host_token_env: null,
            sync_every_seconds: null,
            webhook_secret_env: null,
            default_status: null,
            include_globs: null,
            exclude_globs: null,
            default_type: null,
            enabled: cfg.enabled === false ? 0 : 1,
            created_at: now,
            updated_at: now,
            last_synced_at: null,
            last_error: null,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    } catch (err) {
      logger.warn(`could not copy git.main_remote into the source registry: ${(err as Error).message}`);
    }
  }

  await db
    .insertInto('app_config')
    .values({ key: LEGACY_REPOS_COPIED_KEY, value_json: 'true', updated_at: now, updated_by: null })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
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

/**
 * One-time fill of the lifecycle columns for rows written before they existed
 * (`trust_tier IS NULL`), from each page's current frontmatter. Plain per-row
 * updates: SQLite, tens of thousands of rows at most. A row whose frontmatter
 * cannot be read is logged and skipped so it cannot block boot — readers fall
 * back to frontmatter for it.
 */
async function backfillLifecycleColumns(db: Kysely<Database>): Promise<void> {
  const rows = await db
    .selectFrom('pages')
    .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
    .select(['pages.id as id', 'pages.status as status', 'page_versions.frontmatter_json as frontmatter_json'])
    .where('pages.trust_tier', 'is', null)
    .execute();
  for (const row of rows) {
    try {
      const frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
      await db
        .updateTable('pages')
        .set(lifecycleColumnsFrom(frontmatter, row.status))
        .where('id', '=', row.id)
        .execute();
    } catch (err) {
      logger.warn(`lifecycle column backfill skipped page ${row.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * One-time fill of the `image_links` rows a frontmatter `cover:` should always
 * have had.
 *
 * `image_links` is rebuilt per page on save, and until this release the rebuild
 * read the BODY only — so a cover produced no row, `isPubliclyLinked` was false
 * for it, and `/assets/<file>` 404'd for the anonymous visitor the cover exists
 * for. Fixing the extractor alone would only repair posts saved *after* the
 * upgrade; every cover already published would stay invisible until someone
 * happened to re-save its page. That is not a fix, so the existing rows are
 * brought forward here.
 *
 * ADDITIVE ONLY, and deliberately so: this inserts the missing (page_id,
 * image_id) pairs and never deletes one. Deletion is the save path's job — it
 * owns the page's full link set inside the write transaction and can tell a
 * removed reference from one this backfill simply cannot see. A migration that
 * pruned here would race that ownership for no benefit.
 *
 * It grants nothing on its own: `isPubliclyLinked` still requires a published
 * page in a non-private topic, so a draft's cover and a private topic's cover
 * gain a link row and stay 404 for anonymous callers exactly as before.
 *
 * The LIKE is a cheap superset filter so a normal boot touches only pages whose
 * current frontmatter even mentions a cover key; `COVER_FRONTMATTER_KEYS` then
 * decides for real. After the first run every insert is a conflict no-op.
 */
async function backfillCoverImageLinks(db: Kysely<Database>): Promise<void> {
  const rows = await db
    .selectFrom('pages')
    .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
    .select(['pages.id as id', 'page_versions.frontmatter_json as frontmatter_json'])
    .where('pages.deleted_at', 'is', null)
    .where((eb) =>
      eb.or(COVER_FRONTMATTER_KEYS.map((key) => eb('page_versions.frontmatter_json', 'like', `%"${key}"%`))),
    )
    .execute();
  for (const row of rows) {
    try {
      const frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
      // Body deliberately empty: body references already have their rows, and
      // re-deriving them here would only widen what this touches.
      const files = extractAssetFiles('', frontmatter);
      if (files.length === 0) continue;
      const imgs = await db.selectFrom('images').select(['id']).where('file', 'in', files).execute();
      if (imgs.length === 0) continue;
      await db
        .insertInto('image_links')
        .values(imgs.map((i) => ({ page_id: row.id, image_id: i.id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    } catch (err) {
      logger.warn(`cover image-link backfill skipped page ${row.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Re-point `page_groups` rows the old frontmatter sync left dangling (issue 117).
 *
 * The sync linked every frontmatter group as `group_<slug>`, but a group an
 * admin created for one topic has the id `group_<topic>_<slug>`. Where the
 * foreign key was enforced that save failed; where it was not (a database
 * written with `foreign_keys` off), the link named an id no row has, so the
 * item was missing from the group's count, facet and FTS `groups` column. The
 * sync now resolves the id by slug, which fixes every save from here on; this
 * brings the rows already written forward without waiting for a re-save.
 *
 * An index rebuild does NOT do this job: it wipes `groups` and recreates each
 * one from frontmatter as `group_<slug>`, dropping the admin's topic scope and
 * description — so the repair belongs here, where it keeps the admin's row.
 *
 * Only a dangling `group_<slug>` whose slug a row owns is touched; anything
 * else is left for a human to look at. The real link is inserted (a no-op when
 * the page already has it), the dangling one deleted, and the affected pages'
 * FTS rows rebuilt so the group name becomes searchable. Idempotent: after the
 * first run nothing matches, and a normal boot costs one anti-join.
 */
async function repairDanglingPageGroups(db: Kysely<Database>): Promise<void> {
  const dangling = await sql<{ page_id: string }>`
    SELECT DISTINCT pg.page_id AS page_id
    FROM page_groups pg
    INNER JOIN groups g ON g.slug = substr(pg.group_id, 7)
    WHERE substr(pg.group_id, 1, 6) = 'group_'
      AND pg.group_id NOT IN (SELECT id FROM groups)
      AND pg.page_id IN (SELECT id FROM pages)
  `.execute(db);
  if (dangling.rows.length === 0) return;
  const pageIds = dangling.rows.map((row) => row.page_id);
  await db.transaction().execute(async (tx) => {
    await sql`
      INSERT OR IGNORE INTO page_groups (page_id, group_id)
      SELECT pg.page_id, g.id
      FROM page_groups pg
      INNER JOIN groups g ON g.slug = substr(pg.group_id, 7)
      WHERE substr(pg.group_id, 1, 6) = 'group_'
        AND pg.group_id NOT IN (SELECT id FROM groups)
        AND pg.page_id IN (SELECT id FROM pages)
    `.execute(tx);
    await sql`
      DELETE FROM page_groups
      WHERE substr(group_id, 1, 6) = 'group_'
        AND group_id NOT IN (SELECT id FROM groups)
        AND substr(group_id, 7) IN (SELECT slug FROM groups)
        AND page_id IN (SELECT id FROM pages)
    `.execute(tx);
    await reindexPageFts(tx, pageIds);
  });
  logger.log(`re-pointed dangling group links on ${pageIds.length} page(s)`);
}
