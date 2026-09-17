import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PathChange, SourceRef, SyncMode, SyncStatus } from '@echozedlabs/knowledge-types';
import { DEFAULT_PUSH_INTERVAL_MS, LocalGitRepo, SyncEngine, type SyncHooks, type SyncRepo } from '../src/index.js';
import { ALICE, BOB, makeFixture, originSha, write, type Fixture } from './helpers.js';

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => {
  fx.cleanup();
});

interface Harness {
  engine: SyncEngine;
  changed: { changes: PathChange[]; ctx: { from: string; to: string } }[];
  conflicts: string[][];
  states: SyncStatus['state'][];
  clock: { now: number };
}

function harness(repo: SyncRepo, mode: SyncMode, opts: { onChangedPaths?: SyncHooks['onChangedPaths'] } = {}): Harness {
  const h: Harness = { changed: [], conflicts: [], states: [], clock: { now: 1_000_000 } } as unknown as Harness;
  const source: SourceRef = { id: 'src-1', local: (repo as LocalGitRepo).dir, remote: fx.origin, branch: 'main', role: 'authoritative', policy: { mode } };
  h.engine = new SyncEngine({
    source,
    repo,
    policy: source.policy,
    clock: () => h.clock.now,
    hooks: {
      onChangedPaths: async (changes, ctx) => {
        h.changed.push({ changes, ctx });
        await opts.onChangedPaths?.(changes, ctx);
      },
      onConflict: async (paths) => {
        h.conflicts.push(paths);
      },
      onStatus: (s) => {
        h.states.push(s.state);
      },
    },
  });
  return h;
}

describe('inbound changes', () => {
  it('fetches, merges upstream and hands the diff to onChangedPaths', async () => {
    const { a, b } = fx;
    const before = await b.headSha();
    write(a, 'concepts/x.md', 'x\n');
    write(a, 'README.md', '# changed\n');
    await a.commit(['concepts/x.md', 'README.md'], 'upstream edit', ALICE);
    await a.push();

    const h = harness(b, 'direct');
    const status = await h.engine.runCycle();
    expect(status.state).toBe('idle');
    expect(status.last_error).toBeNull();
    expect(status.last_synced_at).toBe(new Date(h.clock.now).toISOString());
    expect(h.changed).toHaveLength(1);
    expect(h.changed[0]!.ctx).toEqual({ from: before, to: await b.headSha() });
    expect(h.changed[0]!.changes.sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: 'README.md', change: 'modified' },
      { path: 'concepts/x.md', change: 'added' },
    ]);
    expect(h.states).toEqual(['fetching', 'merging', 'indexing', 'idle']);

    await h.engine.runCycle();
    expect(h.changed).toHaveLength(1);
  });

  it('is a no-op without a remote', async () => {
    const lone = new LocalGitRepo(join(fx.root, 'lone'));
    await lone.init({ initialBranch: 'main' });
    const h = harness(lone, 'direct');
    expect((await h.engine.runCycle()).state).toBe('idle');
    expect(h.states).toEqual(['idle']);
  });
});

