import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { nowIso } from '../common/ids.js';

const execFileAsync = promisify(execFile);
const LS_REMOTE_TIMEOUT_MS = 15_000;

/** app_config key for the instance-level "main repo" remote (topics default here). */
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
  updated_at: string;
}

export interface RepoUpsertInput {
  remote_url: string;
  branch?: string | null;
  enabled?: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

/**
 * Admin-managed mapping of a topic (space) to a backend git repository (ADR-0001
 * multi-repo). Stores only the remote URL/branch — never credentials; pushes use
 * the host's ambient SSH identity. Also runs a read-connectivity check.
 */
@Injectable()
export class RepoConfigService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async list(): Promise<SpaceRepoView[]> {
    const rows = await this.db
      .selectFrom('space_repos as r')
      .leftJoin('spaces as s', 's.id', 'r.space_id')
      .select([
        'r.space_id',
        'r.remote_url',
        'r.branch',
        'r.enabled',
        'r.updated_at',
        's.slug as space_slug',
        's.name as space_name',
      ])
      .execute();
    return rows.map((r) => ({
      space_id: r.space_id,
      space_slug: r.space_slug,
      space_name: r.space_name,
      remote_url: r.remote_url,
      branch: r.branch,
      enabled: r.enabled === 1,
      updated_at: r.updated_at,
    }));
  }

  async upsert(spaceId: string, input: RepoUpsertInput, _actorId: string | null): Promise<void> {
    const remote = input.remote_url.trim();
    assertSafeRemote(remote);
    const now = nowIso();
    const branch = input.branch?.trim() || null;
    const enabled = input.enabled === false ? 0 : 1;
    await this.db
      .insertInto('space_repos')
      .values({
        space_id: spaceId,
        remote_url: remote,
        branch,
        enabled,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('space_id').doUpdateSet({ remote_url: remote, branch, enabled, updated_at: now }),
      )
      .execute();
  }

  async remove(spaceId: string): Promise<void> {
    await this.db.deleteFrom('space_repos').where('space_id', '=', spaceId).execute();
  }

  /** The instance-level "main repo" remote (where topics live unless dedicated). */
  async getMainRemote(): Promise<MainRemote | null> {
    const row = await this.db
      .selectFrom('app_config')
      .select('value_json')
      .where('key', '=', MAIN_REMOTE_KEY)
      .executeTakeFirst();
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as MainRemote;
    } catch {
      return null;
    }
  }

  async setMainRemote(input: { remote_url: string; branch?: string | null; enabled?: boolean }): Promise<MainRemote> {
    const remote = input.remote_url.trim();
    assertSafeRemote(remote);
    const value: MainRemote = {
      remote_url: remote,
      branch: input.branch?.trim() || null,
      enabled: input.enabled !== false,
    };
    const now = nowIso();
    await this.db
      .insertInto('app_config')
      .values({ key: MAIN_REMOTE_KEY, value_json: JSON.stringify(value), updated_at: now, updated_by: null })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value_json: JSON.stringify(value), updated_at: now }))
      .execute();
    return value;
  }

  /** Read-connectivity check: `git ls-remote` using the ambient SSH identity. */
  async testConnection(remoteUrl: string): Promise<ConnectionResult> {
    const remote = remoteUrl.trim();
    try {
      assertSafeRemote(remote);
    } catch (err) {
      return { ok: false, message: errMessage(err) };
    }
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', remote], {
        timeout: LS_REMOTE_TIMEOUT_MS,
      });
      const refs = stdout.trim() ? stdout.trim().split('\n').length : 0;
      return { ok: true, message: `Reachable — ${refs} branch(es) visible.` };
    } catch (err) {
      return { ok: false, message: errMessage(err).slice(0, 300) };
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
