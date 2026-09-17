import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isContentUnchanged } from '@echozedlabs/okf';
import { DigestMismatchError, LocalBundleStore, NotFoundError, digestOf } from '../src/local-bundle-store.js';

let root: string;

function seed(rel: string, content = `# ${rel}\n`): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function bytes(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'content-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('digestOf', () => {
  it('is stable across calls and differs for different content', () => {
    expect(digestOf('a')).toBe(digestOf('a'));
    expect(digestOf('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf('a')).not.toBe(digestOf('b'));
    expect(digestOf('a\n')).not.toBe(digestOf('a\r\n'));
  });
});

describe('list', () => {
  it('finds root concepts/ (dedicated) and <topic>/concepts/ (main repo) layouts, sorted', () => {
    seed('concepts/zeta.md');
    seed('concepts/alpha.md');
    seed('kaykit/concepts/model.md');
    seed('kaykit/concepts/sub/nested.md'); // not directly in concepts/
    seed('other/notes.md'); // not a concept dir
    seed('kaykit/readme.md');
    const store = new LocalBundleStore(root);
    return store.list().then((items) => {
      expect(items.map((i) => i.path)).toEqual(['concepts/alpha.md', 'concepts/zeta.md', 'kaykit/concepts/model.md']);
      expect(items[0]).toEqual({
        path: 'concepts/alpha.md',
        slug: 'alpha',
        digest: digestOf('# concepts/alpha.md\n'),
      });
    });
  });

  it('excludes reserved basenames, non-md files, and anything under assets/', async () => {
    seed('index.md');
    seed('log.md');
    seed('concepts/index.md');
    seed('concepts/log.md');
    seed('concepts/keep.md');
    seed('concepts/data.json');
    seed('assets/concepts/image.md');
    seed('kaykit/assets/concepts/other.md');
    const items = await new LocalBundleStore(root).list();
    expect(items.map((i) => i.path)).toEqual(['concepts/keep.md']);
  });

  it('honors a custom conceptDir and reserved list', async () => {
    seed('kaykit/concepts/a.md');
    seed('kaykit/concepts/index.md');
    seed('kaykit/concepts/custom.md');
    seed('concepts/b.md');
    const items = await new LocalBundleStore(root, {
      conceptDir: 'kaykit/concepts',
      reserved: ['custom.md'],
    }).list();
    expect(items.map((i) => i.path)).toEqual(['kaykit/concepts/a.md', 'kaykit/concepts/index.md']);
  });

  it('returns [] for an empty or missing root', async () => {
    expect(await new LocalBundleStore(root).list()).toEqual([]);
    expect(await new LocalBundleStore(join(root, 'nope')).list()).toEqual([]);
  });

  it('never descends into dot-directories (.git, .e3)', async () => {
    seed('concepts/keep.md');
    seed('.git/concepts/object.md');
    seed('.e3/concepts/map.md');
    const items = await new LocalBundleStore(root).list();
    expect(items.map((i) => i.path)).toEqual(['concepts/keep.md']);
  });
});

/**
 * The non-OKF import selection (plan section 8.3): the same rule the inbound
 * indexer applies to a changed path, applied here to a whole working tree, so
 * that a rebuild-from-git sees exactly the files a sync indexed (issue 94).
 */
describe('list with include/exclude globs', () => {
  it('replaces the canonical layout with what the globs select', async () => {
    seed('docs/guide.md');
    seed('docs/deep/nested.md');
    seed('docs/archive/old.md');
    seed('notes/other.md');
    seed('concepts/canonical.md');
    seed('docs/picture.png');
    const items = await new LocalBundleStore(root).list({
      include: ['docs/**/*.md'],
      exclude: ['docs/archive/**'],
    });
    expect(items.map((i) => i.path)).toEqual(['docs/deep/nested.md', 'docs/guide.md']);
  });

  it('still excludes reserved basenames and assets/, whatever the globs say', async () => {
    seed('docs/keep.md');
    seed('docs/index.md');
    seed('docs/log.md');
    seed('docs/assets/logo.md');
    const items = await new LocalBundleStore(root).list({ include: ['**/*.md'] });
    expect(items.map((i) => i.path)).toEqual(['docs/keep.md']);
  });

  it('an empty include list is exactly the canonical layout', async () => {
    seed('concepts/canonical.md');
    seed('docs/guide.md');
    const store = new LocalBundleStore(root);
    expect((await store.list({ include: [], exclude: [] })).map((i) => i.path)).toEqual(['concepts/canonical.md']);
    expect((await store.list()).map((i) => i.path)).toEqual(['concepts/canonical.md']);
  });
});

describe('read / write', () => {
  it.each([
    ['LF with trailing newline', '---\ntitle: A\n---\n\nBody\n'],
    ['LF without trailing newline', '---\ntitle: A\n---\n\nBody'],
    ['CRLF', '---\r\ntitle: A\r\n---\r\n\r\nBody\r\n'],
    ['multiple trailing newlines', 'Body\n\n\n'],
    ['unicode', '# Título — 日本語\n'],
  ])('round-trips byte-exact: %s', async (_label, raw) => {
    const store = new LocalBundleStore(root);
    const { digest } = await store.write('concepts/a.md', raw);
    expect(bytes('concepts/a.md')).toBe(raw);
    expect(digest).toBe(digestOf(raw));
    expect(await store.read('concepts/a.md')).toEqual({ path: 'concepts/a.md', slug: 'a', digest, raw });
  });

  it('creates parent directories and leaves no temp files behind', async () => {
    const store = new LocalBundleStore(root);
    await store.write('kaykit/concepts/deep.md', 'x');
    expect(readdirSync(join(root, 'kaykit/concepts'))).toEqual(['deep.md']);
  });

  it('overwrites an existing file atomically', async () => {
    seed('concepts/a.md', 'old');
    const store = new LocalBundleStore(root);
    await store.write('concepts/a.md', 'new');
    expect(bytes('concepts/a.md')).toBe('new');
    expect(readdirSync(join(root, 'concepts'))).toEqual(['a.md']);
  });

  it('read throws NotFoundError for a missing file', async () => {
    const store = new LocalBundleStore(root);
    const err = await store.read('concepts/missing.md').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).path).toBe('concepts/missing.md');
  });

  it('rejects paths that escape the root', async () => {
    const store = new LocalBundleStore(root);
    await expect(store.read('../outside.md')).rejects.toThrow(/escapes bundle root/);
    await expect(store.write('../outside.md', 'x')).rejects.toThrow(/escapes bundle root/);
  });
});

