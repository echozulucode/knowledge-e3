import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { redactSecrets, resolveGitCredential } from '@echozedlabs/repo-sync';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { gitCredentialOf } from '../sync/source-registry.service.js';
import { OkfImportService, type OkfImportResult } from '../okf/okf-import.service.js';
import type { ReadActor } from '../pages/pages.service.js';
import { RepoConfigService } from './repo-config.service.js';

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 60_000;
const RESERVED = new Set(['index.md', 'log.md']);

/**
 * Pull a topic's bound backend repository **into** Knowledge E3 (git → E3), the
 * reverse of the mirror. Clones the dedicated remote, reads its OKF bundle, and
 * imports every concept **into the bound topic** (overriding each file's own
 * topic), keyed on `e3_id` then title so a re-pull updates rather than duplicates.
 *
 * This is a bootstrap/refresh import, not continuous two-way sync: after a pull,
 * E3 owns the items and the mirror pushes future edits back out.
 */
@Injectable()
export class RepoPullService {
  private readonly logger = new Logger(RepoPullService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly okfImport: OkfImportService,
    private readonly repos: RepoConfigService,
  ) {}

  async pullIntoTopic(spaceId: string, actor: ReadActor): Promise<OkfImportResult> {
    const bound = await this.repos.forSpace(spaceId);
    if (!bound?.remote_url) {
      throw new BadRequestException('No dedicated repository is bound to this topic.');
    }
    const repo = { remote_url: bound.remote_url, branch: bound.branch, default_status: bound.default_status };
    const space = await this.db
      .selectFrom('spaces')
      .select(['slug', 'name'])
      .where('id', '=', spaceId)
      .executeTakeFirst();
    if (!space) throw new NotFoundException('Topic not found.');

    const tmp = mkdtempSync(join(tmpdir(), 'e3-pull-'));
    try {
      // The clone authenticates as THIS source (issue 122): the token reaches
      // git through the child's environment via GIT_ASKPASS, never through the
      // URL — a token in the URL would be written into the clone's
      // `.git/config` on disk and printed in the error below.
      const cred = resolveGitCredential(gitCredentialOf(bound));
      const args = [...(cred?.args ?? []), 'clone', '--depth', '1'];
      if (repo.branch) args.push('--branch', repo.branch);
      args.push(repo.remote_url, tmp);
      try {
        await execFileAsync('git', args, {
          timeout: CLONE_TIMEOUT_MS,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(cred?.env ?? {}) },
        });
      } catch (err) {
        throw new BadRequestException(
          `Could not clone the repository: ${redactSecrets(gitError(err), cred?.secrets ?? [])}`,
        );
      }

      const files = readConceptFiles(tmp);
      // Force the destination topic so the repo's content lands under this topic,
      // and apply the binding's import default for files that declare no state.
      const result = await this.okfImport.importBundleFiles(actor, files, {
        space: space.slug,
        // A pull is an admin action on the REST door (POST /repos/:spaceId/pull).
        via: 'rest',
        ...(repo.default_status ? { defaultStatus: repo.default_status } : {}),
      });
      this.logger.log(
        `pulled ${repo.remote_url} into topic ${space.slug}: ${result.created} created, ` +
          `${result.updated} updated, ${result.defaulted} defaulted to ${result.default_status}` +
          (result.unrecognized_status.length
            ? `, ${result.unrecognized_status.length} with an unrecognized status value`
            : ''),
      );
      return result;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Read every non-reserved concept `.md` under a cloned bundle (skips `.git`). */
function readConceptFiles(root: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else if (entry.name.endsWith('.md') && !RESERVED.has(entry.name)) {
        out.push({ path: childRel, content: readFileSync(join(abs, entry.name), 'utf8') });
      }
    }
  };
  walk(root, '');
  return out;
}

function gitError(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string') {
    const stderr = (err as { stderr: string }).stderr.trim();
    if (stderr) return stderr.slice(0, 300);
  }
  return err instanceof Error ? err.message : String(err);
}
