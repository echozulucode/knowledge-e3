/**
 * Take a backup of the complete recovery unit — git working trees, asset bytes,
 * and the SQLite index — into one self-describing directory.
 *
 *   pnpm --filter @echozedlabs/server backup                    # ./data/backups/<timestamp>
 *   pnpm --filter @echozedlabs/server backup --out /mnt/backups/2026-09-11
 *
 * In the production container (no pnpm in the runtime image, see the Dockerfile):
 *   cd /app/server && node --import @swc-node/register/esm-register scripts/backup.ts --out /backups/now
 *
 * **Why Node and not a shell script.** The thing it replaces
 * (`scripts/backup.sh`, SQL-Server-era) rotted precisely because it could not
 * run where the developer works. This runs unchanged on the Windows dev machine
 * and in the Alpine container, reuses the server's own path resolution so it can
 * never disagree with the running app about where the content root is, and is
 * importable by `tests/restore-drill.e2e.test.ts` — a backup tool nobody can
 * test is the same failure in a different decade.
 *
 * **What it does NOT do**, loudly, in its own output: secrets, remote-side git
 * state, and Litestream replicas are not in here. See `not_captured` in the
 * manifest. A backup that implies more coverage than it has is worse than none.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  abs,
  countOrNull,
  discoverTrees,
  fileBytes,
  humanBytes,
  humanDuration,
  isInside,
  maxIso,
  MANIFEST_NAME,
  newestMtime,
  openSqlite,
  queryAll,
  readTree,
  resolveLivePaths,
  safeName,
  scalarOrNull,
  sha256File,
  toPosix,
  type BackupManifest,
  type Logger,
  type TreeManifest,
} from './recovery-unit.js';

/** Tables whose row counts go in the manifest: the drill compares them after a restore. */
const COUNTED_TABLES = [
  'pages',
  'page_versions',
  'spaces',
  'users',
  'sessions',
  'api_tokens',
  'content_sources',
  'images',
  'image_links',
  'audit_log',
  'app_config',
  'content_outbox',
] as const;

/**
 * Things a real recovery needs that this artifact deliberately does not hold.
 * Printed on every run. Add to it rather than quietly widening what "backup"
 * is taken to mean.
 */
const NOT_CAPTURED = [
  'Secret VALUES. Only the env-var names a source reads its token from are recorded (host_token_env, webhook_secret_env). Restore them from your secret store.',
  'Remote-side git state. A remote is a URL here, not a copy: branch protection, open change requests, and anything pushed to the remote after this run are not in this backup.',
  'The Litestream replica. Continuous DB replication is configured on the cloud image only and needs LITESTREAM_AZURE_ACCOUNT_KEY; this tool neither reads nor verifies it.',
  'The container image, the environment, and TLS/DNS. Restoring data is not the same as standing an instance up (azure-deploy-guide.md).',
  'Anything written after capture finished. That window is the RPO the drill reports.',
];

export interface BackupOptions {
  /** Destination directory. Created; must be empty unless `force`. */
  outDir: string;
  /** Overrides for the live paths; each defaults to what the running server would resolve. */
  contentRoot?: string;
  dbPath?: string;
  assetsDir?: string;
  configFile?: string | null;
  force?: boolean;
  log?: Logger;
}

