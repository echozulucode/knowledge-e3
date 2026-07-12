import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { OkfImportService, type OkfImportResult } from '../okf/okf-import.service.js';
import type { ReadActor } from '../pages/pages.service.js';

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
  ) {}

  async pullIntoTopic(spaceId: string, actor: ReadActor): Promise<OkfImportResult> {
    const repo = await this.db
      .selectFrom('space_repos')
      .select(['remote_url', 'branch'])
      .where('space_id', '=', spaceId)
      .executeTakeFirst();
    if (!repo) {
      throw new BadRequestException('No dedicated repository is bound to this topic.');
    }
    const space = await this.db
      .selectFrom('spaces')
      .select(['slug', 'name'])
      .where('id', '=', spaceId)
      .executeTakeFirst();
    if (!space) throw new NotFoundException('Topic not found.');

    const tmp = mkdtempSync(join(tmpdir(), 'e3-pull-'));
    try {
      const args = ['clone', '--depth', '1'];
      if (repo.branch) args.push('--branch', repo.branch);
      args.push(repo.remote_url, tmp);
      try {
        await execFileAsync('git', args, { timeout: CLONE_TIMEOUT_MS });
      } catch (err) {
        throw new BadRequestException(`Could not clone the repository: ${gitError(err)}`);
      }

      const files = readConceptFiles(tmp);
      // Force the destination topic so the repo's content lands under this topic.
      const result = await this.okfImport.importBundleFiles(actor, files, { space: space.slug });
      this.logger.log(
        `pulled ${repo.remote_url} into topic ${space.slug}: ${result.created} created, ${result.updated} updated`,
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