describe('conflicts', () => {
  async function diverge(): Promise<void> {
    write(fx.a, 'README.md', '# theirs\n');
    await fx.a.commit(['README.md'], 'a', ALICE);
    await fx.a.push();
    write(fx.b, 'README.md', '# ours\n');
    await fx.b.commit(['README.md'], 'b', BOB);
  }

  it('calls onConflict, blocks further cycles, and resumes after resolveConflict("theirs")', async () => {
    await diverge();
    const h = harness(fx.b, 'direct');
    const before = await fx.b.headSha();

    expect((await h.engine.runCycle()).state).toBe('conflict');
    expect(h.conflicts).toEqual([['README.md']]);
    expect(h.engine.status().conflicted_paths).toEqual(['README.md']);
    expect(h.changed).toHaveLength(0);

    const blocked = await h.engine.runCycle();
    expect(blocked.state).toBe('conflict');
    expect(h.conflicts).toHaveLength(1);
    await expect(h.engine.resolveConflict('other.md', 'ours')).rejects.toThrow(/not conflicted/);

    const resolved = await h.engine.resolveConflict('README.md', 'theirs');
    expect(resolved.state).toBe('idle');
    expect(resolved.conflicted_paths).toEqual([]);
    expect(readFileSync(join(fx.b.dir, 'README.md'), 'utf8')).toBe('# theirs\n');
    expect(await fx.b.isClean()).toBe(true);
    expect((await fx.b.git(['rev-list', '--parents', '-1', 'HEAD'])).split(' ')).toHaveLength(3);
    expect(h.changed).toHaveLength(1);
    expect(h.changed[0]!.ctx.from).toBe(before);
    expect(h.changed[0]!.changes).toEqual([{ path: 'README.md', change: 'modified' }]);
  });

  it('accepts "ours" and explicit content', async () => {
    await diverge();
    const h = harness(fx.b, 'direct');
    await h.engine.runCycle();
    await h.engine.resolveConflict('README.md', { content: '# merged by hand\n' });
    expect(readFileSync(join(fx.b.dir, 'README.md'), 'utf8')).toBe('# merged by hand\n');
    expect(h.engine.status().state).toBe('idle');
  });

  it('abort() drops the merge and returns to idle', async () => {
    await diverge();
    const h = harness(fx.b, 'direct');
    const before = await fx.b.headSha();
    await h.engine.runCycle();
    const s = await h.engine.abort();
    expect(s.state).toBe('idle');
    expect(await fx.b.headSha()).toBe(before);
    expect(readFileSync(join(fx.b.dir, 'README.md'), 'utf8')).toBe('# ours\n');
    await expect(h.engine.abort()).rejects.toThrow(/not in conflict/);
  });
});

describe('push cadence (direct)', () => {
  it('holds commits until publish or the 5-minute timer', async () => {
    const { b, origin } = fx;
    const h = harness(b, 'direct');
    const originBefore = await originSha(origin);

    write(b, 'concepts/draft.md', 'draft\n');
    const local1 = await b.commit(['concepts/draft.md'], 'draft', BOB);
    h.engine.noteLocalCommit();
    expect(h.engine.status().ahead).toBe(1);

    h.clock.now += DEFAULT_PUSH_INTERVAL_MS - 1;
    await h.engine.runCycle();
    expect(await originSha(origin)).toBe(originBefore);
    expect(h.engine.status().ahead).toBe(1);
    expect(h.states).not.toContain('pushing');

    const published = await h.engine.requestPush('publish');
    expect(published.state).toBe('idle');
    expect(published.ahead).toBe(0);
    expect(await originSha(origin)).toBe(local1);

    write(b, 'concepts/draft.md', 'draft 2\n');
    const local2 = await b.commit(['concepts/draft.md'], 'draft 2', BOB);
    h.clock.now += DEFAULT_PUSH_INTERVAL_MS - 1;
    await h.engine.runCycle();
    expect(await originSha(origin)).toBe(local1);

    h.clock.now += 1;
    await h.engine.runCycle();
    expect(await originSha(origin)).toBe(local2);
    expect((await b.status()).ahead).toBe(0);
  });

  it('runCycle({ force: true }) pushes regardless of the timer', async () => {
    const { b, origin } = fx;
    const h = harness(b, 'direct');
    write(b, 'f.md', 'f\n');
    const sha = await b.commit(['f.md'], 'f', BOB);
    await h.engine.runCycle({ force: true });
    expect(await originSha(origin)).toBe(sha);
  });

  it('recovers from one non-fast-forward rejection by merging and retrying', async () => {
    const { a, b, origin } = fx;
    write(a, 'from-a.md', 'a\n');
    await a.commit(['from-a.md'], 'a', ALICE);
    await a.push();
    write(b, 'from-b.md', 'b\n');
    await b.commit(['from-b.md'], 'b', BOB);
    const h = harness(b, 'direct');

    // Race: someone else pushes between our fetch/merge and our push.
    const real = b.push.bind(b);
    let pushes = 0;
    b.push = async (ref?: string) => {
      pushes += 1;
      if (pushes === 1) {
        write(a, 'race.md', 'r\n');
        await a.commit(['race.md'], 'race', ALICE);
        await a.push();
      }
      return real(ref);
    };

    const s = await h.engine.requestPush('publish');
    expect(s.state).toBe('idle');
    expect(pushes).toBe(2);
    expect(await originSha(origin)).toBe(await b.headSha());
    expect(h.changed.flatMap((c) => c.changes.map((x) => x.path)).sort()).toEqual(['from-a.md', 'race.md']);
  });

  it('enters error after the retry is rejected too', async () => {
    const { b } = fx;
    write(b, 'f.md', 'f\n');
    await b.commit(['f.md'], 'f', BOB);
    let pushes = 0;
    b.push = async () => {
      pushes += 1;
      return { ok: false, rejected: true, error: 'simulated non-fast-forward' };
    };
    const h = harness(b, 'direct');
    const s = await h.engine.requestPush('publish');
    expect(s.state).toBe('error');
    expect(s.last_error).toContain('simulated non-fast-forward');
    expect(pushes).toBe(2);

    // A later cycle retries from the error state.
    b.push = async () => ({ ok: true });
    expect((await h.engine.runCycle()).state).toBe('idle');
    expect(h.engine.status().last_error).toBeNull();
  });
});

