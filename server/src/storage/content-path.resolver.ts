import { isAbsolute, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { conceptDirFor } from '@echozedlabs/content-store';
import type { GitCredentialRef } from '@echozedlabs/repo-sync';
import type { Database, SyncMode } from '../db/schema.js';
import { loadServerConfig } from '../config/server-config.js';
import { gitCredentialOf, resolveLocalDir, SourceRegistryService, type SourceRow } from '../sync/source-registry.service.js';

const DEFAULT_SLUG = 'default';

/** Where one item's canonical file (and its git mirror) lands. */
export interface ContentTarget {
  /** Source registry id (plan §7.4): `main`, or `topic:<slug>` for a dedicated repo. */
  sourceId: 'main' | `topic:${string}`;
  /** Absolute working-tree dir of the repository. */
  repoDir: string;
  /** Concept directory within that repo (topic subtree prefix, or just `concepts`). */
  conceptDir: string;
  remoteUrl: string | null;
  branch: string | null;
  /** NAMES of this source's git credential (issue 122); never a token. Null when unregistered. */
  credential: GitCredentialRef | null;
  dedicated: boolean;
  /** Sync policy of the source (plan §8.2); `direct` when the source is not registered. */
  mode: SyncMode;
}

/**
 * Resolves a topic to its repository + layout (ADR-0001 multi-repo, topic-first).
 * The model is a **hybrid**, resolved fresh per call so config changes take
 * effect without a restart:
 *
 *  - **Dedicated repo** (the topic has a `content_sources` row, `topic:<slug>`)
 *    → its own repo, by default at `<root>/topics/<slug>/`, a self-contained
 *    bundle (`concepts/…`).
 *  - **Main repo** (default) → `<root>/main/`, with the topic as a subtree
 *    (`<slug>/concepts/…`); pushed via the registry's `main` entry.
 *
 * Topic-first subtrees keep the 1:1-vs-monorepo decision reversible: a topic
 * folder is a self-contained bundle that `git subtree split/add --prefix=<slug>`
 * can move between the shared repo and a dedicated one, with history.
 *
 * Shared by the write-first command (which writes the file) and the routing
 * mirror (which commits it), so both land on the same path.
 */
@Injectable()
export class ContentPathResolver {
  readonly root: string;
  readonly mainDir: string;
  readonly topicsDir: string;
  private readonly registry: SourceRegistryService;

  constructor(root: string, private readonly db: Kysely<Database>) {
    this.root = isAbsolute(root) ? root : resolve(process.cwd(), root);
    this.mainDir = join(this.root, 'main');
    this.topicsDir = join(this.root, 'topics');
    this.registry = new SourceRegistryService(db);
  }

  /** Resolve the target repo/layout/remote for a space — read fresh each time. */
  async resolve(spaceId: string | null): Promise<ContentTarget> {
    const slug = await this.spaceSlug(spaceId);

    const dedicated = spaceId && spaceId !== 'space_default' ? await this.registry.forSpace(spaceId) : null;
    if (dedicated) {
      return {
        sourceId: `topic:${slug}`,
        repoDir: this.dirOf(dedicated),
        conceptDir: conceptDirFor(slug, { dedicated: true }),
        remoteUrl: dedicated.enabled === 1 ? dedicated.remote_url : null,
        branch: dedicated.branch,
        credential: gitCredentialOf(dedicated),
        dedicated: true,
        mode: dedicated.mode,
      };
    }

    const main = await this.registry.get('main');
    // With no registry row, fall back to a main remote declared in the config file, if any.
    const fileRemote = main ? null : (loadServerConfig().git.mainRemote ?? null);
    return {
      sourceId: 'main',
      repoDir: main ? this.dirOf(main) : this.mainDir,
      conceptDir: conceptDirFor(slug, { dedicated: false }),
      remoteUrl: main ? (main.enabled === 1 ? main.remote_url : null) : fileRemote,
      branch: main?.branch ?? null,
      // A main repo declared only in the config file names no credential of its
      // own; its pushes fall back to the instance-wide GIT_HTTPS_TOKEN.
      credential: main ? gitCredentialOf(main) : null,
      dedicated: false,
      mode: main?.mode ?? 'direct',
    };
  }

  /** Absolute working-tree dir of a registry row (`local_dir` under the content root unless absolute). */
  dirOf(row: SourceRow): string {
    return resolveLocalDir(row.local_dir, this.root);
  }

  private async spaceSlug(spaceId: string | null): Promise<string> {
    if (!spaceId || spaceId === 'space_default') return DEFAULT_SLUG;
    const row = await this.db
      .selectFrom('spaces')
      .select('slug')
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return row?.slug ?? DEFAULT_SLUG;
  }
}
