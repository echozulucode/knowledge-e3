/**
 * Thin `git` process wrapper shared by `LocalGitRepo` and the tests: every call
 * is `git -C <dir> …` through `execFile` with a timeout, never a shell.
 */
import { execFile } from 'node:child_process';
import { redactSecrets } from './git-credentials.js';

export interface GitExecOptions {
  /** Kill the process after this many milliseconds (default 60 s). */
  timeoutMs?: number;
  /** Extra environment for this call (merged over `process.env`). */
  env?: Record<string, string>;
  /** Return stdout byte-for-byte (default strips trailing whitespace). */
  raw?: boolean;
  /**
   * Values to scrub out of anything this call reports (issue 122). A `GitError`
   * message is durable — it becomes `content_sources.last_error` and a line in
   * the log — so a token that reached the child must not survive into one.
   */
  secrets?: readonly string[];
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
        // GIT_TERMINAL_PROMPT=0 on EVERY call (issue 122): a server has no
        // terminal to answer "Username for …" on, so without it a missing or
        // wrong credential hangs that source's sync until the timeout instead
        // of failing with something an operator can read. A caller may still
        // override it through `env`.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      },
      (err, stdout, stderr) => {
        const secrets = opts.secrets ?? [];
        const safe = (text: string): string => (secrets.length ? redactSecrets(text, secrets) : text);
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          const timedOut = e.killed === true;
          const code = typeof e.code === 'number' ? e.code : null;
          const detail = timedOut ? `timed out after ${timeout} ms` : safe(stderr).trim() || safe(err.message);
          reject(
            new GitError(`git ${args.join(' ')}: ${detail}`, args, safe(String(stdout)), safe(String(stderr)), code, timedOut),
          );
          return;
        }
        resolve(opts.raw ? String(stdout) : String(stdout).replace(/\s+$/, ''));
      },
    );
  });
}
