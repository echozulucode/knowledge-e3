/**
 * Review-policy helpers (plan §8.2 `review` row): an item's edits go to a
 * per-item branch `e3/<slug>-<shortId>`, the branch is pushed, and a change
 * request is opened through a `ChangeRequestHost`. The server wires these into
 * `ContentCommands` in a later package; this file only owns the git + host
 * choreography.
 *
 * The item branch is written with `commitToBranch` (plumbing, no checkout), so
 * the shared working tree never leaves the base branch and other authors'
 * in-progress files are untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeRef, ChangeRequestHost, GitRepo, MergeResult, SourceRef } from '@echozedlabs/knowledge-types';
import type { CommitOptions, GitIdentity } from './git-repo.js';

export const DEFAULT_BRANCH_PREFIX = 'e3/';

/** `itemBranchName('e3/', 'my-post', 'a1b2c3')` → `e3/my-post-a1b2c3`. */
export function itemBranchName(prefix: string | undefined, slug: string, shortId: string): string {
  const p = prefix ?? DEFAULT_BRANCH_PREFIX;
  return `${p.endsWith('/') ? p : `${p}/`}${slug}-${shortId}`;
}

/** `GitRepo` plus the `LocalGitRepo` helpers the flow relies on. */
export interface ReviewRepo extends GitRepo {
  dir: string;
  commitToBranch(
    branch: string,
    paths: string[],
    message: string,
    author: GitIdentity,
    opts?: CommitOptions & { from?: string },
  ): Promise<string>;
  hasBranch(name: string): Promise<boolean>;
  deleteBranch(name: string, opts?: { remote?: boolean }): Promise<void>;
  discardPaths(paths: string[]): Promise<void>;
}

export interface OpenForItemInput {
  repo: ReviewRepo;
  /** Base branch the item branch starts from and the change targets, e.g. `main`. */
  base: string;
  branch: string;
  paths: string[];
  message: string;
  author: GitIdentity;
  coAuthors?: string[];
  host: ChangeRequestHost;
  source: SourceRef;
  title: string;
  body: string;
}

export interface OnMergedInput {
  repo: ReviewRepo;
  branch: string;
  base: string;
  /** The item's files; their working-tree copies are replaced by the merged upstream version. */
  paths?: string[];
  remoteName?: string;
}

export class ReviewFlow {
  /** Commit `paths` to the item branch (creating it from `base`), push it, open the change request. */
  async openForItem(input: OpenForItemInput): Promise<ChangeRef & { sha: string }> {
    const { repo, branch } = input;
    const sha = await repo.commitToBranch(branch, input.paths, input.message, input.author, {
      from: `refs/heads/${input.base}`,
      coAuthors: input.coAuthors,
    });
    const pushed = await repo.push(branch);
    if (!pushed.ok) throw new Error(`push of ${branch} failed: ${pushed.error ?? 'rejected'}`);
    const ref = await input.host.openChange({ source: input.source, branch, title: input.title, body: input.body });
    return { ...ref, sha };
  }

  statusOf(host: ChangeRequestHost, ref: ChangeRef): Promise<'open' | 'merged' | 'closed'> {
    return host.status(ref);
  }

  /**
   * The host merged the change: bring `base` up to date and prune the item
   * branch locally and remotely. The working-tree copies of `paths` (written
   * by the host, committed only on the item branch) are dropped first so the
   * merged upstream version can land — under `review` every edit was pushed
   * through `openForItem`, so upstream is the newer content. A file the merge
   * did not bring back is restored from the snapshot.
   */
  async onMerged(input: OnMergedInput): Promise<MergeResult> {
    const { repo, branch } = input;
    const snapshot = new Map<string, string>();
    for (const p of input.paths ?? []) {
      const abs = join(repo.dir, p);
      if (existsSync(abs)) snapshot.set(p, readFileSync(abs, 'utf8'));
    }
    await repo.discardPaths([...snapshot.keys()]);
    let merged: MergeResult;
    try {
      await repo.fetch();
      merged = await repo.merge(`${input.remoteName ?? 'origin'}/${input.base}`);
    } finally {
      for (const [p, content] of snapshot) {
        if (!existsSync(join(repo.dir, p))) writeFileSync(join(repo.dir, p), content, 'utf8');
      }
    }
    if (!merged.ok) return merged;
    if (await repo.hasBranch(branch)) {
      try {
        await repo.deleteBranch(branch, { remote: true });
      } catch {
        // Hosts commonly delete the head branch on merge; the local branch is already gone by now.
      }
    }
    return merged;
  }
}
