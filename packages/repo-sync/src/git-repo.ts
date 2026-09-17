/**
 * `LocalGitRepo` — the `GitRepo` port (knowledge-types) over one working
 * directory, plus the helpers `SyncEngine` and `ReviewFlow` need.
 *
 * Commit identity (plan §8.4): the *author* is the acting user; the *committer*
 * is always "Knowledge E3" (`-c user.name/user.email`), so `git log` tells the
 * two apart. Agent-originated commits add `Co-authored-by:` trailers.
 *
 * Every method shells out to `git -C <dir>` with a timeout; nothing here keeps
 * state between calls, so one instance can be shared by the engine and the host.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitRepo, MergeResult, PathChange, PushResult, RepoStatus, Revision } from '@echozedlabs/knowledge-types';
import { GitError, runGit, type GitExecOptions } from './git.js';

export interface GitIdentity {
  name: string;
  email: string;
}

export const SYSTEM_COMMITTER: GitIdentity = { name: 'Knowledge E3', email: 'knowledge-e3@localhost' };

/** SHA of git's empty tree; `changedPaths(EMPTY_TREE, sha)` lists everything in `sha`. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface LocalGitRepoOptions {
  /** Per-command timeout (default 60 s). */
  timeoutMs?: number;
  /** Committer identity for every commit this instance makes (default `SYSTEM_COMMITTER`). */
  committer?: GitIdentity;
  /** Remote name to fetch from / push to (default `origin`). */
  remoteName?: string;
}

export interface CommitOptions {
  /** `Co-authored-by:` trailers, e.g. `["Claude Code <process:claude-code@localhost>"]`. */
  coAuthors?: string[];
}

export interface ConflictSides {
  /** Stage 2 — our side (HEAD). `null` when our side deleted the file. */
  ours: string | null;
  /** Stage 3 — their side (the merged ref). `null` when their side deleted the file. */
  theirs: string | null;
  /** Stage 1 — common ancestor. `null` for add/add conflicts. */
  base: string | null;
}

const CHANGE_BY_STATUS: Record<string, PathChange['change']> = {
  A: 'added',
  C: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
};

const FIELD_SEP = String.fromCharCode(0x1f);

export class LocalGitRepo implements GitRepo {
  readonly dir: string;
  readonly remoteName: string;
  private readonly committer: GitIdentity;
  private readonly timeoutMs: number | undefined;

  constructor(dir: string, opts: LocalGitRepoOptions = {}) {
    this.dir = dir;
    this.committer = opts.committer ?? SYSTEM_COMMITTER;
    this.remoteName = opts.remoteName ?? 'origin';
    this.timeoutMs = opts.timeoutMs;
  }

  /** Run `git -C <dir> args…`. Exposed for hosts that need one-off plumbing. */
  git(args: string[], opts: GitExecOptions = {}): Promise<string> {
    return runGit(this.dir, args, { timeoutMs: this.timeoutMs, ...opts });
  }

  private committerArgs(): string[] {
    return ['-c', `user.name=${this.committer.name}`, '-c', `user.email=${this.committer.email}`];
  }

  private static withTrailers(message: string, coAuthors: string[] | undefined): string {
    if (!coAuthors?.length) return message;
    return `${message.replace(/\s+$/, '')}\n\n${coAuthors.map((c) => `Co-authored-by: ${c}`).join('\n')}`;
  }

  // ---------------------------------------------------------------- GitRepo

