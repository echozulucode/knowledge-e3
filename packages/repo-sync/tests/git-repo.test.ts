import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, LocalGitRepo, EMPTY_TREE } from '../src/index.js';
import { ALICE, BOB, ensureGitEnv, makeFixture, originSha, remove, write, type Fixture } from './helpers.js';

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => {
  fx.cleanup();
});

describe('commit / log / changedPaths', () => {
  it('records revisions oldest → newest with exact content, author email and ISO date', async () => {
    const { a } = fx;
    write(a, 'concepts/post.md', 'v1\n');
    const sha1 = await a.commit(['concepts/post.md'], 'add post', ALICE);
    write(a, 'concepts/post.md', 'v2\nno trailing newline');
    const sha2 = await a.commit(['concepts/post.md'], 'edit post', BOB);

    const log = await a.log('concepts/post.md');
    expect(log.map((r) => r.commit)).toEqual([sha1, sha2]);
    expect(log.map((r) => r.content)).toEqual(['v1\n', 'v2\nno trailing newline']);
    expect(log.map((r) => r.authorEmail)).toEqual([ALICE.email, BOB.email]);
    expect(log[0]!.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('skips the commit that deleted the path', async () => {
    const { a } = fx;
    write(a, 'gone.md', 'x\n');
    await a.commit(['gone.md'], 'add', ALICE);
    remove(a, 'gone.md');
    await a.commit(['gone.md'], 'delete', ALICE);
    expect((await a.log('gone.md')).map((r) => r.content)).toEqual(['x\n']);
  });

  it('classifies added / modified / deleted / renamed (with from) between two shas', async () => {
    const { a } = fx;
    write(a, 'old.md', 'same content across the rename, long enough for -M to match it\n');
    write(a, 'mod.md', 'before\n');
    write(a, 'del.md', 'bye\n');
    const from = await a.commit(['old.md', 'mod.md', 'del.md'], 'seed', ALICE);

    write(a, 'docs/new.md', 'same content across the rename, long enough for -M to match it\n');
    remove(a, 'old.md');
    write(a, 'mod.md', 'after\n');
    remove(a, 'del.md');
    write(a, 'added.md', 'new\n');
    const to = await a.commit(['old.md', 'docs/new.md', 'mod.md', 'del.md', 'added.md'], 'churn', ALICE);

    const changes = await a.changedPaths(from, to);
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'added.md', change: 'added' },
      { path: 'del.md', change: 'deleted' },
      { path: 'docs/new.md', change: 'renamed', from: 'old.md' },
      { path: 'mod.md', change: 'modified' },
    ]);
    expect(await a.changedPaths(EMPTY_TREE, from)).toContainEqual({ path: 'README.md', change: 'added' });
  });

  it('sets author from the caller, committer to Knowledge E3, and Co-authored-by trailers', async () => {
    const { a } = fx;
    write(a, 'agent.md', 'by an agent\n');
    await a.commit(['agent.md'], 'agent draft', ALICE, {
      coAuthors: ['Claude Code <process:claude-code@localhost>', 'Bot Two <bot2@example.com>'],
    });
    const out = await a.git(['log', '-1', '--format=%an|%ae|%cn|%ce%n%B']);
    const [ids, ...body] = out.split('\n');
    expect(ids).toBe('Alice Author|alice@example.com|Knowledge E3|knowledge-e3@localhost');
    expect(body.join('\n')).toContain('agent draft\n\nCo-authored-by: Claude Code <process:claude-code@localhost>\nCo-authored-by: Bot Two <bot2@example.com>');
    expect(await a.git(['log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)'])).toContain('Bot Two <bot2@example.com>');
  });

  it('throws GitError when there is nothing to commit', async () => {
    await expect(fx.a.commit([], 'empty', ALICE)).rejects.toBeInstanceOf(GitError);
  });
});

describe('status', () => {
  it('reports branch, untracked/modified paths, and ahead/behind against the upstream', async () => {
    const { a, b } = fx;
    write(b, 'draft.md', 'wip\n');
    let s = await b.status();
    expect(s).toEqual({ branch: 'main', ahead: 0, behind: 0, dirty: ['draft.md'], conflicted: [] });
    expect(await b.isClean()).toBe(false);

    await b.commit(['draft.md'], 'draft', BOB);
    expect((await b.status()).ahead).toBe(1);

    write(a, 'README.md', '# hello again\n');
    await a.commit(['README.md'], 'edit', ALICE);
    expect(await a.push()).toEqual({ ok: true });
    await b.fetch();
    s = await b.status();
    expect([s.ahead, s.behind]).toEqual([1, 1]);
  });
});

