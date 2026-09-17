/**
 * The recovery unit — the shared vocabulary of `backup.ts` and `restore-drill.ts`.
 *
 * This product's recoverable state is **three things that are not one backup**
 * (operations-runbook §3.8, ADR-0001/0002/0003):
 *
 *   1. **git** — the working trees plus their remotes. The content of record.
 *   2. **assets** — the bytes under `<content root>/main/assets`. The
 *      `.meta.json` descriptors are git-tracked; whether the *bytes* are
 *      depends on placement policy, and a missing byte must fail loudly.
 *   3. **SQLite** — the derived index. Rebuildable from 1+2, so it is a
 *      recovery *speed* optimisation, not a source of truth — except for the
 *      rows that exist nowhere else: users, sessions, API tokens, app config,
 *      user prefs, the source registry, the audit log, engagement, and the
 *      topic metadata §3.7 lists as unrecoverable from files.
 *
 * Everything here is deliberately free of Nest DI and of the application's own
 * services: a backup tool must not boot the app, because booting it would run
 * migrations against the **live** database it is only supposed to read.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { contentRoot, loadServerConfig } from '../src/config/server-config.js';

// node:sqlite is experimental, so Node reports it in `builtinModules` only with
// the `node:` prefix, and vite-node (which runs this file under vitest) strips
// that prefix before its builtin lookup — a static import would be resolved as
// an npm package called "sqlite" and fail. Same workaround, same reason, as
// src/db/node-sqlite-adapter.ts; keep the two in step.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => DatabaseSync;
};

export const MANIFEST_NAME = 'manifest.json';

/** One git working tree as captured, described by reading the **copy**, not the original. */
export interface TreeManifest {
  /** Source registry id (`main`, `topic:<slug>`), or null for a tree on disk with no registry row. */
  source_id: string | null;
  /** Path of the captured copy, relative to the backup directory (posix-ish, as written). */
  archive_path: string;
  /** Absolute path it was captured from, for the operator's eyes. */
  live_path: string;
  /** How a restored registry should address it: relative to the content root, or absolute when external. */
  local_dir: string;
  head: string | null;
  branch: string | null;
  remote: string | null;
  head_committed_at: string | null;
  /** `git ls-tree -r HEAD` count — a cheap proof the object store survived the copy. */
  tracked_files: number;
  /**
   * `git status --porcelain` at capture. Empty on a healthy instance; non-empty
   * is captured faithfully and reported, because the runbook's §1 invariant is
   * that files may legitimately be ahead of both the index and the last commit.
   */
  dirty: string[];
}

export interface BackupManifest {
  schema_version: 1;
  tool: 'knowledge-e3/backup';
  capture: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
    host: string;
    platform: string;
    node: string;
  };
  /** Where the three parts lived on the instance this was taken from. */
  live: { content_root: string; db_path: string; assets_dir: string; config_file: string | null };
  db: {
    archive_path: string;
    /**
     * `vacuum-into` is a transactionally consistent snapshot taken through a
     * read-only connection — valid even while the server is running.
     * `file-copy` is the fallback and is NOT guaranteed consistent; the drill's
     * integrity check is then the only thing standing between you and a bad
     * backup.
     */
    method: 'vacuum-into' | 'file-copy';
    bytes: number;
    sha256: string;
    /** A `-wal` sibling beside the live DB at capture time — i.e. the server was probably up. */
    wal_present_at_capture: boolean;
    counts: Record<string, number>;
    newest_page_updated_at: string | null;
    newest_audit_at: string | null;
  };
  trees: TreeManifest[];
  assets: {
    archive_path: string;
    /** True when the assets dir lives inside the content root (the git-of-record default). */
    in_content_root: boolean;
    descriptors: number;
    byte_files: number;
    total_bytes: number;
    /** Descriptors whose bytes were missing **at capture** — ADR-0003 loss, made explicit. */
    missing_bytes: string[];
    /** Bytes with no descriptor: recoverable as files, invisible to a rebuild. */
    undescribed_bytes: string[];
  };
  config: {
    archive_path: string | null;
    /** The env var NAMES sources read secrets from. Values are never captured. */
    secret_env_names: string[];
  };
  /** Newest durable change anywhere in the unit — the input to the drill's RPO. */
  newest_change_at: string | null;
  /** Parts of a real recovery that this artifact does NOT contain. Printed, not buried. */
  not_captured: string[];
}

