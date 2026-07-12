import { isAbsolute, join, resolve } from 'node:path';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { GitRevisionMirrorAdapter, type MirrorOptions } from './git-revision-mirror.adapter.js';
import { MAIN_REMOTE_KEY } from './repo-config.service.js';
import { loadServerConfig } from '../config/server-config.js';
import type { RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

const DEFAULT_SLUG = 'default';

/** Where one item's git mirror lands. */
interface Target {
  repoDir: string;
  /** Concept directory within that repo (topic subtree prefix, or just `concepts`). */
  conceptDir: string;
  remoteUrl: string | null;
  branch: string | null;
}

/**
 * Routes each item's git mirror to the right repository (ADR-0001 multi-repo,
 * topic-first layout). The model is a **hybrid**, resolved fresh per write so
 * config changes take effect without a restart:
 *
 *  - **Dedicated repo** (the topic has a `space_repos` row) → its own repo at
 *    `<root>/topics/<slug>/`, a self-contained bundle (`concepts/…`).
 *  - **Main repo** (default) → `<root>/main/`, with the topic as a subtree
 *    (`<slug>/concepts/…`); pushed via the instance-level main remote
 *    (`app_config` `git.main_remote`).
 *
 * Topic-first subtrees keep the 1:1-vs-monorepo decision reversible: a topic
 * folder is a self-contained bundle that `git subtree split/add --prefix=<slug>`
 * can move between the shared repo and a dedicated one, with history.
 */
export class RoutingRevisionMirror implements RevisionMirrorPort, OnModuleDestroy {
  private readonly logger = new Logger(RoutingRevisionMirror.name);
  private readonly mainDir: string;
  private readonly topicsDir: string;
  private readonly repos = new Map<string, GitRevisionMirrorAdapter>();

  constructor(
    root: string,
    private readonly db: Kysely<Database>,
    private readonly opts: MirrorOptions = {},
  ) {
    const base = isAbsolute(root) ? root : resolve(process.cwd(), root);
    this.mainDir = join(base, 'main');
    this.topicsDir = join(base, 'topics');
  }

  async afterItemVersionPersisted(event: RevisionMirrorEvent): Promise<void> {
    const target = await this.resolve(event);
    const repo = this.repoFor(target.repoDir);
    repo.setRemote(target.remoteUrl, target.branch); // hot-reload the remote
    await repo.enqueue(event, target.conceptDir);
  }

  /** Flush every repo (shutdown, or before a backfill assertion). */
  async flush(): Promise<void> {
    for (const repo of this.repos.values()) {
      await repo.flush().catch((err) => this.logger.warn(`flush failed: ${String(err)}`));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush().catch(() => undefined);
  }

  private repoFor(repoDir: string): GitRevisionMirrorAdapter {
    let repo = this.repos.get(repoDir);
    if (!repo) {
      repo = new GitRevisionMirrorAdapter(repoDir, this.db, this.opts);
      this.repos.set(repoDir, repo);
    }
    return repo;
  }

  /** Resolve the target repo/layout/remote for an event — read fresh each time. */
  private async resolve(event: RevisionMirrorEvent): Promise<Target> {
    const slug = await this.spaceSlug(event.spaceId);

    const dedicated = event.spaceId ? await this.dedicatedRepo(event.spaceId) : null;
    if (dedicated) {
      return {
        repoDir: join(this.topicsDir, slug),
        conceptDir: 'concepts',
        remoteUrl: dedicated.remoteUrl,
        branch: dedicated.branch,
      };
    }

    const main = await this.mainRemote();
    return {
      repoDir: this.mainDir,
      conceptDir: `${slug}/concepts`,
      remoteUrl: main?.remoteUrl ?? null,
      branch: main?.branch ?? null,
    };
  }

  private async dedicatedRepo(
    spaceId: string,
  ): Promise<{ remoteUrl: string | null; branch: string | null } | null> {
    const row = await this.db
      .selectFrom('space_repos')
      .select(['remote_url', 'branch', 'enabled'])
      .where('space_id', '=', spaceId)
      .executeTakeFirst();
    if (!row) return null;
    return { remoteUrl: row.enabled === 1 ? row.remote_url : null, branch: row.branch };
  }

  private async mainRemote(): Promise<{ remoteUrl: string | null; branch: string | null } | null> {
    const row = await this.db
      .selectFrom('app_config')
      .select('value_json')
      .where('key', '=', MAIN_REMOTE_KEY)
      .executeTakeFirst();
    if (!row) {
      // Fall back to a main remote declared in the config file, if any.
      const fileRemote = loadServerConfig().git.mainRemote;
      return fileRemote ? { remoteUrl: fileRemote, branch: null } : null;
    }
    try {
      const cfg = JSON.parse(row.value_json) as { remote_url?: string; branch?: string | null; enabled?: boolean };
      if (!cfg.enabled || !cfg.remote_url) return null;
      return { remoteUrl: cfg.remote_url, branch: cfg.branch ?? null };
    } catch {
      return null;
    }
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
