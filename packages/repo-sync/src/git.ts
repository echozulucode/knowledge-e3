/**
 * Thin `git` process wrapper shared by `LocalGitRepo` and the tests: every call
 * is `git -C <dir> …` through `execFile` with a timeout, never a shell.
 */
import { execFile } from 'node:child_process';

export interface GitExecOptions {
  /** Kill the process after this many milliseconds (default 60 s). */
  timeoutMs?: number;
  /** Extra environment for this call (merged over `process.env`). */
  env?: Record<string, string>;
  /** Return stdout byte-for-byte (default strips trailing whitespace). */
  raw?: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number | null,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Run `git -C dir args…`; resolves with stdout (trailing whitespace stripped unless `raw`), rejects with `GitError` on non-zero exit. */
export function runGit(dir: string, args: string[], opts: GitExecOptions = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          const timedOut = e.killed === true;
          const code = typeof e.code === 'number' ? e.code : null;
          const detail = timedOut ? `timed out after ${timeout} ms` : stderr.trim() || err.message;
          reject(new GitError(`git ${args.join(' ')}: ${detail}`, args, String(stdout), String(stderr), code, timedOut));
          return;
        }
        resolve(opts.raw ? String(stdout) : String(stdout).replace(/\s+$/, ''));
      },
    );
  });
}