export async function runBackup(opts: BackupOptions): Promise<BackupManifest> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const startedAt = new Date();
  const t0 = performance.now();

  const live = resolveLivePaths();
  const contentRoot = abs(opts.contentRoot ?? live.contentRoot);
  const dbPath = abs(opts.dbPath ?? live.dbPath);
  const assetsDir = abs(opts.assetsDir ?? live.assetsDir);
  const configFile = opts.configFile === undefined ? live.configFile : opts.configFile;

  const outDir = abs(opts.outDir);
  prepareOutDir(outDir, { contentRoot, dbPath, force: opts.force === true });

  log(`[backup] content root : ${contentRoot}`);
  log(`[backup] database     : ${dbPath}`);
  log(`[backup] assets       : ${assetsDir}`);
  log(`[backup] config file  : ${configFile ?? '(none)'}`);
  log(`[backup] destination  : ${outDir}`);

  // ---- 1. SQLite FIRST -----------------------------------------------------
  // Order matters and it is not arbitrary. The write path is file-first: a file
  // can legitimately be ahead of the index, and the index ahead of git
  // (runbook §1). Capturing the DB *before* the files means the restored index
  // can only ever be BEHIND the restored files — which a rebuild-from-git
  // reconciles, because the files win by definition. The other order produces
  // index rows pointing at files the backup never captured, which is
  // unrecoverable data loss wearing a passing integrity check.
  const walPresent = existsSync(`${dbPath}-wal`);
  const dbArchive = join(outDir, 'kp.sqlite');
  const method = snapshotSqlite(dbPath, dbArchive, log);

  const snap = openSqlite(dbArchive, { readOnly: true });
  let counts: Record<string, number> = {};
  let newestPage: string | null = null;
  let newestAudit: string | null = null;
  let sources: SourceRow[] = [];
  try {
    // Only tables that actually exist in this schema are recorded; a null count
    // means the table is absent (an older or pre-registry database), which is
    // information, not a failure.
    const pairs: [string, number][] = [];
    for (const table of COUNTED_TABLES) {
      const n = countOrNull(snap, table);
      if (n !== null) pairs.push([table, n]);
    }
    counts = Object.fromEntries(pairs);
    newestPage = scalarOrNull(snap, 'SELECT MAX(updated_at) FROM pages');
    newestAudit = scalarOrNull(snap, 'SELECT MAX(occurred_at) FROM audit_log');
    sources = readSources(snap);
  } finally {
    snap.close();
  }

  // ---- 2. git working trees + everything else in the content root ----------
  // The whole content root is copied, `.git` and all. A `git clone` would be
  // smaller, but it would drop exactly what a clone drops: uncommitted work,
  // untracked files, and the local-only sources that exist nowhere else.
  const contentArchive = join(outDir, 'content');
  if (existsSync(contentRoot)) {
    cpSync(contentRoot, contentArchive, { recursive: true, dereference: false });
  } else {
    mkdirSync(contentArchive, { recursive: true });
    log(`[backup] WARNING: content root ${contentRoot} does not exist — nothing to capture for the git half`);
  }

  // Registry rows may point a source at a tree OUTSIDE the content root (an
  // absolute `local_dir`). Those are captured separately and remapped on
  // restore; without this they would be silently absent from the backup.
  const trees: TreeManifest[] = [];
  const captured = new Set<string>();
  for (const dir of discoverTrees(contentRoot)) {
    const rel = relative(contentRoot, dir) || '.';
    const copy = rel === '.' ? contentArchive : join(contentArchive, rel);
    captured.add(abs(dir).toLowerCase());
    trees.push(
      treeManifest(copy, { sourceId: sourceIdFor(sources, contentRoot, dir), liveDir: dir, localDir: toPosix(rel), outDir }),
    );
  }
  for (const row of sources) {
    const dir = abs(resolveLocal(row.local_dir, contentRoot));
    if (captured.has(dir.toLowerCase())) continue;
    if (!existsSync(dir)) {
      log(`[backup] WARNING: source ${row.id} names a working tree that does not exist: ${dir}`);
      continue;
    }
    const copy = join(outDir, 'external', safeName(row.id));
    cpSync(dir, copy, { recursive: true, dereference: false });
    captured.add(dir.toLowerCase());
    trees.push(treeManifest(copy, { sourceId: row.id, liveDir: dir, localDir: row.local_dir, outDir }));
    log(`[backup] captured external working tree for ${row.id}: ${dir}`);
  }

  // ---- 3. assets -----------------------------------------------------------
  const assetsInRoot = isInside(assetsDir, contentRoot);
  const assetsArchive = assetsInRoot
    ? join(contentArchive, relative(contentRoot, assetsDir))
    : join(outDir, 'assets');
  if (!assetsInRoot && existsSync(assetsDir)) {
    cpSync(assetsDir, assetsArchive, { recursive: true, dereference: false });
    log(`[backup] assets live outside the content root; captured separately`);
  }
  const assets = inventoryAssets(assetsArchive);

  // ---- 4. the config file and the names of the secrets it needs ------------
  let configArchive: string | null = null;
  if (configFile && existsSync(configFile)) {
    mkdirSync(join(outDir, 'config'), { recursive: true });
    configArchive = join(outDir, 'config', basename(configFile));
    cpSync(configFile, configArchive);
  }
  const secretEnvNames = [
    ...new Set(sources.flatMap((s) => [s.host_token_env, s.webhook_secret_env]).filter((v): v is string => !!v)),
  ].sort();

  const finishedAt = new Date();
  const manifest: BackupManifest = {
    schema_version: 1,
    tool: 'knowledge-e3/backup',
    capture: {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.round(performance.now() - t0),
      host: hostname(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
    },
    live: { content_root: contentRoot, db_path: dbPath, assets_dir: assetsDir, config_file: configFile ?? null },
    db: {
      archive_path: toPosix(relative(outDir, dbArchive)),
      method,
      bytes: fileBytes(dbArchive),
      sha256: sha256File(dbArchive),
      wal_present_at_capture: walPresent,
      counts,
      newest_page_updated_at: newestPage,
      newest_audit_at: newestAudit,
    },
    trees,
    assets: {
      archive_path: toPosix(relative(outDir, assetsArchive)),
      in_content_root: assetsInRoot,
      ...assets,
    },
    config: { archive_path: configArchive ? toPosix(relative(outDir, configArchive)) : null, secret_env_names: secretEnvNames },
    newest_change_at: maxIso(
      newestPage,
      newestAudit,
      ...trees.map((t) => t.head_committed_at),
      newestMtime(assetsArchive)?.toISOString(),
    ),
    not_captured: NOT_CAPTURED,
  };
  writeFileSync(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  report(manifest, outDir, log);
  return manifest;
}

/* -------------------------------------------------------------------------- */

interface SourceRow {
  id: string;
  local_dir: string;
  remote_url: string | null;
  enabled: number;
  host_token_env: string | null;
  webhook_secret_env: string | null;
}

function readSources(db: ReturnType<typeof openSqlite>): SourceRow[] {
  try {
    return queryAll<SourceRow>(
      db,
      'SELECT id, local_dir, remote_url, enabled, host_token_env, webhook_secret_env FROM content_sources',
    );
  } catch {
    // No registry table yet (a pre-registry or empty database). The layout scan
    // still finds the trees; this only costs the source-id labels.
    return [];
  }
}

function resolveLocal(localDir: string, root: string): string {
  return localDir && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(localDir) ? localDir : join(root, localDir);
}

function sourceIdFor(sources: SourceRow[], root: string, dir: string): string | null {
  const target = abs(dir).toLowerCase();
  for (const s of sources) {
    if (abs(resolveLocal(s.local_dir, root)).toLowerCase() === target) return s.id;
  }
  return null;
}

function treeManifest(
  copyDir: string,
  meta: { sourceId: string | null; liveDir: string; localDir: string; outDir: string },
): TreeManifest {
  return {
    source_id: meta.sourceId,
    archive_path: toPosix(relative(meta.outDir, copyDir)),
    live_path: meta.liveDir,
    local_dir: meta.localDir,
    ...readTree(copyDir),
  };
}

/**
 * Snapshot the SQLite file.
 *
 * `VACUUM INTO` through a **read-only** connection is the good path: it is a
 * transactionally consistent copy taken without stopping the server and without
 * the ability to write so much as a checkpoint back to the live database. The
 * plain file copy is the fallback for the cases SQLite will not open read-only
 * (a WAL database whose `-shm` is inaccessible, a foreign page size, a locked
 * network mount). It is copied WITH its `-wal`/`-shm` siblings and flagged in
 * the manifest, because a hot file copy is not a guaranteed-consistent backup —
 * the drill's `integrity_check` is then the only thing that will tell you.
 */
function snapshotSqlite(dbPath: string, dest: string, log: Logger): 'vacuum-into' | 'file-copy' {
  if (!existsSync(dbPath)) {
    throw new Error(
      `the database ${dbPath} does not exist. Point --db at the SQLite file (DB_URL / database.url), or run this on the host that has it.`,
    );
  }
  try {
    const src = openSqlite(dbPath, { readOnly: true });
    try {
      // SQLite string literal: the only escape is a doubled single quote.
      src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    log('[backup] database snapshot: VACUUM INTO through a read-only connection (consistent)');
    return 'vacuum-into';
  } catch (err) {
    rmSync(dest, { force: true });
    log(
      `[backup] WARNING: VACUUM INTO failed (${err instanceof Error ? err.message : String(err)}); ` +
        'falling back to a raw file copy, which is NOT guaranteed consistent while the server is running. ' +
        'Stop the server and re-run, or treat the drill as the gate.',
    );
    cpSync(dbPath, dest);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) cpSync(`${dbPath}${suffix}`, `${dest}${suffix}`);
    }
    return 'file-copy';
  }
}

