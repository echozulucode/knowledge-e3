/**
 * Source registry (plan §7.4, Appendix B): the `content_sources` table — one
 * row per repository working tree the instance indexes (`main`, or
 * `topic:<slug>` for a topic bound to its own repo). `RepoConfigService` is a
 * facade over this for the legacy Admin → Repos routes; `ContentPathResolver`
 * reads it to place files; `SyncService` runs one engine per enabled row with
 * a remote. Tokens are never stored — only the names of the env vars.
 */
import { isAbsolute, resolve } from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SourceRef } from '@echozedlabs/knowledge-types';
import { canonicalTypeLabel, findContentType } from '@echozedlabs/content-model';
import { KYSELY } from '../db/db.module.js';
import type { ContentSourcesTable, Database, HostKind, SourceRole, SyncMode } from '../db/schema.js';
import { nowIso } from '../common/ids.js';
import type { SourceConfigEntry } from '../config/server-config.js';

export type SourceRow = ContentSourcesTable;

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
  default_status?: 'draft' | 'published' | null;
  /**
   * Non-OKF Markdown import (plan §8.3): the posix globs selecting the files
   * this source indexes, and the globs subtracted from them. Passed as a list;
   * persisted as JSON text (`include_globs` / `exclude_globs`). An empty list
   * clears the column, which restores the default (`concepts/*.md`).
   */
  include_globs?: string[] | null;
  exclude_globs?: string[] | null;
  /** Content type for an imported file whose frontmatter names none; must be in the content-type registry. */
  default_type?: string | null;
  enabled?: boolean;
}

const ROLES: SourceRole[] = ['authoritative', 'reference'];
const MODES: SyncMode[] = ['direct', 'review', 'read-only'];
const HOST_KINDS: HostKind[] = ['github', 'bitbucket-dc'];

