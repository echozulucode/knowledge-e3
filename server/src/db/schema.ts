/**
 * Database schema types for Kysely.
 *
 * The single canonical schema shape. SQL Server and SQLite migrations both
 * produce columns conforming to this interface; the application code reads
 * and writes through Kysely typed against this `Database` interface.
 *
 * Per v0.1-spec.md section 13. Field nullability and types match the spec
 * exactly. Where SQL Server has types without SQLite equivalents (rowversion,
 * UNIQUEIDENTIFIER), we use a string column carrying the same semantics:
 *   - UUIDs are stored as TEXT/NVARCHAR(36) regardless of dialect.
 *   - rowversion equivalent is a monotonically incrementing integer column
 *     `version_token`, bumped by the application on every page write.
 */

import type { Generated } from 'kysely';

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  spaces: SpacesTable;
  pages: PagesTable;
  page_versions: PageVersionsTable;
  revision_mirror_state: RevisionMirrorStateTable;
  space_repos: SpaceReposTable;
  page_tags: PageTagsTable;
  primary_categories: PrimaryCategoriesTable;
  page_categories: PageCategoriesTable;
  groups: GroupsTable;
  page_groups: PageGroupsTable;
  item_links: ItemLinksTable;
  wikilinks: WikiLinksTable;
  images: ImagesTable;
  image_links: ImageLinksTable;
  page_views: PageViewsTable;
  audit_log: AuditLogTable;
  bug_reports: BugReportsTable;
  app_config: AppConfigTable;
  user_prefs: UserPrefsTable;
}

export interface UsersTable {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: string;
  deleted_at: string | null;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip_addr: string | null;
}

export interface SpacesTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /**
   * 'private' = not exposed to ANONYMOUS visitors. Signed-in users are
   * unaffected; this narrows public exposure, it is not a per-user ACL.
   * ANDs with the instance read mode and with per-item `status`.
   */
  visibility: SpaceVisibility;
}

export type SpaceVisibility = 'public' | 'private';

export interface PagesTable {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  /** OKF concept kind (blog, faq, best-practice…); mirrored from frontmatter. Null = unspecified. */
  type: string | null;
  owner_id: string | null;
  space_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /**
   * When the item was first published (stamped on draft->published, settable
   * from frontmatter). NULL while a draft. Stable across edits so a chronological
   * feed does not reshuffle on a typo fix. Derived from frontmatter.
   */
  published_at: string | null;
  /** Application-managed monotonic counter — semantic of SQL Server rowversion. */
  version_token: number;
  current_version_id: string | null;
}

export interface PageVersionsTable {
  id: string;
  page_id: string;
  body_markdown: string;
  /** Full canonical raw doc (frontmatter + body) — what the codec parses. */
  raw_markdown: string;
  /** Canonical full frontmatter object. */
  frontmatter_json: string;
  /** Cached parsed AST for render speed. */
  parsed_ast_json: string;
  created_at: string;
  created_by: string;
  parent_version_id: string | null;
}

export interface RevisionMirrorStateTable {
  page_id: string;
  /** Mirror backend identifier, e.g. `git`; nullable until a mirror is enabled. */
  backend: string | null;
  /** Backend-local path for the mirrored revision artifact. */
  path: string | null;
  last_synced_version_token: number | null;
  last_commit: string | null;
  last_ref: string | null;
  /** SQLite stores booleans as 0/1; SQL Server migration should use BIT. */
  dirty: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

/**
 * Per-topic backend git repository mapping (ADR-0001 multi-repo). One row per
 * space whose content mirrors/pushes to a dedicated remote. The SSH key is never
 * stored here — pushes use the host's ambient SSH identity.
 */
export interface SpaceReposTable {
  space_id: string;
  /** Remote git URL (e.g. git@github.com:org/wiki.git). */
  remote_url: string;
  /** Branch to push to; null = the mirror's current branch. */
  branch: string | null;
  /** SQLite stores booleans as 0/1. When 0, the mapping exists but is not pushed. */
  enabled: number;
  /**
   * Status applied to imported items whose frontmatter declares no lifecycle
   * state. NULL defers to KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS. Per-repo because
   * "content from this source is ready to publish" is a fact about the source.
   */
  default_status: 'draft' | 'published' | null;
  created_at: string;
  updated_at: string;
}

export interface PageTagsTable {
  page_id: string;
  tag: string;
}

export interface PrimaryCategoriesTable {
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PageCategoriesTable {
  page_id: string;
  category: string;
}

export interface GroupsTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  space_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PageGroupsTable {
  page_id: string;
  group_id: string;
}

export interface ItemLinksTable {
  source_page_id: string;
  target_ref: string;
  link_type: 'wiki' | 'markdown';
  link_text: string;
  position: number;
}

export interface WikiLinksTable {
  source_page_id: string;
  target_title: string;
  position: number;
}

/**
 * Uploaded images/assets. Bytes live as files in the bundle's `assets/` dir
 * (git-of-record); this table is the derived index over them. Content-addressed:
 * `file` is derived from `sha256`, so identical uploads dedupe to one row.
 */
export interface ImagesTable {
  id: string;
  /** Bundle-relative filename under `assets/`, e.g. `a1b2c3d4e5f6.png`. */
  file: string;
  mime: string;
  byte_size: number;
  sha256: string;
  alt: string | null;
  /** Human-facing download name; null for images uploaded before attachments. */
  original_filename: string | null;
  created_at: string;
  created_by: string;
}

/** Which page references which image (derived from `![](/assets/…)` on save). */
export interface ImageLinksTable {
  page_id: string;
  image_id: string;
}

export interface PageViewsTable {
  id: string;
  page_id: string;
  user_id: string;
  session_id: string | null;
  viewed_at: string;
  dwell_ms: number | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  occurred_at: string;
  actor_id: string | null;
  action: string;
  page_id: string | null;
  version_id: string | null;
  payload_json: string | null;
}

export interface BugReportsTable {
  id: string;
  reporter_id: string | null;
  page_id: string | null;
  body: string;
  context_json: string;
  created_at: string;
  status: 'new' | 'triaged' | 'resolved';
}

export interface AppConfigTable {
  key: string;
  value_json: string;
  updated_at: string;
  updated_by: string | null;
}

export interface UserPrefsTable {
  user_id: string;
  key: string;
  value_json: string;
  updated_at: string;
}
