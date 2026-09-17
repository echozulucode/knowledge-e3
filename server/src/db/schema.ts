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

import type { ColumnType, Generated } from 'kysely';

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  spaces: SpacesTable;
  pages: PagesTable;
  page_versions: PageVersionsTable;
  revision_mirror_state: RevisionMirrorStateTable;
  space_repos: SpaceReposTable;
  page_tags: PageTagsTable;
  page_authors: PageAuthorsTable;
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
  api_tokens: ApiTokensTable;
  content_outbox: ContentOutboxTable;
  content_sources: ContentSourcesTable;
  sync_conflicts: SyncConflictsTable;
  sync_diagnostics: SyncDiagnosticsTable;
  login_attempts: LoginAttemptsTable;
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
  /** Presentation profile for the topic landing page (plan §3.1). Column default 'wiki', so inserts may omit it. */
  presentation: ColumnType<SpacePresentation, SpacePresentation | undefined, SpacePresentation>;
  /** Landing-page prose; round-trips through the bundle-root `index.md` body. */
  landing_markdown: string | null;
  /** Slug of the "Start here" item (`start_here:` in the bundle-root `index.md`). */
  start_here: string | null;
}

export type SpaceVisibility = 'public' | 'private';

export type SpacePresentation = 'portal' | 'blog' | 'docs' | 'wiki';

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
  /**
   * Indexed lifecycle/trust signals (plan §7.4), derived from the current
   * version's frontmatter on every write — see pages/lifecycle-columns.ts.
   * NULL on rows written before the columns existed (readers fall back to
   * frontmatter). `display_state` is not stored: it depends on "now".
   */
  lifecycle_status: string | null;
  stale_after: string | null;
  trust_tier: string | null;
  last_verified_at: string | null;
  generated_by: string | null;
  superseded_by: string | null;
  /**
   * The canonical file this row derives from (§7.2–7.3): repo-relative path,
   * sha256 of its bytes, and the source registry id. Written by the write-first
   * command and the rebuild; NULL on rows from the legacy DB-first path.
   */
  file_digest: string | null;
  file_path: string | null;
  source_id: string | null;
  /**
   * Open/settled change request for this item in a `review` source (plan §8.2).
   * `review_state` NULL means the item was never staged for review; while it is
   * `open` the item stays a draft and its edits live only on `review_branch`.
   * `review_change_id` is the host's `ChangeRef.id` (`owner/repo#12`), so the
   * ref can be rebuilt from the row plus the source's `host_kind`.
   */
  review_state: Optional<ReviewState | null>;
  review_url: Optional<string | null>;
  review_branch: Optional<string | null>;
  review_change_id: Optional<string | null>;
  review_opened_at: Optional<string | null>;
  review_closed_at: Optional<string | null>;
}

export type ReviewState = 'open' | 'merged' | 'closed';

/** A nullable column that may be omitted on insert (SQLite defaults it to NULL). */
export type Optional<T> = ColumnType<T, T | undefined, T>;

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

/**
 * An item's authors (frontmatter `authors` / `author`), normalized — the lookup
 * behind the `author:` search filter. Derived, like `page_tags`; written by
 * `reindexPageFts` on every write path and wiped by a rebuild.
 */
export interface PageAuthorsTable {
  page_id: string;
  /** `normalizeAuthor` form: whitespace collapsed, full-Unicode lowercase. */
  author: string;
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

/** Personal access tokens. Only the sha256 of the raw token is stored; `prefix`
 * (first 8 chars) is kept for display so a user can tell tokens apart. */
export interface ApiTokensTable {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scope: 'read' | 'write';
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Durable outbox for the write-path inversion (plan §7.3): one row per indexed
 * file change, written in the same transaction as the index (PagesService) and
 * marked processed by the git mirror once the file is committed (see
 * content/outbox.service.ts).
 */
export interface ContentOutboxTable {
  id: string;
  page_id: string;
  source_id: string | null;
  file_path: string | null;
  file_digest: string | null;
  actor_id: string | null;
  kind: 'upsert' | 'delete' | 'move';
  created_at: string;
  processed_at: string | null;
  error: string | null;
}

export type SourceRole = 'authoritative' | 'reference';
export type SyncMode = 'direct' | 'review' | 'read-only';
export type HostKind = 'github' | 'bitbucket-dc';

/**
 * Source registry (plan §7.4, Appendix B): one row per repository working
 * tree the instance indexes — `main`, or `topic:<slug>` for a topic bound to
 * its own repo. Replaces `space_repos` (kept as a legacy table; copied once by
 * the migration and never written again) and `app_config['git.main_remote']`.
 * Tokens are never stored: `host_token_env` / `webhook_secret_env` name the
 * environment variables that hold them.
 */
export interface ContentSourcesTable {
  /** `main` or `topic:<slug>`. */
  id: string;
  /** Bound topic; null for `main`. */
  space_id: string | null;
  /** Working tree: absolute, or relative to the content root (`main`, `topics/<slug>`). */
  local_dir: string;
  remote_url: string | null;
  branch: string | null;
  role: SourceRole;
  mode: SyncMode;
  /** Item-branch prefix for `review` mode (default `e3/`). */
  branch_prefix: string | null;
  host_kind: HostKind | null;
  host_base_url: string | null;
  host_token_env: string | null;
  /** Fetch/merge cadence; null = `sync.every` from the config file. */
  sync_every_seconds: number | null;
  webhook_secret_env: string | null;
  /** Import default for inbound items with no lifecycle state; null = instance fallback. */
  default_status: 'draft' | 'published' | null;
  /**
   * Non-OKF Markdown import (plan §8.3): JSON arrays of posix globs selecting
   * the files this source indexes, or null. Null `include_globs` keeps the
   * historical behaviour (`concepts/*.md` at any depth); `exclude_globs`
   * subtracts from the include set. Stored as JSON text so a list round-trips
   * exactly (SQLite has no array type and a pattern may contain a comma).
   */
  include_globs: string | null;
  exclude_globs: string | null;
  /** Content type given to an imported file whose frontmatter names none; null = leave untyped. */
  default_type: string | null;
  /** 0/1. When 0 the binding exists but nothing is fetched or pushed. */
  enabled: number;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
  last_error: string | null;
}

/** Conflict queue (plan §8.1): a merge left `path` conflicted; both sides kept for Admin → Repos → Conflicts. */
export interface SyncConflictsTable {
  id: string;
  source_id: string;
  path: string;
  page_id: string | null;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolution: 'ours' | 'theirs' | 'manual' | null;
  resolved_by: string | null;
}

/**
 * Inbound lint failures (plan §12 decision 6): a file that arrived through sync
 * with error-severity diagnostics. Landed anyway (new items as drafts) and
 * listed in Content health as `lint_failed_inbound` until a clean version arrives.
 */
export interface SyncDiagnosticsTable {
  id: string;
  source_id: string;
  path: string;
  page_id: string | null;
  diagnostics_json: string;
  detected_at: string;
  cleared_at: string | null;
  /** When these diagnostics were reported back on the item's change request (once per review). */
  commented_at: Optional<string | null>;
}

/**
 * Sign-in throttle ledger (issue 41). One row per attempt that reached password
 * verification, per bucket it counts against. Pruned to one window on write.
 */
export interface LoginAttemptsTable {
  id: Generated<number>;
  bucket: 'username' | 'ip';
  /** Normalized attempted username, or the client IP (`req.ip`). */
  key: string;
  /** Epoch milliseconds. */
  attempted_at: number;
}