@Injectable()
export class SourceRegistryService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  list(): Promise<SourceRow[]> {
    return this.db.selectFrom('content_sources').selectAll().orderBy('id').execute();
  }

  async get(id: string): Promise<SourceRow | null> {
    const row = await this.db.selectFrom('content_sources').selectAll().where('id', '=', id).executeTakeFirst();
    return row ?? null;
  }

  /**
   * The dedicated source bound to a topic, by `space_id` or — for an entry
   * declared in the config file before the topic existed — by `topic:<slug>`.
   */
  async forSpace(spaceId: string): Promise<SourceRow | null> {
    const bySpace = await this.db
      .selectFrom('content_sources')
      .selectAll()
      .where('space_id', '=', spaceId)
      .executeTakeFirst();
    if (bySpace) return bySpace;
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', spaceId).executeTakeFirst();
    if (!space) return null;
    const bySlug = await this.get(`topic:${space.slug}`);
    if (bySlug && bySlug.space_id === null) {
      await this.db.updateTable('content_sources').set({ space_id: spaceId }).where('id', '=', bySlug.id).execute();
      return { ...bySlug, space_id: spaceId };
    }
    return bySlug;
  }

  /**
   * Insert or update one entry. Only the fields present in `input` change on an
   * existing row (so the config file and admin edits compose); a new row takes
   * the defaults: `local_dir` `main` / `topics/<slug>`, role authoritative,
   * mode direct, prefix `e3/`, enabled.
   */
  async upsert(id: string, input: SourceUpsertInput): Promise<SourceRow> {
    validateId(id);
    if (input.role !== undefined && !ROLES.includes(input.role)) throw new BadRequestException(`invalid role "${input.role}"`);
    if (input.mode !== undefined && !MODES.includes(input.mode)) throw new BadRequestException(`invalid mode "${input.mode}"`);
    if (input.host_kind != null && !HOST_KINDS.includes(input.host_kind)) throw new BadRequestException(`invalid host_kind "${input.host_kind}"`);
    if (input.remote_url) assertSafeRemote(input.remote_url);
    if (input.default_status != null && input.default_status !== 'draft' && input.default_status !== 'published') {
      throw new BadRequestException('default_status must be draft or published');
    }
    const includeGlobs = input.include_globs !== undefined ? encodeGlobs(input.include_globs, 'include_globs') : undefined;
    const excludeGlobs = input.exclude_globs !== undefined ? encodeGlobs(input.exclude_globs, 'exclude_globs') : undefined;
    const defaultType = input.default_type !== undefined ? normalizeDefaultType(input.default_type) : undefined;
    const now = nowIso();
    const existing = await this.get(id);
    const patch: Partial<SourceRow> = {};
    if (input.space_id !== undefined) patch.space_id = input.space_id;
    if (input.local_dir !== undefined) patch.local_dir = input.local_dir.trim();
    if (input.remote_url !== undefined) patch.remote_url = input.remote_url?.trim() || null;
    if (input.branch !== undefined) patch.branch = input.branch?.trim() || null;
    if (input.role !== undefined) patch.role = input.role;
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.branch_prefix !== undefined) patch.branch_prefix = input.branch_prefix?.trim() || null;
    if (input.host_kind !== undefined) patch.host_kind = input.host_kind;
    if (input.host_base_url !== undefined) patch.host_base_url = input.host_base_url?.trim() || null;
    if (input.host_token_env !== undefined) patch.host_token_env = input.host_token_env?.trim() || null;
    if (input.sync_every_seconds !== undefined) patch.sync_every_seconds = input.sync_every_seconds;
    if (input.webhook_secret_env !== undefined) patch.webhook_secret_env = input.webhook_secret_env?.trim() || null;
    if (input.default_status !== undefined) patch.default_status = input.default_status;
    if (includeGlobs !== undefined) patch.include_globs = includeGlobs;
    if (excludeGlobs !== undefined) patch.exclude_globs = excludeGlobs;
    if (defaultType !== undefined) patch.default_type = defaultType;
    if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;

    if (existing) {
      // Validate the MERGED row, not the patch: `upsert` is partial, so a patch
      // that only re-enables a row still has to clear the dual-writer check.
      const merged = { ...existing, ...patch } as SourceRow;
      assertReviewIsConfigurable(merged);
      await this.assertNoCollision(merged);
      await this.db
        .updateTable('content_sources')
        .set({ ...patch, updated_at: now })
        .where('id', '=', id)
        .execute();
      return (await this.get(id))!;
    }

    const spaceId = patch.space_id ?? (id === 'main' ? null : await this.spaceIdForSlug(id.slice('topic:'.length)));
    const row: SourceRow = {
      id,
      space_id: spaceId,
      local_dir: patch.local_dir ?? defaultLocalDir(id),
      remote_url: patch.remote_url ?? null,
      branch: patch.branch ?? null,
      role: patch.role ?? 'authoritative',
      mode: patch.mode ?? 'direct',
      branch_prefix: patch.branch_prefix === undefined ? 'e3/' : patch.branch_prefix,
      host_kind: patch.host_kind ?? null,
      host_base_url: patch.host_base_url ?? null,
      host_token_env: patch.host_token_env ?? null,
      sync_every_seconds: patch.sync_every_seconds ?? null,
      webhook_secret_env: patch.webhook_secret_env ?? null,
      default_status: patch.default_status ?? null,
      include_globs: patch.include_globs ?? null,
      exclude_globs: patch.exclude_globs ?? null,
      default_type: patch.default_type ?? null,
      enabled: patch.enabled ?? 1,
      created_at: now,
      updated_at: now,
      last_synced_at: null,
      last_error: null,
    };
    assertReviewIsConfigurable(row);
    await this.assertNoCollision(row);
    await this.db.insertInto('content_sources').values(row).execute();
    return row;
  }

  /**
   * Plan §8.3, last row: *"Two E3 instances on the same repository (staging and
   * production): both `direct` on different branches, or one `authoritative`
   * and one `reference`. Same-branch dual writers are unsupported and the
   * registry rejects it."*
   *
   * Two checks, both scoped to **enabled** rows only (a disabled row neither
   * collides nor is collided with — that is how an admin parks a source):
   *
   *  - **Working tree**: no two enabled sources may point at the same
   *    `local_dir`. Any mode: a `read-only` source sharing a tree with a writer
   *    would see the writer's uncommitted files as inbound content.
   *  - **Remote + branch**: no two enabled **writable** sources (`mode` other
   *    than `read-only`) may target the same normalized `(remote_url, branch)`.
   *    A null remote is local-only and never collides.
   *
   * Three limits, all deliberate: an unset branch is only equal to another unset
   * branch (the registry cannot resolve a remote's default HEAD offline); two
   * URLs reaching one repository over *different transports* (`https://host/o/r`
   * vs `git@host:o/r`) are not recognised as equal; and `local_dir` is compared
   * as written, so a relative and an absolute spelling of one tree are not.
   */
  private async assertNoCollision(row: SourceRow): Promise<void> {
    if (row.enabled !== 1) return;
    const others = (await this.list()).filter((o) => o.id !== row.id && o.enabled === 1);

    const dir = normalizeLocalDir(row.local_dir);
    for (const other of others) {
      if (dir && normalizeLocalDir(other.local_dir) === dir) {
        throw new BadRequestException(
          `local_dir "${row.local_dir}" is already used by source "${other.id}"; two sources cannot share one working tree`,
        );
      }
    }

    if (row.mode === 'read-only') return;
    const remote = normalizeRemoteUrl(row.remote_url);
    if (!remote) return;
    const branch = normalizeBranch(row.branch);
    for (const other of others) {
      if (other.mode === 'read-only') continue;
      if (normalizeRemoteUrl(other.remote_url) !== remote) continue;
      if (normalizeBranch(other.branch) !== branch) continue;
      throw new BadRequestException(
        `source "${other.id}" already writes ${row.remote_url} on branch ${branch ?? '(default)'}; ` +
          'same-branch dual writers are unsupported — give this source its own branch, or set mode to read-only',
      );
    }
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('content_sources').where('id', '=', id).execute();
  }

  async recordSync(id: string, result: { at?: string; error?: string | null }): Promise<void> {
    await this.db
      .updateTable('content_sources')
      .set({
        ...(result.at !== undefined ? { last_synced_at: result.at } : {}),
        ...(result.error !== undefined ? { last_error: result.error } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  /** The `SourceRef` the sync engine and content store consume; `local` is absolute under `root`. */
  toSourceRef(row: SourceRow, root: string): SourceRef {
    return {
      id: row.id,
      local: resolveLocalDir(row.local_dir, root),
      remote: row.remote_url,
      branch: row.branch,
      role: row.role,
      policy: { mode: row.mode, branchPrefix: row.branch_prefix ?? 'e3/' },
    };
  }

  /**
   * Boot-time reconciliation of the `sources:` list in the config file: each
   * entry is upserted with exactly the fields it names, so the file is the
   * authority for those and Admin → Repos edits to the rest persist.
   */
  async reconcileFromConfig(entries: SourceConfigEntry[]): Promise<void> {
    for (const e of entries) {
      const input: SourceUpsertInput = {};
      if (e.local !== undefined) input.local_dir = e.local;
      if (e.remote !== undefined) input.remote_url = e.remote;
      if (e.branch !== undefined) input.branch = e.branch;
      if (e.role !== undefined) input.role = e.role;
      if (e.policy?.mode !== undefined) input.mode = e.policy.mode;
      if (e.policy?.branchPrefix !== undefined) input.branch_prefix = e.policy.branchPrefix;
      if (e.host?.kind !== undefined) input.host_kind = e.host.kind;
      if (e.host?.baseUrl !== undefined) input.host_base_url = e.host.baseUrl;
      if (e.host?.tokenEnv !== undefined) input.host_token_env = e.host.tokenEnv;
      if (e.sync?.every !== undefined) input.sync_every_seconds = e.sync.every;
      if (e.sync?.webhookSecretEnv !== undefined) input.webhook_secret_env = e.sync.webhookSecretEnv;
      if (e.include !== undefined) input.include_globs = e.include;
      if (e.exclude !== undefined) input.exclude_globs = e.exclude;
      if (e.defaultType !== undefined) input.default_type = e.defaultType;
      await this.upsert(e.id, input);
    }
  }

  private async spaceIdForSlug(slug: string): Promise<string | null> {
    const row = await this.db.selectFrom('spaces').select('id').where('slug', '=', slug).executeTakeFirst();
    return row?.id ?? null;
  }
}

/**
 * `mode: review` only means anything with somewhere to push and a host to open
 * the change request on. Without a remote, `ContentCommands` finds no review
 * source and silently writes to the working tree like `direct` — a
 * configuration that looks like it enforces PRs and does not. Reject it at the
 * registry instead, so the guard in `ContentCommands` and the staging path
 * cannot disagree about what "a review source" is.
 */
export function assertReviewIsConfigurable(row: Pick<SourceRow, 'id' | 'mode' | 'remote_url' | 'host_kind'>): void {
  if (row.mode !== 'review') return;
  if (!row.remote_url || !row.remote_url.trim()) {
    throw new BadRequestException(
      `source "${row.id}" cannot use mode "review" without a remote_url: there would be nowhere to push the item branch, and writes would silently go to the working tree like "direct". Set a remote, or use mode "direct".`,
    );
  }
  if (!row.host_kind) {
    throw new BadRequestException(
      `source "${row.id}" cannot use mode "review" without a host_kind: there would be no change-request host to open the pull request on. Set host_kind (and host_token_env), or use mode "direct".`,
    );
  }
}

/**
 * The glob list stored in `include_globs` / `exclude_globs`: a JSON array of
 * strings, or `[]` for null/blank/malformed text. Tolerant on read — a column
 * hand-edited into nonsense degrades to "no globs" (the historical behaviour)
 * instead of breaking every sync of that source.
 */
export function globList(value: string | null | undefined): string[] {
  if (!value || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim());
  } catch {
    return [];
  }
}

/** A glob list → the JSON text stored in the column; an empty/absent list → null. */
function encodeGlobs(value: string[] | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be a list of glob strings`);
  const globs: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new BadRequestException(`${field} must be a list of glob strings`);
    const g = raw.trim();
    if (!g) continue;
    // Split on both separators: the globs are posix, but an admin pasting a
    // Windows path (`docs\..\secrets`) means the same escape and gets the same no.
    if (/^[\\/]/.test(g) || /^[a-zA-Z]:/.test(g) || g.split(/[\\/]/).includes('..')) {
      throw new BadRequestException(`${field}: "${raw}" must be a repository-relative glob (no leading "/" and no "..")`);
    }
    globs.push(g.replace(/^\.\//, ''));
  }
  return globs.length ? JSON.stringify(globs) : null;
}

/**
 * `default_type` against the content-type registry — the same resolution
 * `canonicalTypeLabel` applies to a file's own `type`, but rejected when
 * unknown: a per-source default is configuration, and a typo there would type
 * every imported file wrongly and silently.
 */
function normalizeDefaultType(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!findContentType(trimmed)) throw new BadRequestException(`unknown content type "${trimmed}" for default_type`);
  return canonicalTypeLabel(trimmed);
}

export function defaultLocalDir(id: string): string {
  return id === 'main' ? 'main' : `topics/${id.slice('topic:'.length)}`;
}

/** Absolute working-tree dir for a row: `local_dir` as-is when absolute, else under the content root. */
export function resolveLocalDir(localDir: string, root: string): string {
  return isAbsolute(localDir) ? localDir : resolve(root, localDir);
}

/**
 * Is the env var a source NAMES actually set on this server?
 *
 * The one definition of "present" for a named secret, shared by the Sources row
 * (`SyncService.statuses`) and the system-health `secrets` check. Two
 * implementations of this predicate would eventually disagree, and the whole
 * point of the flag is that an operator trusts it.
 *
 * A blank or whitespace-only value counts as NOT set — the definition the
 * system-health `secrets` check has used since it was written, kept rather than
 * replaced so the page and the row cannot disagree. It is also the more useful
 * answer in the one case where it differs from `hostFor` (which refuses only an
 * empty string): `"   "` is an unsubstituted `FOO=${FOO}` in a Compose file,
 * not a token, and calling it set would send the operator to look at the host.
 *
 * **Boolean only.** The value never leaves the process — not its length, not a
 * prefix. The NAME is the useful half and is already stored in the registry.
 */
export function envVarPresent(name: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!name) return false;
  return (env[name] ?? '').trim() !== '';
}

/**
 * Canonical form of a remote URL for **equality only** (never for `git`): trims,
 * drops a trailing `.git` and trailing slashes, lower-cases the scheme and host,
 * and rewrites the scp-style `user@host:path` into `ssh://user@host/path` so the
 * two spellings of one SSH remote compare equal. The path stays case-sensitive
 * (`org/Repo` and `org/repo` are different repositories on a case-sensitive
 * host). Returns null for a null/blank remote — a local-only source.
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  let s = url.trim();
  if (!s) return null;
  // scp-style ssh (`git@host:org/repo`) → the equivalent ssh:// URL. Excludes a
  // Windows drive letter (`C:\repos\x`), which is a path, not a host.
  const scp = /^([^/@\s]+)@([^/:\s]+):(?!\/)(.+)$/.exec(s);
  if (scp) s = `ssh://${scp[1]}@${scp[2]}/${scp[3]!.replace(/^\/+/, '')}`;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(s);
  if (scheme) s = `${scheme[1]!.toLowerCase()}://${scheme[2]!.toLowerCase()}${scheme[3] ?? ''}`;
  s = s.replace(/[/\\]+$/, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/[/\\]+$/, '');
  return s || null;
}

/** Canonical form of a working-tree path for equality: separators, trailing slash, and case on Windows. */
export function normalizeLocalDir(dir: string | null | undefined): string | null {
  if (dir == null) return null;
  let s = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/** Canonical form of a branch name for equality; blank/unset is the remote's default. */
function normalizeBranch(branch: string | null | undefined): string | null {
  const s = branch?.trim().replace(/^refs\/heads\//, '');
  return s ? s : null;
}

function validateId(id: string): void {
  if (id === 'main') return;
  if (/^topic:[a-z0-9][a-z0-9-]*$/.test(id)) return;
  throw new BadRequestException('source id must be `main` or `topic:<slug>`');
}

/** Reject option-injection and obviously non-URL inputs (admin-only, but be safe). */
export function assertSafeRemote(url: string): void {
  if (!url) throw new BadRequestException('remote URL is required');
  if (url.startsWith('-')) throw new BadRequestException('invalid remote URL');
  const looksValid =
    /^(https?|ssh|git|file):\/\//.test(url) || // url schemes
    /^[\w.-]+@[\w.-]+:/.test(url) || // scp-style ssh: git@host:path
    url.startsWith('/') || // posix absolute path
    /^[a-zA-Z]:[\\/]/.test(url); // windows absolute path
  if (!looksValid) throw new BadRequestException('remote URL must be an https://, ssh://, git@host:path, or file path');
}
