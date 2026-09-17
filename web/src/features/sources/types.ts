/**
 * Source-registry DTOs (plan §7.4 / §8.1) as the web sees them.
 *
 * These mirror the server's `content_sources` / `sync_conflicts` rows plus the
 * live `SyncStatus` the admin routes attach. They are declared here rather than
 * imported from a package so the Sources UI stays additive: nothing in
 * `@echozedlabs/knowledge-types` had to change for it.
 */
import type { SyncStatus } from '@echozedlabs/knowledge-types';

export type { SyncStatus };

export type SourceRole = 'authoritative' | 'reference';
export type SyncMode = 'direct' | 'review' | 'read-only';
export type HostKind = 'github' | 'bitbucket-dc';
export type DefaultStatus = 'draft' | 'published';

/** One `content_sources` row. `enabled` arrives as SQLite's 0/1. */
export interface SourceRow {
  id: string;
  space_id: string | null;
  local_dir: string;
  remote_url: string | null;
  branch: string | null;
  role: SourceRole;
  mode: SyncMode;
  branch_prefix: string | null;
  host_kind: HostKind | null;
  host_base_url: string | null;
  host_token_env: string | null;
  sync_every_seconds: number | null;
  webhook_secret_env: string | null;
  default_status: DefaultStatus | null;
  /**
   * Non-OKF import (plan §8.3 / A1): the globs selecting which files this source
   * indexes, and those subtracted from them. On the wire these are the column
   * as stored — JSON TEXT (`'["docs/**\/*.md"]'`), or null for the default
   * layout — so read them through `globsOf`, never directly. Optional because a
   * server that predates the columns omits them.
   */
  include_globs?: string | string[] | null;
  exclude_globs?: string | string[] | null;
  /** Content type an imported file with none of its own is given; null leaves it untyped. */
  default_type?: string | null;
  enabled: number;
  created_at?: string;
  updated_at?: string;
  last_synced_at: string | null;
  last_error: string | null;
}

/** A registry row with the engine's live (or last known) status. */
export interface SourceStatusView extends SourceRow {
  status: SyncStatus;
  /** True when a running engine manages this source. */
  managed?: boolean;
  /**
   * Whether the env var `host_token_env` / `webhook_secret_env` NAMES holds a
   * value on the server (plan B3 / D4a). A boolean is the whole of what crosses
   * the wire — never the value, never its length. Optional because a server
   * that predates the flags simply omits them, and "absent" must not read as
   * "not set".
   */
  host_token_present?: boolean;
  webhook_secret_present?: boolean;
  /**
   * Live items indexed from this source (plan A1). Absent when the server did
   * not count — which must not render as "0 items".
   */
  item_count?: number;
  /** The commit the working tree is on; null when there is none to report (no clone, unborn, git too slow). */
  head?: SourceHead | null;
}

export interface SourceHead {
  sha: string;
  committed_at: string | null;
}

/** The upsert body of `PUT /admin/sources/:id`; every field is optional. */
export interface SourceUpsertInput {
  space_id?: string | null;
  local_dir?: string;
  remote_url?: string | null;
  branch?: string | null;
  role?: SourceRole;
  mode?: SyncMode;
  branch_prefix?: string | null;
  host_kind?: HostKind | null;
  host_base_url?: string | null;
  host_token_env?: string | null;
  sync_every_seconds?: number | null;
  webhook_secret_env?: string | null;
  default_status?: DefaultStatus | null;
  /** A list here, JSON text in the row; `[]` or null restores the default layout. */
  include_globs?: string[] | null;
  exclude_globs?: string[] | null;
  default_type?: string | null;
  enabled?: boolean;
}

/** One parked merge conflict (plan §8.1). */
export interface ConflictRow {
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
  /**
   * Username of whoever resolved it, joined on by the server and present only
   * on rows that came back from `?includeResolved=true` (null when that user
   * has since been deleted).
   */
  resolved_by_username?: string | null;
}

/**
 * Who resolved a conflict, as the history list shows it. The row records an
 * actor id; the server joins a username onto resolved rows, and we fall back to
 * the id (then to a placeholder) so the column is never blank.
 */
export function resolvedByLabel(row: Pick<ConflictRow, 'resolved_by' | 'resolved_by_username'>): string {
  return row.resolved_by_username?.trim() || row.resolved_by?.trim() || 'Unknown';
}

export type ReviewState = 'open' | 'merged' | 'closed';

/** The change request an item is sitting in under `review` mode (plan §8.2), as item views carry it. */
export interface ReviewRef {
  state: ReviewState;
  url: string | null;
  branch: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
}

/** One row of `GET /admin/sources/:id/reviews` — the server's flat wire shape. */
export interface ReviewRecord {
  page_id: string;
  slug: string;
  title: string;
  state: ReviewState;
  url: string | null;
  branch: string | null;
  change_id?: string | null;
  opened_at: string | null;
  closed_at: string | null;
  file_path?: string | null;
  source_id: string;
  /** The item is already deleted here and the change request proposes removing its file. */
  deleted?: boolean;
}

/** A review row normalized to the same nested shape item views use. */
export interface ReviewEntry {
  page_id: string;
  slug?: string | null;
  title?: string | null;
  source_id?: string;
  review: ReviewRef;
  /** A proposed removal: there is no item left to open, so the title is not a link. */
  deleted?: boolean;
}

/** Flatten one wire row into the shape the panels render. */
export function toReviewEntry(record: ReviewRecord): ReviewEntry {
  return {
    page_id: record.page_id,
    slug: record.slug,
    title: record.title,
    source_id: record.source_id,
    deleted: record.deleted ?? false,
    review: {
      state: record.state,
      url: record.url,
      branch: record.branch,
      opened_at: record.opened_at,
      closed_at: record.closed_at,
    },
  };
}