describe('write with expectDigest', () => {
  it('writes when the digest matches the current file', async () => {
    seed('concepts/a.md', 'v1');
    const store = new LocalBundleStore(root);
    await store.write('concepts/a.md', 'v2', { expectDigest: digestOf('v1') });
    expect(bytes('concepts/a.md')).toBe('v2');
  });

  it('throws DigestMismatchError with fields and leaves the target untouched', async () => {
    seed('concepts/a.md', 'v1');
    const store = new LocalBundleStore(root);
    const err = await store.write('concepts/a.md', 'v2', { expectDigest: digestOf('stale') }).catch((e) => e);
    expect(err).toBeInstanceOf(DigestMismatchError);
    expect(err).toMatchObject({ path: 'concepts/a.md', expected: digestOf('stale'), actual: digestOf('v1') });
    expect(bytes('concepts/a.md')).toBe('v1');
    expect(readdirSync(join(root, 'concepts'))).toEqual(['a.md']);
  });

  it('treats a non-empty expectDigest on a missing file as a mismatch (actual = "")', async () => {
    const store = new LocalBundleStore(root);
    const err = await store.write('concepts/new.md', 'v1', { expectDigest: digestOf('v0') }).catch((e) => e);
    expect(err).toBeInstanceOf(DigestMismatchError);
    expect((err as DigestMismatchError).actual).toBe('');
    expect(existsSync(join(root, 'concepts/new.md'))).toBe(false);
  });

  it('expectDigest "" means "must not exist yet"', async () => {
    const store = new LocalBundleStore(root);
    await store.write('concepts/new.md', 'v1', { expectDigest: '' });
    expect(bytes('concepts/new.md')).toBe('v1');
    await expect(store.write('concepts/new.md', 'v2', { expectDigest: '' })).rejects.toBeInstanceOf(
      DigestMismatchError,
    );
    expect(bytes('concepts/new.md')).toBe('v1');
  });
});

