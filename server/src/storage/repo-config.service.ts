import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { redactSecrets, resolveGitCredential, type GitCredentialRef } from '@echozedlabs/repo-sync';
import { SourceRegistryService, envVarPresent, type SourceRow } from '../sync/source-registry.service.js';

const execFileAsync = promisify(execFile);
const LS_REMOTE_TIMEOUT_MS = 15_000;

/** Legacy app_config key for the main remote; copied into the registry by the migration, no longer written. */
export const MAIN_REMOTE_KEY = 'git.main_remote';

export interface MainRemote {
  remote_url: string;
  branch: string | null;
  enabled: boolean;
}

export interface SpaceRepoView {
  space_id: string;
  space_slug: string | null;
  space_name: string | null;
  remote_url: string;
  branch: string | null;
  enabled: boolean;
  /** Import default for items with no lifecycle state; null = instance fallback. */
  default_status: 'draft' | 'published' | null;
  updated_at: string;
}

export interface RepoUpsertInput {
  remote_url: string;
  branch?: string | null;
  enabled?: boolean;
  default_status?: 'draft' | 'published' | null;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

/**
 * Admin-managed mapping of a topic (space) to a backend git repository (ADR-0001
 * multi-repo) — now a **facade over the source registry** (`content_sources`,
 * plan §7.4): a topic binding is the `topic:<slug>` row, the main remote is the
 * `main` row. Stores only the remote URL/branch and the NAME of the source's
 * credential variable — never a token (issue 122). Also runs a
 * read-connectivity check, over the same per-source credential path the sync
 * engine uses.
 */
@Injectable()
export class RepoConfigService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly registry: SourceRegistryService,
  ) {}

  async list(): Promise<SpaceRepoView[]> {
    const rows = await this.db
      .selectFrom('content_sources as r')
      .leftJoin('spaces as s', 's.id', 'r.space_id')
      .select([
        'r.space_id',
        'r.remote_url',
        'r.branch',
        'r.enabled',
        'r.default_status',
        'r.updated_at',
        's.slug as space_slug',
        's.name as space_name',
      ])
      .where('r.id', '!=', 'main')
      .where('r.space_id', 'is not', null)
      .execute();
    return rows.map((r) => ({
      space_id: r.space_id!,
      space_slug: r.space_slug,
      space_name: r.space_name,
      remote_url: r.remote_url ?? '',
      branch: r.branch,
      enabled: r.enabled === 1,
      default_status: r.default_status,
      updated_at: r.updated_at,
    }));
  }

  /** The registry row bound to a topic, if any. */
  forSpace(spaceId: string): Promise<SourceRow | null> {
    return this.registry.forSpace(spaceId);
  }

  async upsert(spaceId: string, input: RepoUpsertInput, _actorId: string | null): Promise<void> {
    const remote = input.remote_url.trim();
    assertSafeRemote(remote);
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', spaceId).executeTakeFirst();
    if (!space) throw new NotFoundException('Topic not found.');
    const existing = await this.registry.forSpace(spaceId);
    await this.registry.upsert(existing?.id ?? `topic:${space.slug}`, {
      space_id: spaceId,
      remote_url: remote,
      branch: input.branch?.trim() || null,
      enabled: input.enabled !== false,
      default_status: input.default_status ?? null,
    });
  }

  async remove(spaceId: string): Promise<void> {
    await this.db.deleteFrom('content_sources').where('space_id', '=', spaceId).execute();
  }

  /** The instance-level "main repo" remote (where topics live unless dedicated). */
  async getMainRemote(): Promise<MainRemote | null> {
    const row = await this.registry.get('main');
    if (!row?.remote_url) return null;
    return { remote_url: row.remote_url, branch: row.branch, enabled: row.enabled === 1 };
  }

  async setMainRemote(input: { remote_url: string; branch?: string | null; enabled?: boolean }): Promise<MainRemote> {
    const remote = input.remote_url.trim();
    assertSafeRemote(remote);
    const value: MainRemote = {
      remote_url: remote,
      branch: input.branch?.trim() || null,
      enabled: input.enabled !== false,
    };
    await this.registry.upsert('main', { remote_url: value.remote_url, branch: value.branch, enabled: value.enabled });
    return value;
  }

  /**
   * Read-connectivity check: `git ls-remote` over the **same credential path
   * the sync engine uses** (issue 122), so "Test connection" answers the
   * question an admin is actually asking — can this source reach this
   * repository with the token it names?
   *
   * `credential` carries NAMES only (`host_token_env` / `host_kind`), which is
   * what the Sources form holds; the token is read from the server's
   * environment inside `resolveGitCredential` and reaches git through its
   * child environment. Nothing about the value is reported back — only whether
   * the named variable is set at all, which the caller already knows from
   * `host_token_present`.
   */
  async testConnection(remoteUrl: string, credential?: GitCredentialRef | null): Promise<ConnectionResult> {
    const remote = remoteUrl.trim();
    try {
      assertSafeRemote(remote);
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
    const named = credential?.tokenEnv?.trim();
    if (named && !envVarPresent(named)) {
      return {
        ok: false,
        message:
          `${named} is not set in this server's environment, so this source has no credential to authenticate with. ` +
          'Set it where the process gets its environment (.env for Docker Compose), then restart the server.',
      };
    }
    const cred = resolveGitCredential({ ...(credential ?? {}), remote });
    try {
      const { stdout } = await execFileAsync('git', [...(cred?.args ?? []), 'ls-remote', '--heads', remote], {
        timeout: LS_REMOTE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(cred?.env ?? {}) },
      });
      const refs = stdout.trim() ? stdout.trim().split('\n').length : 0;
      const how = cred ? ` Authenticated with ${cred.tokenEnvName}.` : '';
      return { ok: true, message: `Reachable — ${refs} branch(es) visible.${how}` };
    } catch (err) {
      const message = redactSecrets(errMessage(err), cred?.secrets ?? []);
      return { ok: false, message: message.slice(0, 300) };
    }
  }
}

/** Reject option-injection and obviously non-URL inputs (admin-only, but be safe). */
function assertSafeRemote(url: string): void {
  if (!url) throw new Error('remote URL is required');
  if (url.startsWith('-')) throw new Error('invalid remote URL');
  const looksValid =
    /^(https?|ssh|git|file):\/\//.test(url) || // url schemes
    /^[\w.-]+@[\w.-]+:/.test(url) || // scp-style ssh: git@host:path
    url.startsWith('/') || // posix absolute path
    /^[a-zA-Z]:[\\/]/.test(url); // windows absolute path
  if (!looksValid) throw new Error('remote URL must be an https://, ssh://, git@host:path, or file path');
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string') {
    const stderr = (err as { stderr: string }).stderr.trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}