  async status(): Promise<RepoStatus> {
    const branch = await this.currentBranch();
    let ahead = 0;
    let behind = 0;
    try {
      const counts = await this.git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      const [a, b] = counts.split(/\s+/);
      ahead = Number(a ?? 0);
      behind = Number(b ?? 0);
    } catch (e) {
      if (!(e instanceof GitError)) throw e; // no upstream or unborn HEAD ⇒ 0/0
    }
    const porcelain = await this.git(['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all']);
    const dirty = porcelain
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => {
        const p = l.slice(3);
        const arrow = p.indexOf(' -> ');
        return arrow >= 0 ? p.slice(arrow + 4) : p;
      });
    const conflicted = await this.conflictedPaths();
    return { branch, ahead, behind, dirty, conflicted };
  }

  async commit(paths: string[], message: string, author: GitIdentity, opts: CommitOptions = {}): Promise<string> {
    if (paths.length) await this.git(['add', '-A', '--', ...paths]);
    await this.git([
      ...this.committerArgs(),
      'commit',
      '-q',
      `--author=${author.name} <${author.email}>`,
      '-m',
      LocalGitRepo.withTrailers(message, opts.coAuthors),
    ]);
    return this.git(['rev-parse', 'HEAD']);
  }

  async fetch(): Promise<void> {
    await this.git(['fetch', '-q', '--prune', this.remoteName]);
  }

  /** Fast-forward when possible, else a 3-way merge; on conflict the tree stays conflicted (see `abortMerge`/`resolve`). */
  async merge(ref: string): Promise<MergeResult> {
    try {
      await this.git(['merge', '-q', '--ff-only', ref]);
      return { ok: true, conflicts: [] };
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
    }
    try {
      await this.git([...this.committerArgs(), 'merge', '-q', '--no-edit', ref]);
      return { ok: true, conflicts: [] };
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      const conflicts = await this.conflictedPaths();
      if (!conflicts.length) throw e;
      return { ok: false, conflicts };
    }
  }

  async push(ref?: string): Promise<PushResult> {
    try {
      await this.git(['push', '-q', '--porcelain', '-u', this.remoteName, ref ?? 'HEAD']);
      return { ok: true };
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      const out = `${e.stdout}\n${e.stderr}`;
      const rejected = /\[rejected\]|non-fast-forward|fetch first/.test(out);
      return rejected ? { ok: false, rejected: true, error: e.message } : { ok: false, error: e.message };
    }
  }

  async changedPaths(from: string, to: string): Promise<PathChange[]> {
    const out = await this.git(['diff', '--name-status', '-M', '-z', from, to]);
    const fields = out.split('\0').filter((f) => f.length > 0);
    const changes: PathChange[] = [];
    for (let i = 0; i < fields.length; ) {
      const status = fields[i]!.charAt(0);
      const change = CHANGE_BY_STATUS[status] ?? 'modified';
      if (status === 'R' || status === 'C') {
        const oldPath = fields[i + 1]!;
        const newPath = fields[i + 2]!;
        changes.push(status === 'R' ? { path: newPath, change, from: oldPath } : { path: newPath, change });
        i += 3;
      } else {
        changes.push({ path: fields[i + 1]!, change });
        i += 2;
      }
    }
    return changes;
  }

  /** Revisions of `path`, oldest first; commits that removed the path are skipped. */
  async log(path: string): Promise<Revision[]> {
    const out = await this.git(['log', '--reverse', `--format=%H%x1f%aI%x1f%ae`, '--', path]);
    const revisions: Revision[] = [];
    for (const line of out.split('\n').filter(Boolean)) {
      const [commit, dateIso, authorEmail] = line.split(FIELD_SEP);
      let content: string;
      try {
        content = await this.git(['show', `${commit}:${path}`], { raw: true });
      } catch (e) {
        if (e instanceof GitError) continue;
        throw e;
      }
      revisions.push({ commit, dateIso, authorEmail, content });
    }
    return revisions;
  }

  // ---------------------------------------------------------------- helpers

  async init(opts: { bare?: boolean; initialBranch?: string } = {}): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const args = ['init', '-q'];
    if (opts.bare) args.push('--bare');
    if (opts.initialBranch) args.push(`--initial-branch=${opts.initialBranch}`);
    await this.git(args);
  }

  /** `null` on an unborn branch. */
  async headSha(): Promise<string | null> {
    try {
      return await this.git(['rev-parse', '--verify', '-q', 'HEAD']);
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  /** `null` when HEAD is detached. */
  async currentBranch(): Promise<string | null> {
    try {
      return await this.git(['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  async hasBranch(name: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '-q', `refs/heads/${name}`]);
      return true;
    } catch (e) {
      if (e instanceof GitError) return false;
      throw e;
    }
  }

  async checkout(branch: string, opts: { create?: boolean; from?: string } = {}): Promise<void> {
    const args = ['checkout', '-q'];
    if (opts.create) args.push('-b', branch, ...(opts.from ? [opts.from] : []));
    else args.push(branch);
    await this.git(args);
  }

  async deleteBranch(name: string, opts: { remote?: boolean } = {}): Promise<void> {
    await this.git(['branch', '-q', '-D', name]);
    if (opts.remote) await this.git(['push', '-q', this.remoteName, '--delete', name]);
  }

  /**
   * Commit `paths` (as they are in the working tree) onto `branch` without
   * checking it out: the shared working tree stays on its current branch, so
   * other in-progress edits are untouched. Creates the branch from `from`
   * (default HEAD) when it does not exist. Returns the new commit sha.
   */
  async commitToBranch(
    branch: string,
    paths: string[],
    message: string,
    author: GitIdentity,
    opts: CommitOptions & { from?: string } = {},
  ): Promise<string> {
    const parent = (await this.hasBranch(branch)) ? `refs/heads/${branch}` : (opts.from ?? 'HEAD');
    const indexFile = join(tmpdir(), `e3-index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(['read-tree', parent], { env });
      await this.git(['update-index', '--add', '--remove', '--', ...paths], { env });
      const tree = await this.git(['write-tree'], { env });
      const sha = await this.git(
        ['commit-tree', tree, '-p', parent, '-m', LocalGitRepo.withTrailers(message, opts.coAuthors)],
        {
          env: {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: this.committer.name,
            GIT_COMMITTER_EMAIL: this.committer.email,
          },
        },
      );
      await this.git(['update-ref', `refs/heads/${branch}`, sha]);
      return sha;
    } finally {
      if (existsSync(indexFile)) unlinkSync(indexFile);
    }
  }

  async setRemote(url: string): Promise<void> {
    if (await this.hasRemote()) await this.git(['remote', 'set-url', this.remoteName, url]);
    else await this.git(['remote', 'add', this.remoteName, url]);
  }

  async hasRemote(): Promise<boolean> {
    const remotes = await this.git(['remote']);
    return remotes.split('\n').includes(this.remoteName);
  }

  async abortMerge(): Promise<void> {
    await this.git(['merge', '--abort']);
  }

  async conflictSides(path: string): Promise<ConflictSides> {
    const stage = async (n: 1 | 2 | 3): Promise<string | null> => {
      try {
        return await this.git(['show', `:${n}:${path}`], { raw: true });
      } catch (e) {
        if (e instanceof GitError) return null;
        throw e;
      }
    };
    return { base: await stage(1), ours: await stage(2), theirs: await stage(3) };
  }

  /** Write `content` to `path` and stage it (marks a conflict as resolved). */
  async resolve(path: string, content: string): Promise<void> {
    const abs = join(this.dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    await this.git(['add', '--', path]);
  }

  /**
   * Drop the working-tree copies of `paths`: tracked files go back to HEAD,
   * untracked ones are deleted. Lets a merge land files the host wrote locally.
   */
  async discardPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const tracked = (await this.git(['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean);
    if (tracked.length) await this.git(['checkout', '-q', 'HEAD', '--', ...tracked]);
    for (const p of paths) {
      const abs = join(this.dir, p);
      if (!tracked.includes(p) && existsSync(abs)) unlinkSync(abs);
    }
  }

  async isClean(): Promise<boolean> {
    return (await this.git(['status', '--porcelain'])) === '';
  }

  private async conflictedPaths(): Promise<string[]> {
    const out = await this.git(['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U']);
    return out.split('\n').filter(Boolean);
  }
}