describe('merge', () => {
  it('fast-forwards when possible', async () => {
    const { a, b, origin } = fx;
    write(a, 'new.md', 'n\n');
    await a.commit(['new.md'], 'add', ALICE);
    await a.push();
    await b.fetch();
    expect(await b.merge('origin/main')).toEqual({ ok: true, conflicts: [] });
    expect(await b.headSha()).toBe(await originSha(origin));
    expect(existsSync(join(b.dir, 'new.md'))).toBe(true);
  });

  it('creates a 3-way merge commit for divergent non-overlapping changes', async () => {
    const { a, b } = fx;
    write(a, 'from-a.md', 'a\n');
    await a.commit(['from-a.md'], 'a', ALICE);
    await a.push();
    write(b, 'from-b.md', 'b\n');
    await b.commit(['from-b.md'], 'b', BOB);
    await b.fetch();
    expect(await b.merge('origin/main')).toEqual({ ok: true, conflicts: [] });
    expect((await b.git(['rev-list', '--parents', '-1', 'HEAD'])).split(' ')).toHaveLength(3);
    expect(existsSync(join(b.dir, 'from-a.md'))).toBe(true);
    expect(await b.git(['log', '-1', '--format=%cn'])).toBe('Knowledge E3');
  });

  it('reports conflicts, exposes both sides, and can resolve or abort', async () => {
    const { a, b } = fx;
    write(a, 'README.md', '# from a\n');
    await a.commit(['README.md'], 'a', ALICE);
    await a.push();
    write(b, 'README.md', '# from b\n');
    const bHead = await b.commit(['README.md'], 'b', BOB);
    await b.fetch();

    expect(await b.merge('origin/main')).toEqual({ ok: false, conflicts: ['README.md'] });
    expect((await b.status()).conflicted).toEqual(['README.md']);
    expect(await b.conflictSides('README.md')).toEqual({ ours: '# from b\n', theirs: '# from a\n', base: '# hello\n' });

    await b.abortMerge();
    expect(await b.isClean()).toBe(true);
    expect(await b.headSha()).toBe(bHead);
    expect(readFileSync(join(b.dir, 'README.md'), 'utf8')).toBe('# from b\n');

    expect((await b.merge('origin/main')).ok).toBe(false);
    await b.resolve('README.md', '# from a\n');
    expect((await b.status()).conflicted).toEqual([]);
    const merged = await b.commit([], 'resolve', BOB);
    expect(merged).not.toBe(bHead);
    expect(await b.isClean()).toBe(true);
    expect(readFileSync(join(b.dir, 'README.md'), 'utf8')).toBe('# from a\n');
  });
});

describe('push', () => {
  it('is rejected on non-fast-forward and succeeds after merging', async () => {
    const { a, b, origin } = fx;
    write(a, 'x.md', 'x\n');
    await a.commit(['x.md'], 'x', ALICE);
    await a.push();
    write(b, 'y.md', 'y\n');
    await b.commit(['y.md'], 'y', BOB);

    const rejected = await b.push();
    expect(rejected.ok).toBe(false);
    expect(rejected.rejected).toBe(true);
    expect(rejected.error).toBeTruthy();

    await b.fetch();
    expect((await b.merge('origin/main')).ok).toBe(true);
    expect(await b.push()).toEqual({ ok: true });
    expect(await originSha(origin)).toBe(await b.headSha());
  });

  it('pushes a named branch and can delete it remotely', async () => {
    const { a, origin } = fx;
    await a.checkout('feature', { create: true, from: 'main' });
    write(a, 'f.md', 'f\n');
    await a.commit(['f.md'], 'f', ALICE);
    await a.checkout('main');
    expect(await a.currentBranch()).toBe('main');
    expect(await a.push('feature')).toEqual({ ok: true });
    expect(await originSha(origin, 'feature')).toMatch(/^[0-9a-f]{40}$/);
    await a.deleteBranch('feature', { remote: true });
    expect(await a.hasBranch('feature')).toBe(false);
    await expect(originSha(origin, 'feature')).rejects.toBeInstanceOf(GitError);
  });
});

describe('commitToBranch', () => {
  it('commits working-tree paths onto another branch without leaving the current one', async () => {
    const { a } = fx;
    const mainHead = await a.headSha();
    write(a, 'concepts/post.md', 'draft 1\n');
    const sha1 = await a.commitToBranch('e3/post-abc', ['concepts/post.md'], 'draft 1', ALICE, {
      from: 'refs/heads/main',
      coAuthors: ['Agent <agent@example.com>'],
    });
    expect(await a.currentBranch()).toBe('main');
    expect(await a.headSha()).toBe(mainHead);
    expect(await a.hasBranch('e3/post-abc')).toBe(true);
    expect(await a.git(['show', 'e3/post-abc:concepts/post.md'])).toBe('draft 1');
    expect(await a.git(['log', '-1', '--format=%an|%cn|%(trailers:key=Co-authored-by,valueonly)', 'e3/post-abc'])).toBe(
      'Alice Author|Knowledge E3|Agent <agent@example.com>',
    );
    expect((await a.status()).dirty).toEqual(['concepts/post.md']);

    write(a, 'concepts/post.md', 'draft 2\n');
    const sha2 = await a.commitToBranch('e3/post-abc', ['concepts/post.md'], 'draft 2', ALICE);
    expect(await a.git(['rev-parse', 'e3/post-abc^'])).toBe(sha1);
    expect(await a.git(['rev-parse', 'e3/post-abc'])).toBe(sha2);
    expect(await a.git(['show', 'e3/post-abc:README.md'])).toBe('# hello');
  });
});

describe('init / remotes', () => {
  it('initialises a repo with a null head and wires a remote', async () => {
    ensureGitEnv();
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-init-'));
    try {
      const r = new LocalGitRepo(join(dir, 'fresh'));
      await r.init({ initialBranch: 'main' });
      expect(await r.headSha()).toBeNull();
      expect(await r.currentBranch()).toBe('main');
      expect(await r.hasRemote()).toBe(false);
      await r.setRemote(fx.origin);
      expect(await r.hasRemote()).toBe(true);
      await r.setRemote(fx.origin);
      expect(await r.git(['remote', 'get-url', 'origin'])).toBe(fx.origin);
      await r.fetch();
      expect((await r.merge('origin/main')).ok).toBe(true);
      expect(await r.headSha()).toBe(await originSha(fx.origin));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('honours the command timeout', async () => {
    const r = new LocalGitRepo(fx.a.dir, { timeoutMs: 1 });
    await expect(r.git(['log', '--all'])).rejects.toMatchObject({ name: 'GitError', timedOut: true });
  });
});
