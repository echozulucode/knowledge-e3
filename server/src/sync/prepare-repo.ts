/**
 * Shared working-tree preparation for a registered source: make the directory a
 * repository on the source's branch with `origin` pointing at its remote.
 *
 * Extracted from `SyncService` so `ReviewService` (which stages an item's edits
 * onto a per-item branch outside the sync cycle) can use it without importing
 * the service that owns the engines — the two would otherwise form a cycle.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalGitRepo } from '@echozedlabs/repo-sync';
import type { SourceRow } from './source-registry.service.js';

/**
 * A fresh dir is initialised on the source's branch; a repo the mirror created
 * earlier (on git's default branch name) is renamed to it so the engine's
 * `push HEAD` lands on the right upstream branch.
 */
export async function prepareRepo(repo: LocalGitRepo, row: SourceRow): Promise<void> {
  mkdirSync(repo.dir, { recursive: true });
  if (!existsSync(join(repo.dir, '.git'))) {
    await repo.init({ initialBranch: row.branch ?? 'main' });
    // Commits must succeed even where no global identity is configured.
    await repo.git(['config', 'user.email', 'knowledge-e3@localhost']);
    await repo.git(['config', 'user.name', 'Knowledge E3']);
  } else if (row.branch) {
    const current = await repo.currentBranch();
    if (current && current !== row.branch && !(await repo.hasBranch(row.branch))) {
      if (await repo.headSha()) await repo.git(['branch', '-M', row.branch]);
      else await repo.git(['symbolic-ref', 'HEAD', `refs/heads/${row.branch}`]);
    }
  }
  if (row.remote_url) await repo.setRemote(row.remote_url);
}
