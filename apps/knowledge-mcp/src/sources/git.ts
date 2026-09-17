/**
 * `git` source: a local git working tree, read exactly like a folder (the
 * working tree, never `.git`).
 *
 * The ONLY thing this source ever asks git to change is, with `pull: on-start`,
 * one fast-forward of the checked-out branch to its upstream at startup — and
 * only when that is certainly safe:
 *   - the configured path is the repository's top level,
 *   - HEAD is on a branch that has an upstream,
 *   - no tracked file has local changes,
 *   - `git merge --ff-only` (never a merge commit, never a rebase), with hooks
 *     disabled and every credential prompt turned off, so it can neither run
 *     repository code nor hang waiting for a password on the protocol's stdin.
 * Anything else skips the pull with a warning on stderr and serves the working
 * tree as it is. `pull: manual` (the default) never contacts a remote.
 * There is no commit, push, checkout, reset or stash anywhere in this app.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { runGit } from '@echozedlabs/repo-sync';
import type { GitSourceConfig } from '../config.js';
import type { Logger } from '../log.js';
import { LocalSourceBase } from './folder.js';
import type { SourceInfo } from './types.js';

const PULL_TIMEOUT_MS = 60_000;

export type PullOutcome =
  | { pulled: true; from: string; to: string }
  | { pulled: false; reason: string };

/** Environment for a git call that must never prompt. */
function nonInteractiveEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  if (!process.env['GIT_SSH_COMMAND']) env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes';
  return env;
}

/** The fast-forward-only pull described above. Never throws; the outcome says what happened. */
export async function fastForwardPull(dir: string): Promise<PullOutcome> {
  const env = nonInteractiveEnv();
  // A hooks path that does not exist: git finds no hooks, so none run.
  const noHooks = join(tmpdir(), `knowledge-mcp-no-hooks-${randomBytes(6).toString('hex')}`);
  const git = (args: string[]) => runGit(dir, ['-c', `core.hooksPath=${noHooks}`, '-c', 'credential.interactive=never', ...args], { env, timeoutMs: PULL_TIMEOUT_MS });
  try {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (realpathSync.native(top) !== realpathSync.native(dir)) return { pulled: false, reason: 'the path is not the top level of its repository' };
    let branch: string;
    try {
      branch = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch {
      return { pulled: false, reason: 'HEAD is detached' };
    }
    let upstream: string;
    try {
      upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    } catch {
      return { pulled: false, reason: `branch ${branch} has no upstream` };
    }
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.trim()) return { pulled: false, reason: 'tracked files have local changes' };
    const before = await git(['rev-parse', 'HEAD']);
    await git(['fetch', '--quiet', '--no-tags']);
    await git(['merge', '--ff-only', '--quiet', '@{upstream}']);
    const after = await git(['rev-parse', 'HEAD']);
    if (before === after) return { pulled: false, reason: `already up to date with ${upstream}` };
    return { pulled: true, from: before, to: after };
  } catch (err) {
    // git's own stderr can name remotes and paths; it never carries a token
    // from this app (none is ever passed to git), but keep the line short.
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    return { pulled: false, reason: message.slice(0, 300) };
  }
}

export class GitSource extends LocalSourceBase {
  readonly type = 'git' as const;
  private lastPull: string | undefined;

  constructor(
    protected override readonly config: GitSourceConfig,
    logger: Logger,
  ) {
    super(config, logger);
  }

  override async load(opts: { startup?: boolean } = {}): Promise<void> {
    if (opts.startup && this.config.pull === 'on-start') {
      const outcome = await fastForwardPull(this.config.path);
      if (outcome.pulled) {
        this.lastPull = `fast-forwarded ${outcome.from.slice(0, 12)}..${outcome.to.slice(0, 12)}`;
        this.logger.info(`[${this.id}] ${this.lastPull}`);
      } else {
        this.lastPull = `not pulled: ${outcome.reason}`;
        const quiet = outcome.reason.startsWith('already up to date');
        this.logger[quiet ? 'info' : 'warn'](`[${this.id}] ${this.lastPull}`);
      }
    }
    await super.load();
  }

  override info(): SourceInfo {
    return { ...super.info(), pull: this.config.pull, ...(this.lastPull ? { last_pull: this.lastPull } : {}) };
  }
}