/**
 * Count the asset bytes and their git-tracked descriptors, and name the two
 * ways they can disagree. ADR-0003's rule is that a missing asset fails cleanly
 * and visibly rather than being silently lost, so both directions are recorded:
 * a descriptor with no bytes is loss; bytes with no descriptor survive as files
 * but are invisible to a rebuild-from-git.
 */
function inventoryAssets(dir: string): {
  descriptors: number;
  byte_files: number;
  total_bytes: number;
  missing_bytes: string[];
  undescribed_bytes: string[];
} {
  if (!existsSync(dir)) {
    return { descriptors: 0, byte_files: 0, total_bytes: 0, missing_bytes: [], undescribed_bytes: [] };
  }
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const descriptors = entries.filter((e) => e.name.endsWith('.meta.json')).map((e) => e.name);
  const bytes = entries.filter((e) => !e.name.endsWith('.meta.json')).map((e) => e.name);
  const byteSet = new Set(bytes);
  const described = new Set(descriptors.map((d) => d.slice(0, -'.meta.json'.length)));
  return {
    descriptors: descriptors.length,
    byte_files: bytes.length,
    total_bytes: bytes.reduce((n, f) => n + statSync(join(dir, f)).size, 0),
    missing_bytes: [...described].filter((f) => !byteSet.has(f)).sort(),
    undescribed_bytes: bytes.filter((f) => !described.has(f)).sort(),
  };
}