describe('move / remove', () => {
  it('moves across directories, creating the destination parent', async () => {
    seed('concepts/a.md', 'body');
    const store = new LocalBundleStore(root);
    await store.move('concepts/a.md', 'kaykit/concepts/b.md');
    expect(existsSync(join(root, 'concepts/a.md'))).toBe(false);
    expect(bytes('kaykit/concepts/b.md')).toBe('body');
  });

  it('move throws NotFoundError when the source is missing', async () => {
    const store = new LocalBundleStore(root);
    const err = await store.move('concepts/nope.md', 'concepts/b.md').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).path).toBe('concepts/nope.md');
    expect(existsSync(join(root, 'concepts/b.md'))).toBe(false);
  });

  it('remove deletes the file and is a no-op when missing', async () => {
    seed('concepts/a.md');
    const store = new LocalBundleStore(root);
    await store.remove('concepts/a.md');
    expect(existsSync(join(root, 'concepts/a.md'))).toBe(false);
    await expect(store.remove('concepts/a.md')).resolves.toBeUndefined();
  });
});

describe('pathFor', () => {
  it('uses the flat layout under the configured conceptDir, ignoring type', () => {
    expect(new LocalBundleStore(root).pathFor('my-page')).toBe('concepts/my-page.md');
    expect(new LocalBundleStore(root).pathFor('my-page', 'Runbook')).toBe('concepts/my-page.md');
    expect(new LocalBundleStore(root, { conceptDir: 'kaykit/concepts' }).pathFor('p')).toBe('kaykit/concepts/p.md');
  });

  it('accepts a per-call conceptDir override', () => {
    expect(new LocalBundleStore(root).pathFor('p', undefined, { conceptDir: 'topic/concepts' })).toBe(
      'topic/concepts/p.md',
    );
  });
});

describe('readBundleIndex', () => {
  it('returns {} without index.md', async () => {
    expect(await new LocalBundleStore(root).readBundleIndex()).toEqual({});
  });

  it('parses presentation info from index.md', async () => {
    seed('index.md', '---\npresentation: docs\nstart_here: intro\n---\n\n# Topic\n\n> desc\n\nWelcome.\n\n## Concepts\n');
    expect(await new LocalBundleStore(root).readBundleIndex()).toEqual({
      presentation: 'docs',
      start_here: 'intro',
      landing_markdown: 'Welcome.',
    });
  });
});

describe('unchanged', () => {
  it('matches okf isContentUnchanged against the file on disk', async () => {
    const store = new LocalBundleStore(root);
    expect(await store.unchanged('concepts/a.md', 'x')).toBe(isContentUnchanged(undefined, 'x'));
    expect(await store.unchanged('concepts/a.md', 'x')).toBe(false);

    seed('concepts/a.md', 'line one\nline two\n');
    for (const next of ['line one\nline two\n', 'line one\r\nline two', 'line one  \nline two\n\n\n', 'changed\n']) {
      expect(await store.unchanged('concepts/a.md', next)).toBe(isContentUnchanged('line one\nline two\n', next));
    }
    expect(await store.unchanged('concepts/a.md', 'line one\r\nline two')).toBe(true);
    expect(await store.unchanged('concepts/a.md', 'changed\n')).toBe(false);
  });
});