export type Logger = (line: string) => void;

/* -------------------------------------------------------------------------- */
/* Path resolution                                                             */
/* -------------------------------------------------------------------------- */

export interface LivePaths {
  contentRoot: string;
  dbPath: string;
  assetsDir: string;
  configFile: string | null;
}

/**
 * Where this instance's three parts live, resolved the way the running server
 * resolves them — env wins over the config file, which wins over the defaults.
 *
 * `contentRoot()` is imported from the server so that half can never drift. The
 * DB and assets rules are re-stated here because their resolvers are private to
 * `src/db/db.module.ts` (`resolveDbUrl`, which also *creates* directories — a
 * side effect a backup tool must not have) and `src/images/assets.service.ts`
 * (`resolveAssetsDir`). If either of those changes, change this with it.
 */
export function resolveLivePaths(): LivePaths {
  const cfg = loadServerConfig();
  return {
    contentRoot: abs(contentRoot()),
    dbPath: abs(process.env['DB_URL'] ?? cfg.database.url ?? './data/kp.sqlite'),
    assetsDir: resolveAssetsDir(cfg),
    configFile: resolveConfigFile(),
  };
}

/** Mirrors `resolveAssetsDir` in src/images/assets.service.ts — keep in step. */
function resolveAssetsDir(cfg: ReturnType<typeof loadServerConfig>): string {
  const override = process.env['KNOWLEDGE_E3_ASSETS_DIR'];
  if (override) return abs(override);
  const single = process.env['GIT_MIRROR_DIR'];
  if (single) return join(abs(single), 'assets');
  const envRoot = process.env['GIT_MIRROR_ROOT'];
  if (envRoot || cfg.git.enabled) return join(abs(envRoot ?? cfg.git.root), 'main', 'assets');
  return resolve(process.cwd(), 'data', 'assets');
}

/** Mirrors `configFilePath` in src/config/server-config.ts, without throwing. */
function resolveConfigFile(): string | null {
  const explicit = process.env['KNOWLEDGE_E3_CONFIG'];
  if (explicit) {
    const p = abs(explicit);
    return existsSync(p) ? p : null;
  }
  const fallback = resolve(process.cwd(), 'knowledge-e3.config.yaml');
  return existsSync(fallback) ? fallback : null;
}

export function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * True when `child` is `parent` or sits underneath it. Case-insensitive on
 * Windows, because `C:\Projects\...` and `c:\projects\...` are the same
 * directory and an isolation guard that says otherwise is not a guard.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  const norm = process.platform === 'win32' ? relative(parent.toLowerCase(), child.toLowerCase()) : rel;
  return norm !== '' && !norm.startsWith('..') && !isAbsolute(norm);
}

/* -------------------------------------------------------------------------- */
/* git                                                                         */
/* -------------------------------------------------------------------------- */

