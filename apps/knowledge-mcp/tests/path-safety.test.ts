/**
 * Only configured roots are readable: no traversal, no following links out of
 * the root, `.git` never read, and no tool argument is ever used as a path.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MultiSourceBackend } from '../src/backend.js';
import { isInside, safeFile, walkFiles } from '../src/paths.js';
import { FolderSource } from '../src/sources/folder.js';
import { captureLogger, tempDir, writeFiles } from './helpers.js';

/** Create a link, or report that this OS/user may not (Windows file symlinks need a privilege). */
function tryLink(target: string, path: string, type: 'dir' | 'file' | 'junction'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe('path safety', () => {
  let root: string;
  let outside: string;
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    const a = tempDir('knowledge-mcp-root-');
    const b = tempDir('knowledge-mcp-outside-');
    cleanups.push(a.cleanup, b.cleanup);
    root = a.dir;
    outside = b.dir;
    writeFiles(outside, { 'secret.md': '# Outside Secret\n\nsecretword should never be indexed.\n', 'dir/leak.md': '# Leak\n\nsecretword\n' });
    writeFiles(root, {
      'notes/inside.md': '# Inside\n\nordinary words.\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/secret.md': '# Git Internal\n\nsecretword\n',
    });
  });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('refuses traversal and absolute paths in safeFile', () => {
    expect(safeFile(root, 'notes/inside.md')).not.toBeNull();
    expect(safeFile(root, '../' + outside.split(/[\\/]/).pop() + '/secret.md')).toBeNull();
    expect(safeFile(root, 'notes/../../x.md')).toBeNull();
    expect(safeFile(root, join(outside, 'secret.md'))).toBeNull();
    expect(isInside(root, join(root, 'notes'))).toBe(true);
    expect(isInside(root, outside)).toBe(false);
  });

  it('never follows a directory link or junction out of the root, and never walks .git', async () => {
    const linked = tryLink(join(outside, 'dir'), join(root, 'notes', 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    const fileLinked = tryLink(join(outside, 'secret.md'), join(root, 'notes', 'linked.md'), 'file');
    const walk = walkFiles(root);
    expect(walk.files).toEqual(['notes/inside.md']);
    if (linked) expect(walk.skippedLinks).toContain('notes/linked-dir');
    if (fileLinked) {
      expect(walk.skippedLinks).toContain('notes/linked.md');
      expect(safeFile(root, 'notes/linked.md')).toBeNull();
    }

    const { logger } = captureLogger();
    const source = new FolderSource({ id: 'notes', type: 'folder', path: root, default_status: 'published' }, logger);
    await source.load();
    const backend = new MultiSourceBackend([source], logger);
    const result = await backend.search({ q: 'secretword', sort: 'relevance', include_drafts: true });
    expect(result.sources[0]).toMatchObject({ source: 'notes', total: 0 });
    expect(JSON.stringify(await backend.listSpaces())).not.toContain('Secret');
  });

  it('treats a get_item ref as an index key, never a file path', async () => {
    const { logger } = captureLogger();
    const source = new FolderSource({ id: 'notes', type: 'folder', path: root, default_status: 'published' }, logger);
    await source.load();
    const backend = new MultiSourceBackend([source], logger);
    for (const id of ['../secret', `notes:../${outside}/secret`, join(outside, 'secret.md'), 'notes:.git/secret', '.git/HEAD']) {
      await expect(backend.getItem({ id }), id).rejects.toMatchObject({ status: 404 });
    }
    expect((await backend.getItem({ id: 'notes:notes/inside' })).item).toMatchObject({ title: 'Inside', path: 'notes/inside.md' });
  });

  it('accepts a root that is itself a link, reading the real directory', async () => {
    const holder = tempDir('knowledge-mcp-link-');
    cleanups.push(holder.cleanup);
    const alias = join(holder.dir, 'alias');
    if (!tryLink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')) return;
    mkdirSync(join(root, 'more'), { recursive: true });
    writeFileSync(join(root, 'more', 'second.md'), '# Second\n');
    const { logger } = captureLogger();
    const source = new FolderSource({ id: 'alias', type: 'folder', path: alias, default_status: 'published' }, logger);
    await source.load();
    expect(source.info()).toMatchObject({ status: 'ready', items: 2 });
  });
});
