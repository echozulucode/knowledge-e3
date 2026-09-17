import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalGitRepo, runGit, type GitIdentity } from '../src/index.js';

export const ALICE: GitIdentity = { name: 'Alice Author', email: 'alice@example.com' };
export const BOB: GitIdentity = { name: 'Bob Builder', email: 'bob@example.com' };

let gitConfigDir: string | null = null;

/**
 * Point git at a private global config so the suite runs on a machine without
 * an identity, with CRLF conversion off and `main` as the default branch.
 */
export function ensureGitEnv(): void {
  if (gitConfigDir) return;
  gitConfigDir = mkdtempSync(join(tmpdir(), 'repo-sync-gitcfg-'));
  const cfg = join(gitConfigDir, 'gitconfig');
  writeFileSync(
    cfg,
    [
      '[user]',
      '\tname = Test User',
      '\temail = test@example.com',
      '[core]',
      '\tautocrlf = false',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '',
    ].join('\n'),
  );
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
}

export interface Fixture {
  root: string;
  /** Bare origin with `main`. */
  origin: string;
  /** Clone that made the initial commit (`README.md`). */
  a: LocalGitRepo;
  /** Second clone, tracking `origin/main`. */
  b: LocalGitRepo;
  cleanup(): void;
}

export async function clone(origin: string, dir: string): Promise<LocalGitRepo> {
  await runGit(dirname(dir), ['clone', '-q', origin, dir]);
  return new LocalGitRepo(dir);
}

export async function makeFixture(): Promise<Fixture> {
  ensureGitEnv();
  const root = mkdtempSync(join(tmpdir(), 'repo-sync-'));
  const origin = join(root, 'origin.git');
  await new LocalGitRepo(origin).init({ bare: true, initialBranch: 'main' });
  const a = await clone(origin, join(root, 'a'));
  write(a, 'README.md', '# hello\n');
  await a.commit(['README.md'], 'init', ALICE);
  const pushed = await a.push();
  if (!pushed.ok) throw new Error(pushed.error);
  const b = await clone(origin, join(root, 'b'));
  return {
    root,
    origin,
    a,
    b,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

export function write(repo: LocalGitRepo, rel: string, content: string): void {
  const abs = join(repo.dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

export function remove(repo: LocalGitRepo, rel: string): void {
  unlinkSync(join(repo.dir, rel));
}

/** Sha of `ref` in the bare origin. */
export function originSha(origin: string, ref = 'main'): Promise<string> {
  return runGit(origin, ['rev-parse', '--verify', ref]);
}

export async function originHasBranch(origin: string, name: string): Promise<boolean> {
  return (await runGit(origin, ['branch', '--list', name])) !== '';
}