export function git(dir: string, ...args: string[]): string {
  // stderr is piped, not inherited: several of the probes below ask questions
  // whose answer may legitimately be "no" (`remote get-url origin` on a
  // local-only source), and git's complaint about it is not the tool's output.
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function gitOrNull(dir: string, ...args: string[]): string | null {
  try {
    return git(dir, ...args);
  } catch {
    return null;
  }
}

export function isWorkingTree(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * Every working tree under a content root, by the canonical layout: `main/` and
 * `topics/<slug>/` (git-storage.md, "Content root layout"). A registry row can
 * name a tree anywhere; the caller unions this with the registry so a tree is
 * captured whether or not the database knows about it — after a total DB loss
 * the registry is empty and the files are all you have.
 */
export function discoverTrees(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const main = join(root, 'main');
  if (isWorkingTree(main)) out.push(main);
  const topics = join(root, 'topics');
  if (existsSync(topics)) {
    for (const e of readdirSync(topics, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(topics, e.name);
      if (isWorkingTree(dir)) out.push(dir);
    }
  }
  // A content root that IS a single working tree (GIT_MIRROR_DIR-style deployments).
  if (out.length === 0 && isWorkingTree(root)) out.push(root);
  return out;
}

/** The git half of a {@link TreeManifest}, read out of a tree on disk. */
export type TreeFacts = Pick<
  TreeManifest,
  'head' | 'branch' | 'remote' | 'head_committed_at' | 'tracked_files' | 'dirty'
>;

/**
 * Describe a working tree by reading it. The backup runs this against the
 * **copy** it just made, so the manifest describes the artifact rather than the
 * original — and the drill runs it against the restored copy and compares.
 */
export function readTree(dir: string): TreeFacts {
  const head = gitOrNull(dir, 'rev-parse', 'HEAD');
  const status = gitOrNull(dir, 'status', '--porcelain');
  const lsTree = head ? gitOrNull(dir, 'ls-tree', '-r', '--name-only', 'HEAD') : null;
  return {
    head,
    branch: gitOrNull(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    remote: gitOrNull(dir, 'remote', 'get-url', 'origin'),
    head_committed_at: head ? gitOrNull(dir, 'log', '-1', '--format=%cI') : null,
    tracked_files: lsTree ? lsTree.split('\n').filter((l) => l.trim() !== '').length : 0,
    dirty: status ? status.split('\n').filter((l) => l.trim() !== '') : [],
  };
}

/* -------------------------------------------------------------------------- */
/* SQLite                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Open a SQLite file directly, bypassing Kysely and the app's adapter.
 *
 * `readOnly` is the whole safety story when the target is a LIVE database: the
 * connection cannot checkpoint, cannot create a `-wal`, and cannot be talked
 * into a write by a stray statement.
 */
export function openSqlite(path: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  return new DatabaseSyncCtor(path, { readOnly: opts.readOnly ?? false });
}

export function queryAll<T = Record<string, unknown>>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as unknown as T[];
}

/** `SELECT COUNT(*)` for a table that may not exist yet (an older schema, a truncated file). */
export function countOrNull(db: DatabaseSync, table: string): number | null {
  try {
    const row = queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)[0];
    return row ? Number(row.n) : null;
  } catch {
    return null;
  }
}

export function scalarOrNull(db: DatabaseSync, sql: string): string | null {
  try {
    const row = queryAll<Record<string, unknown>>(db, sql)[0];
    if (!row) return null;
    const value = Object.values(row)[0];
    return value == null ? null : String(value);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** Newest mtime under a directory tree, or null. The asset half of `newest_change_at`. */
export function newestMtime(dir: string): Date | null {
  if (!existsSync(dir)) return null;
  let newest: Date | null = null;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const t = statSync(p).mtime;
      if (!newest || t > newest) newest = t;
    }
  };
  walk(dir);
  return newest;
}

export function maxIso(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    const iso = new Date(t).toISOString();
    if (!best || iso > best) best = iso;
  }
  return best;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * Forward slashes, always. Paths INSIDE a backup are recorded posix-style so a
 * manifest written on Windows restores on Linux and vice versa — `join` accepts
 * either separator on Windows, so nothing is lost by normalizing.
 */
export function toPosix(p: string): string {
  return p.split(/[\/]/).filter((seg) => seg !== '').join('/');
}

/** A filesystem-safe name for a source id (`topic:matlab` → `topic-matlab`). */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Split `a${sep}b` style archive paths back into an absolute path under a root. */
export function underBackup(backupDir: string, archivePath: string): string {
  return join(backupDir, ...archivePath.split(/[\\/]/).filter((p) => p !== ''));
}

export const PATH_SEP = sep;
