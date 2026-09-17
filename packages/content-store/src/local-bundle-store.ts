import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ContentStore, StoredItem, StoredItemRef } from '@echozedlabs/knowledge-types';
import { isContentUnchanged, parseBundleIndex, type BundleIndexInfo } from '@echozedlabs/okf';
import { isIndexablePath, type ItemSelection } from './item-paths.js';
import { slugFromPath, toPosix } from './paths.js';

export interface LocalBundleStoreOptions {
  /** Directory holding concept files; default `concepts`. May be a topic subtree (`<slug>/concepts`). */
  conceptDir?: string;
  /** Basenames that are never items; default `['index.md', 'log.md']`. */
  reserved?: string[];
}

const DEFAULT_RESERVED = ['index.md', 'log.md'];
const ASSETS_DIR = 'assets';

export class NotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`not found: ${path}`);
    this.name = 'NotFoundError';
  }
}

/** Thrown by `write` when `expectDigest` does not match the file on disk; nothing was written. */
export class DigestMismatchError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    /** Digest of the current file, or `''` when it does not exist. */
    public readonly actual: string,
  ) {
    super(`digest mismatch for ${path}: expected ${expected || '<none>'}, found ${actual || '<none>'}`);
    this.name = 'DigestMismatchError';
  }
}

/** sha256 hex of the UTF-8 bytes. */
export function digestOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * `ContentStore` over one OKF bundle root on disk. Synchronous `node:fs` under
 * the hood behind the async contract from `@echozedlabs/knowledge-types`.
 * Bytes are written and hashed exactly as given (no line-ending normalization).
 */
export class LocalBundleStore implements ContentStore {
  readonly root: string;
  private readonly conceptDir: string;
  private readonly reserved: string[];

  constructor(root: string, opts: LocalBundleStoreOptions = {}) {
    this.root = resolve(root);
    this.conceptDir = toPosix(opts.conceptDir ?? 'concepts').replace(/^\/+|\/+$/g, '');
    this.reserved = opts.reserved ?? DEFAULT_RESERVED;
  }

  /**
   * Every `*.md` directly inside a `<conceptDir>/` directory — at the root
   * (dedicated repo) or under any prefix (`<topic>/concepts/` in the shared
   * main repo) — excluding reserved basenames and anything under `assets/`.
   *
   * With `selection.include` (a source's `include_globs`, plan §8.3) the
   * canonical layout is replaced by exactly the `.md` files those globs select,
   * minus `selection.exclude` — the same rule, from the same matcher, that the
   * inbound indexer applies to the paths a fetch/merge changed (`item-paths.ts`).
   * Reserved files and `assets/**` stay excluded either way, and an empty or
   * absent `include` enumerates precisely what this method always has.
   */
  async list(selection: ItemSelection = {}): Promise<StoredItemRef[]> {
    const opts = { conceptDir: this.conceptDir, reserved: this.reserved };
    const out: StoredItemRef[] = [];
    for (const path of this.walk(this.root)) {
      if (!isIndexablePath(path, selection, opts)) continue;
      out.push({ path, slug: slugFromPath(path), digest: digestOf(this.readRaw(path)) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async read(path: string): Promise<StoredItem> {
    const raw = this.readRaw(path);
    return { path: toPosix(path), slug: slugFromPath(path), digest: digestOf(raw), raw };
  }

  /**
   * Atomic write: temp file in the target directory, then rename over the target.
   * With `expectDigest`, the current file must hash to it (`''` = must not exist);
   * otherwise `DigestMismatchError` is thrown and nothing is written.
   */
  async write(path: string, raw: string, opts: { expectDigest?: string } = {}): Promise<{ digest: string }> {
    const abs = this.abs(path);
    if (opts.expectDigest !== undefined) {
      const actual = existsSync(abs) ? digestOf(readFileSync(abs, 'utf8')) : '';
      if (actual !== opts.expectDigest) throw new DigestMismatchError(toPosix(path), opts.expectDigest, actual);
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(tmp, raw, 'utf8');
      renameSync(tmp, abs);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return { digest: digestOf(raw) };
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.abs(from);
    if (!existsSync(src)) throw new NotFoundError(toPosix(from));
    const dst = this.abs(to);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }

  async remove(path: string): Promise<void> {
    const abs = this.abs(path);
    if (existsSync(abs)) unlinkSync(abs);
  }

  /**
   * Root-relative path for a new item: flat `<conceptDir>/<slug>.md` (plan §12,
   * decision 3). `type` is accepted for interface parity and ignored until a
   * per-source path template exists.
   */
  pathFor(slug: string, _type?: string, opts: { conceptDir?: string } = {}): string {
    const dir = opts.conceptDir !== undefined ? toPosix(opts.conceptDir).replace(/^\/+|\/+$/g, '') : this.conceptDir;
    return `${dir}/${slug}.md`;
  }

  /** Presentation info from `<root>/index.md`, or `{}` when the bundle has none. */
  async readBundleIndex(): Promise<BundleIndexInfo> {
    const abs = join(this.root, 'index.md');
    return existsSync(abs) ? parseBundleIndex(readFileSync(abs, 'utf8')) : {};
  }

  /** okf's no-op guard against the file currently at `path` (false when missing). */
  async unchanged(path: string, raw: string): Promise<boolean> {
    const abs = this.abs(path);
    return isContentUnchanged(existsSync(abs) ? readFileSync(abs, 'utf8') : undefined, raw);
  }

  private abs(path: string): string {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes bundle root: ${path}`);
    return abs;
  }

  private readRaw(path: string): string {
    const abs = this.abs(path);
    if (!existsSync(abs)) throw new NotFoundError(toPosix(path));
    return readFileSync(abs, 'utf8');
  }

  /**
   * Root-relative posix paths of every file under `dir`, skipping `assets/`
   * directories and dot-directories. The latter are machinery, never content:
   * `.git` (which git itself refuses to track, and whose object store is large)
   * and `.e3` (the import id map). Without the skip an `include` glob such as
   * `**` + `/*.md` would reach into them.
   */
  private *walk(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === ASSETS_DIR || entry.name.startsWith('.')) continue;
        yield* this.walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        yield toPosix(relative(this.root, join(dir, entry.name)));
      }
    }
  }
}