/**
 * The destination must be empty and must not be, contain, or sit inside the
 * live data. Writing a backup into the thing being backed up is how a "backup"
 * becomes a recursive copy that fills the disk and corrupts the source.
 */
function prepareOutDir(outDir: string, live: { contentRoot: string; dbPath: string; force: boolean }): void {
  if (isInside(outDir, live.contentRoot) || isInside(live.contentRoot, outDir)) {
    throw new Error(`--out ${outDir} overlaps the live content root ${live.contentRoot}. Choose a destination outside it.`);
  }
  if (isInside(dirname(live.dbPath), outDir)) {
    throw new Error(`--out ${outDir} contains the live database ${live.dbPath}. Choose a destination outside it.`);
  }
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.length > 0 && !live.force) {
      throw new Error(`--out ${outDir} is not empty (${entries.length} entries). Use a new directory, or pass --force.`);
    }
    if (entries.length > 0) rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
}

function report(m: BackupManifest, outDir: string, log: Logger): void {
  const total = m.trees.reduce((n, t) => n + t.tracked_files, 0);
  const dirty = m.trees.filter((t) => t.dirty.length > 0);
  log('');
  log('[backup] CAPTURED');
  log(`[backup]   git      : ${m.trees.length} working tree(s), ${total} tracked file(s)`);
  for (const t of m.trees) {
    log(
      `[backup]              ${t.source_id ?? '(unregistered)'} @ ${t.head?.slice(0, 9) ?? 'no-commit'} ` +
        `(${t.branch ?? '?'}) ${t.remote ?? 'local-only'}${t.dirty.length ? ` — ${t.dirty.length} uncommitted path(s)` : ''}`,
    );
  }
  log(`[backup]   assets   : ${m.assets.byte_files} file(s), ${m.assets.descriptors} descriptor(s), ${humanBytes(m.assets.total_bytes)}`);
  log(`[backup]   database : ${humanBytes(m.db.bytes)} via ${m.db.method}; ${m.db.counts['pages'] ?? '?'} page(s), ${m.db.counts['users'] ?? '?'} user(s), ${m.db.counts['api_tokens'] ?? '?'} token(s)`);
  log(`[backup]   config   : ${m.config.archive_path ?? '(none found)'}`);
  log('');
  log('[backup] NOT CAPTURED');
  for (const line of m.not_captured) log(`[backup]   - ${line}`);
  if (m.assets.missing_bytes.length > 0) {
    log(`[backup]   - ${m.assets.missing_bytes.length} asset descriptor(s) whose BYTES were already missing at capture (ADR-0003): ${m.assets.missing_bytes.slice(0, 5).join(', ')}`);
  }
  if (m.config.secret_env_names.length > 0) {
    log(`[backup]   - the VALUES of: ${m.config.secret_env_names.join(', ')}`);
  }
  if (dirty.length > 0) {
    log('');
    log(`[backup] NOTE: ${dirty.length} working tree(s) had uncommitted changes at capture. They were captured as-is;`);
    log('[backup]       the drill asserts the restore reproduces exactly that state, not a clean one.');
  }
  if (m.db.wal_present_at_capture) {
    log('');
    log('[backup] NOTE: a -wal file was present, so the server was probably running. The VACUUM INTO snapshot is');
    log('[backup]       still consistent for the DB, but the git trees and assets were copied file-by-file while');
    log('[backup]       writes were possible. Quiesce writers for a point-in-time capture of all three parts.');
  }
  log('');
  log(`[backup] done in ${humanDuration(m.capture.duration_ms)} → ${outDir}`);
  log(`[backup] newest change captured: ${m.newest_change_at ?? '(unknown)'}`);
  log('[backup] verify it: pnpm --filter @echozedlabs/server drill:restore --from ' + outDir);
}

/* --------------------------------- CLI ------------------------------------ */

function parseArgs(argv: string[]): BackupOptions {
  const out: Partial<BackupOptions> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--out' || a === '-o') out.outDir = next();
    else if (a === '--content-root') out.contentRoot = next();
    else if (a === '--db') out.dbPath = next();
    else if (a === '--assets') out.assetsDir = next();
    else if (a === '--config') out.configFile = next();
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}. ${USAGE}`);
  }
  out.outDir ??= join(process.cwd(), 'data', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  return out as BackupOptions;
}

const USAGE = `usage: backup [--out <dir>] [--content-root <dir>] [--db <file>] [--assets <dir>] [--config <file>] [--force]`;

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runBackup(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('[backup] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
