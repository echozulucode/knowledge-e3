/**
 * `git` sources over real temporary repositories (a bare "origin" on disk; no
 * network). The working tree is read like a folder; `pull: on-start` performs
 * one fast-forward-only pull when it is safe and skips otherwise; `manual`
 * never touches the remote. Nothing here ever commits for the source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitSourceConfig } from '../src/config.js';
import { MultiSourceBackend } from '../src/backend.js';
import { fastForwardPull, GitSource } from '../src/sources/git.js';
import { captureLogger, tempDir, writeFiles } from './helpers.js';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('git source', () => {
  let base: string;
  let cleanup: () => void;
  let origin: string;
  let clone: string;
  let upstreamWork: string;

  beforeEach(() => {
    ({ dir: base, cleanup } = tempDir('knowledge-mcp-git-'));
    origin = join(base, 'origin.git');
    upstreamWork = join(base, 'upstream-work');
    clone = join(base, 'clone');
    execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', origin]);
    execFileSync('git', ['clone', '-q', origin, upstreamWork], { stdio: 'ignore' });
    git(upstreamWork, 'checkout', '-q', '-b', 'main');
    writeFiles(upstreamWork, {
      'concepts/first.md': '---\ne3_id: first\ntitle: First Concept\ntype: Concept\n---\n\nThe first gitword concept.\n',
    });
    git(upstreamWork, 'add', '-A');
    git(upstreamWork, 'commit', '-q', '-m', 'first');
    git(upstreamWork, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '-q', '--branch', 'main', origin, clone], { stdio: 'ignore' });
    // A second commit the clone does not have yet.
    writeFiles(upstreamWork, { 'concepts/second.md': '---\ne3_id: second\ntitle: Second Concept\ntype: Concept\n---\n\nThe second gitword concept.\n' });
    git(upstreamWork, 'add', '-A');
    git(upstreamWork, 'commit', '-q', '-m', 'second');
    git(upstreamWork, 'push', '-q', 'origin', 'main');
  });
  afterEach(() => cleanup());

  const config = (pull: GitSourceConfig['pull']): GitSourceConfig => ({ id: 'repo', type: 'git', path: clone, pull, default_status: 'published' });

  async function titles(source: GitSource): Promise<string[]> {
    const backend = new MultiSourceBackend([source], captureLogger().logger);
    const r = await backend.search({ q: 'gitword', sort: 'az', include_drafts: false });
    return ((r.sources[0] as { results: { title: string }[] }).results).map((h) => h.title);
  }

  it('manual: reads the working tree and never contacts the remote', async () => {
    const head = git(clone, 'rev-parse', 'HEAD');
    const source = new GitSource(config('manual'), captureLogger().logger);
    await source.load({ startup: true });
    expect(await titles(source)).toEqual(['First Concept']);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(clone, 'rev-parse', 'origin/main')).toBe(head); // not even fetched
    expect(source.info()).toMatchObject({ type: 'git', pull: 'manual', items: 1 });
  });

  it('on-start: fast-forwards a clean checkout once, then indexes the new files', async () => {
    const { logger, lines } = captureLogger();
    const source = new GitSource(config('on-start'), logger);
    await source.load({ startup: true });
    expect(await titles(source)).toEqual(['First Concept', 'Second Concept']);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(upstreamWork, 'rev-parse', 'HEAD'));
    expect(source.info().last_pull).toMatch(/^fast-forwarded /);
    expect(lines.join('')).toContain('fast-forwarded');
    // knowledge.refresh re-reads the tree but does not pull again.
    await source.load();
    expect(source.info().items).toBe(2);
  });

  it('on-start: skips the pull when tracked files have local changes, and serves the tree as it is', async () => {
    writeFileSync(join(clone, 'concepts', 'first.md'), '---\ne3_id: first\ntitle: First Edited Locally\n---\n\ngitword edited.\n');
    const head = git(clone, 'rev-parse', 'HEAD');
    const { logger, lines } = captureLogger();
    const source = new GitSource(config('on-start'), logger);
    await source.load({ startup: true });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(await titles(source)).toEqual(['First Edited Locally']);
    expect(lines.join('')).toContain('tracked files have local changes');
    expect(git(clone, 'status', '--porcelain')).toContain('concepts/first.md'); // the edit is untouched
  });

  it('refuses to pull a diverged branch (fast-forward only, never a merge commit)', async () => {
    writeFiles(clone, { 'concepts/local.md': '---\ne3_id: local\ntitle: Local Commit\n---\n\ngitword local.\n' });
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'local');
    const head = git(clone, 'rev-parse', 'HEAD');
    const outcome = await fastForwardPull(clone);
    expect(outcome.pulled).toBe(false);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(clone, 'log', '--merges', '--oneline')).toBe('');
  });

  it('skips a path that is not the repository top level, and a branch without upstream', async () => {
    expect(await fastForwardPull(join(clone, 'concepts'))).toEqual({ pulled: false, reason: 'the path is not the top level of its repository' });
    git(clone, 'checkout', '-q', '-b', 'no-upstream');
    expect(await fastForwardPull(clone)).toEqual({ pulled: false, reason: 'branch no-upstream has no upstream' });
  });

  it('does not run repository hooks during the pull', async () => {
    const marker = join(base, 'hook-ran');
    writeFiles(clone, { '.git/hooks/post-merge': `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n` });
    try {
      execFileSync('chmod', ['+x', join(clone, '.git', 'hooks', 'post-merge')]);
    } catch {
      // Windows git runs hooks through its own sh; the mode bit is not needed.
    }
    const outcome = await fastForwardPull(clone);
    expect(outcome.pulled).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // Control: the same hook DOES run for an ordinary pull, so the assertion above is not vacuous.
    writeFiles(upstreamWork, { 'concepts/third.md': '---\ne3_id: third\ntitle: Third\n---\n\nthird.\n' });
    git(upstreamWork, 'add', '-A');
    git(upstreamWork, 'commit', '-q', '-m', 'third');
    git(upstreamWork, 'push', '-q', 'origin', 'main');
    git(clone, 'pull', '-q', '--ff-only');
    expect(existsSync(marker)).toBe(true);
  });
});
