import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeRef, ChangeRequestHost, SourceRef } from '@echozedlabs/knowledge-types';
import { ReviewFlow, itemBranchName, runGit } from '../src/index.js';
import { ALICE, BOB, makeFixture, originHasBranch, originSha, write, type Fixture } from './helpers.js';

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => {
  fx.cleanup();
});

describe('itemBranchName', () => {
  it('builds e3/<slug>-<shortId> and normalises the prefix', () => {
    expect(itemBranchName(undefined, 'my-post', 'a1b2c3')).toBe('e3/my-post-a1b2c3');
    expect(itemBranchName('e3/', 'my-post', 'a1b2c3')).toBe('e3/my-post-a1b2c3');
    expect(itemBranchName('kb', 'my-post', 'a1b2c3')).toBe('kb/my-post-a1b2c3');
  });
});

class FakeHost implements ChangeRequestHost {
  opened: { source: SourceRef; branch: string; title: string; body: string }[] = [];
  state: 'open' | 'merged' | 'closed' = 'open';
  async openChange(input: { source: SourceRef; branch: string; title: string; body: string }): Promise<ChangeRef> {
    this.opened.push(input);
    return { host: 'fake', id: `o/r#${this.opened.length}`, url: `https://host/pr/${this.opened.length}` };
  }
  async status(): Promise<'open' | 'merged' | 'closed'> {
    return this.state;
  }
}

describe('ReviewFlow', () => {
  it('commits to the item branch, pushes it, opens the change, and leaves the working tree on base', async () => {
    const { a, origin } = fx;
    const host = new FakeHost();
    const flow = new ReviewFlow();
    const source: SourceRef = { id: 's', local: a.dir, remote: origin, branch: 'main', role: 'authoritative', policy: { mode: 'review' } };
    const branch = itemBranchName(source.policy.branchPrefix, 'post', 'abc123');
    const mainBefore = await a.headSha();
    write(a, 'concepts/post.md', '---\nid: abc123\n---\n# Post\n');

    const ref = await flow.openForItem({
      repo: a,
      base: 'main',
      branch,
      paths: ['concepts/post.md'],
      message: 'Add post',
      author: ALICE,
      coAuthors: ['Agent <agent@example.com>'],
      host,
      source,
      title: 'Post',
      body: 'Opened by Knowledge E3 for Alice Author',
    });

    expect(ref).toMatchObject({ host: 'fake', id: 'o/r#1', url: 'https://host/pr/1' });
    expect(ref.sha).toBe(await originSha(origin, branch));
    expect(host.opened).toEqual([{ source, branch, title: 'Post', body: 'Opened by Knowledge E3 for Alice Author' }]);
    expect(await a.currentBranch()).toBe('main');
    expect(await a.headSha()).toBe(mainBefore);
    expect(await originSha(origin, 'main')).toBe(mainBefore);
    expect(await runGit(origin, ['show', `${branch}:concepts/post.md`])).toContain('# Post');
    expect((await a.status()).dirty).toEqual(['concepts/post.md']);
    expect(await flow.statusOf(host, ref)).toBe('open');

    // A second edit stacks on the same branch.
    write(a, 'concepts/post.md', '---\nid: abc123\n---\n# Post v2\n');
    const ref2 = await flow.openForItem({ repo: a, base: 'main', branch, paths: ['concepts/post.md'], message: 'Edit', author: ALICE, host, source, title: 'Post', body: '' });
    expect(await runGit(origin, ['rev-parse', `${branch}^`])).toBe(ref.sha);
    expect(await originSha(origin, branch)).toBe(ref2.sha);
  });

  it('onMerged brings base up to date, lands the reviewed file, and prunes the branch locally and remotely', async () => {
    const { a, b, origin } = fx;
    const host = new FakeHost();
    const flow = new ReviewFlow();
    const source: SourceRef = { id: 's', local: a.dir, remote: origin, branch: 'main', role: 'authoritative', policy: { mode: 'review' } };
    const branch = 'e3/post-abc123';
    write(a, 'concepts/post.md', '# Post\n');
    await flow.openForItem({ repo: a, base: 'main', branch, paths: ['concepts/post.md'], message: 'Add', author: ALICE, host, source, title: 'Post', body: '' });

    // The reviewer edits and merges on the host: emulate with the second clone.
    await b.fetch();
    expect((await b.merge(`origin/${branch}`)).ok).toBe(true);
    write(b, 'other.md', 'o\n');
    write(b, 'concepts/post.md', '# Post (reviewed)\n');
    await b.commit(['other.md', 'concepts/post.md'], 'reviewer edit', BOB);
    expect((await b.push()).ok).toBe(true);
    host.state = 'merged';

    expect(await flow.statusOf(host, { host: 'fake', id: 'o/r#1', url: '' })).toBe('merged');
    const merged = await flow.onMerged({ repo: a, branch, base: 'main', paths: ['concepts/post.md'] });
    expect(merged.ok).toBe(true);
    expect(await a.headSha()).toBe(await originSha(origin, 'main'));
    expect(readFileSync(join(a.dir, 'concepts/post.md'), 'utf8')).toBe('# Post (reviewed)\n');
    expect(await a.isClean()).toBe(true);
    expect(await a.hasBranch(branch)).toBe(false);
    expect(await originHasBranch(origin, branch)).toBe(false);
    expect(await a.currentBranch()).toBe('main');

    // Idempotent when the branch is already gone; upstream content stays canonical for the item's paths.
    write(a, 'concepts/post.md', '# Post v3 (local)\n');
    expect((await flow.onMerged({ repo: a, branch, base: 'main', paths: ['concepts/post.md'] })).ok).toBe(true);
    expect(readFileSync(join(a.dir, 'concepts/post.md'), 'utf8')).toBe('# Post (reviewed)\n');
  });
});