describe('read-only policy', () => {
  it('merges inbound changes but never pushes', async () => {
    const { a, b, origin } = fx;
    write(a, 'up.md', 'u\n');
    await a.commit(['up.md'], 'u', ALICE);
    await a.push();
    const originBefore = await originSha(origin);
    write(b, 'local.md', 'l\n');
    await b.commit(['local.md'], 'l', BOB);

    const h = harness(b, 'read-only');
    h.clock.now += DEFAULT_PUSH_INTERVAL_MS * 2;
    const s = await h.engine.requestPush('publish');
    expect(s.state).toBe('idle');
    expect(h.changed[0]!.changes).toEqual([{ path: 'up.md', change: 'added' }]);
    expect(await originSha(origin)).toBe(originBefore);
    expect(h.states).not.toContain('pushing');
    expect(s.ahead).toBeGreaterThan(0);
  });
});

describe('scheduling', () => {
  it('ignores overlapping cycles and stops cleanly', async () => {
    const { a, b } = fx;
    write(a, 'slow.md', 's\n');
    await a.commit(['slow.md'], 's', ALICE);
    await a.push();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reachedIndexing = new Promise<void>((r) => (reached = r));
    const h = harness(b, 'direct', {
      onChangedPaths: () => {
        reached();
        return gate;
      },
    });

    const first = h.engine.runCycle();
    await reachedIndexing;
    const second = await h.engine.runCycle();
    expect(second.state).toBe('indexing');
    release();
    expect((await first).state).toBe('idle');
    expect(h.changed).toHaveLength(1);

    // Starting twice must not schedule twice, and stopping must leave the engine
    // idle. `stop()` clears the timer but does NOT abort a cycle already in
    // flight, so the test awaits `whenIdle()` rather than reading `state`: the
    // state reads `idle` during a cycle's fetch prelude, and polling it let the
    // test finish while a git child process still held the fixture directory —
    // which Windows then refused to delete (EPERM in cleanup).
    h.engine.start(5);
    h.engine.start(5);
    await new Promise((r) => setTimeout(r, 30));
    h.engine.stop();
    await h.engine.whenIdle();
    expect(h.engine.status().state).toBe('idle');

    // And it stays stopped: no further cycle runs after `stop()`.
    const settled = h.changed.length;
    await new Promise((r) => setTimeout(r, 40));
    await h.engine.whenIdle();
    expect(h.changed).toHaveLength(settled);
  });
});
