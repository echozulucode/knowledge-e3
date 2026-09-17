/**
 * The restore drill (issue 71) — restore the complete recovery unit into a
 * **fresh, isolated instance**, prove it works, and put a number on RPO and RTO.
 *
 *   pnpm --filter @echozedlabs/server drill:restore                 # back up, then drill it
 *   pnpm --filter @echozedlabs/server drill:restore --from <backup> # drill an existing backup
 *
 * Exits non-zero on any failed check, so it can be scheduled.
 *
 * **The property that matters most is isolation**, and it is enforced three
 * ways rather than trusted:
 *
 *  1. The drill never opens the live database or the live content root at all.
 *     It reads the backup directory and writes only into its own target.
 *  2. The target is rejected if it is, contains, or sits inside the live
 *     content root or the live database's directory, or the backup itself.
 *  3. Every restored working tree has its git remotes **detached**, and every
 *     `content_sources.remote_url` in the restored index is nulled, before the
 *     verification instance is booted. A restored copy that can still reach the
 *     production remote is not a drill, it is an incident: the sync engine
 *     would fetch, the committer would push, and the "safe" rehearsal would
 *     write to the real repository.
 *
 * **Structural checks are not enough.** `PRAGMA integrity_check` says the file
 * is a well-formed database, not that the thing can serve a page. So the drill
 * boots the real Nest application against the restored copy, on loopback, and
 * signs in, reads a known item, searches for it, and fetches an asset. This is
 * the operational sibling of `tests/conformance.e2e.test.ts`, which proves a
 * rebuild reproduces the live answers; this proves a *restore* can answer at all.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resetServerConfig } from '../src/config/server-config.js';
import { KYSELY } from '../src/db/db.module.js';
import { runBackup } from './backup.js';
import {
  abs,
  countOrNull,
  fileBytes,
  gitOrNull,
  humanBytes,
  isInside,
  MANIFEST_NAME,
  openSqlite,
  queryAll,
  readTree,
  resolveLivePaths,
  sha256File,
  type BackupManifest,
  type Logger,
} from './recovery-unit.js';

/* -------------------------------------------------------------------------- */
/* Report shape                                                                */
/* -------------------------------------------------------------------------- */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface DrillCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface DrillReport {
  ok: boolean;
  started_at: string;
  finished_at: string;
  backup_dir: string;
  target: string;
  target_kept: boolean;
  checks: DrillCheck[];
  /**
   * Recovery Point Objective, measured against THIS artifact: every write made
   * after the capture started is unprotected by it. A scheduled backup's real
   * RPO is the schedule interval plus this window.
   */
  rpo: {
    newest_change_in_backup: string | null;
    capture_started_at: string;
    capture_finished_at: string;
    capture_window_seconds: number;
    backup_age_seconds: number;
    /** now − capture start: the worst-case span of writes a restore from here loses. */
    seconds: number;
  };
  /** Recovery Time Objective: wall clock for restore + verify. `excludes` is the honest part. */
  rto: {
    seconds: number;
    phases: { restore: number; integrity: number; boot: number; functional: number };
    excludes: string[];
  };
  /** Parts of the recovery unit this run did NOT verify. The honesty check. */
  not_covered: string[];
}

export interface DrillOptions {
  /** An existing backup directory. Omit to take a fresh backup first. */
  backupDir?: string;
  /** Where the isolated instance is restored. Defaults to a fresh temp directory. */
  target?: string;
  /** Slug of the item the functional checks use. Defaults to the newest published item. */
  item?: string;
  /** Real credentials from the restored instance, so sign-in is proven against a restored user. */
  username?: string;
  password?: string;
  /** Keep the restored instance on success (it is always kept on failure). */
  keep?: boolean;
  /** Write the JSON report here as well as printing it. */
  json?: string;
  log?: Logger;
}

const RTO_EXCLUDES = [
  'detecting the outage and deciding to restore',
  'provisioning a host, image pull, DNS and TLS',
  'restoring secret values and re-issuing API tokens',
  're-cloning sources from their remotes (the drill detaches remotes)',
  'rebuild-from-git, if the restored index is not trusted (runbook §3.7)',
];

/* -------------------------------------------------------------------------- */
/* The drill                                                                   */
/* -------------------------------------------------------------------------- */

export async function runRestoreDrill(opts: DrillOptions = {}): Promise<DrillReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const startedAt = new Date();
  const checks: DrillCheck[] = [];
  const add = (c: DrillCheck): DrillCheck => {
    checks.push(c);
    log(`[drill] ${c.status.toUpperCase().padEnd(4)} ${c.title}${c.detail ? ` — ${c.detail}` : ''}`);
    return c;
  };

  // ---- the artifact under test --------------------------------------------
  let backupDir = opts.backupDir ? abs(opts.backupDir) : '';
  if (!backupDir) {
    backupDir = mkdtempSync(join(tmpdir(), 'e3-drill-backup-'));
    log('[drill] no --from given; taking a fresh backup of the live instance first');
    await runBackup({ outDir: backupDir, force: true, log });
    log('');
  }
  const manifest = readManifest(backupDir);

  const target = abs(opts.target ?? mkdtempSync(join(tmpdir(), 'e3-drill-restore-')));
  assertIsolated(target, backupDir, manifest);
  log(`[drill] backup   : ${backupDir}`);
  log(`[drill] target   : ${target}   (isolated; the live instance is never opened)`);
  log('');

  const phases = { restore: 0, integrity: 0, boot: 0, functional: 0 };
  let app: Booted['app'] | null = null;
  let ok = false;
  const restoreEnv = captureEnv();

  try {
    // ---- phase 1: restore ------------------------------------------------
    const t1 = performance.now();
    const layout = restoreFiles(backupDir, target, manifest, log);
    detachRemotes(layout, add);
    remapRegistry(layout, add, log);
    phases.restore = performance.now() - t1;

    // ---- phase 2: structural integrity -----------------------------------
    // Every structural check runs even after one fails: an operator at 2am
    // needs the whole picture in one pass, not one symptom at a time.
    const t2 = performance.now();
    const dbOk = checkSqlite(layout, manifest, add);
    const treesOk = checkTrees(layout, manifest, add);
    const assetsOk = checkAssets(layout, manifest, add);
    const structuralOk = dbOk && treesOk && assetsOk;
    phases.integrity = performance.now() - t2;

    // ---- phase 3 + 4: boot the real application and use it ----------------
    // A restore that passes integrity_check and cannot serve a page has not
    // been verified. Skipped only when the structure is already broken —
    // there is nothing to learn from booting a corrupt database, and the
    // report says so rather than implying the functional half passed.
    if (!structuralOk) {
      add({
        id: 'functional',
        title: 'functional checks',
        status: 'skip',
        detail: 'structural checks failed; a broken restore was not booted',
      });
    } else {
      const t3 = performance.now();
      const booted = await bootRestored(layout, log);
      app = booted.app;
      phases.boot = performance.now() - t3;
      const t4 = performance.now();
      await functionalChecks(booted.baseUrl, booted.app, layout, opts, add);
      phases.functional = performance.now() - t4;
    }

    ok = checks.every((c) => c.status !== 'fail');
  } finally {
    if (app) await shutdownRestored(app);
    restoreEnv();
  }

  const finishedAt = new Date();
  // Removing the restored copy must never turn a passing drill into a failing
  // one, so this is best-effort and its result is *reported* rather than
  // thrown. On Windows the restored instance's SQLite handle can outlive the
  // application that opened it, and the unlink then fails with EPERM — which,
  // raised from here, reports a drill that passed every single check as a
  // failure, and takes the summary and the `--json` report down with it. A
  // temp directory left behind is a tidiness problem; a false failure costs an
  // operator a night proving their backup is fine. `target_kept` is therefore
  // read back from the filesystem rather than assumed.
  if (!(opts.keep === true || !ok)) discardTarget(target, log);
  const keep = existsSync(target);

  const captureStart = Date.parse(manifest.capture.started_at);
  const captureEnd = Date.parse(manifest.capture.finished_at);
  const report: DrillReport = {
    ok,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    backup_dir: backupDir,
    target,
    target_kept: keep,
    checks,
    rpo: {
      newest_change_in_backup: manifest.newest_change_at,
      capture_started_at: manifest.capture.started_at,
      capture_finished_at: manifest.capture.finished_at,
      capture_window_seconds: round1((captureEnd - captureStart) / 1000),
      backup_age_seconds: round1((finishedAt.getTime() - captureEnd) / 1000),
      seconds: round1((finishedAt.getTime() - captureStart) / 1000),
    },
    rto: {
      seconds: round1((finishedAt.getTime() - startedAt.getTime()) / 1000),
      phases: {
        restore: round1(phases.restore / 1000),
        integrity: round1(phases.integrity / 1000),
        boot: round1(phases.boot / 1000),
        functional: round1(phases.functional / 1000),
      },
      excludes: RTO_EXCLUDES,
    },
    not_covered: notCovered(manifest, opts, checks),
  };

  printSummary(report, log);
  if (opts.json) writeFileSync(abs(opts.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to restore anywhere that could touch live data. Every clause here is a
 * way a hurried operator (or a test) could aim the drill at production: the
 * live content root, the directory holding the live database, the repository's
 * own `data/`, or the backup it is restoring from.
 */
function assertIsolated(target: string, backupDir: string, manifest: BackupManifest): void {
  const live = resolveLivePaths();
  const forbidden: [string, string][] = [
    [manifest.live.content_root, "the backup's own content root"],
    [live.contentRoot, 'this instance\'s live content root'],
    [dirname(manifest.live.db_path), "the backup's database directory"],
    [dirname(live.dbPath), "this instance's live database directory"],
    [backupDir, 'the backup directory being restored'],
  ];
  for (const [path, what] of forbidden) {
    if (!path) continue;
    if (isInside(target, path) || isInside(path, target)) {
      throw new Error(
        `restore target ${target} overlaps ${what} (${path}). A drill must never be able to touch live data; ` +
          'choose a target outside it (the default is a fresh temp directory).',
      );
    }
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`restore target ${target} is not empty. A drill restores into a FRESH instance; use an empty directory.`);
  }
  mkdirSync(target, { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

interface RestoredLayout {
  target: string;
  contentRoot: string;
  dbPath: string;
  assetsDir: string;
  configFile: string;
  /** Restored working trees, paired with their manifest entry. */
  trees: { archive_path: string; dir: string; sourceId: string | null; localDir: string }[];
}

function restoreFiles(backupDir: string, target: string, manifest: BackupManifest, log: Logger): RestoredLayout {
  const contentRoot = join(target, 'content');
  cpSync(join(backupDir, 'content'), contentRoot, { recursive: true, dereference: false });
  if (existsSync(join(backupDir, 'external'))) {
    cpSync(join(backupDir, 'external'), join(target, 'external'), { recursive: true, dereference: false });
  }
  const dbPath = join(target, 'kp.sqlite');
  cpSync(join(backupDir, manifest.db.archive_path), dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const side = join(backupDir, `${manifest.db.archive_path}${suffix}`);
    if (existsSync(side)) cpSync(side, `${dbPath}${suffix}`);
  }
  const assetsSource = join(backupDir, manifest.assets.archive_path);
  const assetsDir = manifest.assets.in_content_root
    ? join(target, manifest.assets.archive_path)
    : join(target, 'assets');
  if (!manifest.assets.in_content_root && existsSync(assetsSource)) {
    cpSync(assetsSource, assetsDir, { recursive: true, dereference: false });
  }

  const trees = manifest.trees.map((t) => ({
    archive_path: t.archive_path,
    dir: join(target, t.archive_path),
    sourceId: t.source_id,
    // Inside the content root a source keeps its relative `local_dir`; a tree
    // captured from outside it is remapped to its new absolute home.
    localDir: t.archive_path.startsWith('content') ? t.local_dir : join(target, t.archive_path),
  }));

  // A generated config, so the restored instance can never be steered back at
  // the live paths by a `content.root` / `database.url` the captured config
  // file happens to name. No `sources:` block: reconciliation from an empty
  // list is a no-op, which leaves the remapped registry rows standing.
  const configFile = join(target, 'knowledge-e3.config.yaml');
  writeFileSync(
    configFile,
    [
      '# Generated by restore-drill. This is an isolated verification instance;',
      '# remotes are detached and nothing here should ever be deployed.',
      'content:',
      `  root: ${yamlPath(contentRoot)}`,
      'git:',
      '  enabled: true',
      `  root: ${yamlPath(contentRoot)}`,
      'database:',
      `  url: ${yamlPath(dbPath)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(target, 'RESTORED-BY-DRILL.txt'),
    `Restored from ${backupDir} at ${new Date().toISOString()} by scripts/restore-drill.ts.\n` +
      'Git remotes are detached and content_sources.remote_url is nulled: this copy cannot push anywhere.\n',
    'utf8',
  );
  log(`[drill] restored ${manifest.trees.length} working tree(s), ${humanBytes(fileBytes(dbPath))} of database, assets at ${assetsDir}`);
  return { target, contentRoot, dbPath, assetsDir, configFile, trees };
}

/** Single-quoted YAML: literal, so a Windows path's backslashes survive. */
function yamlPath(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Detach every remote in every restored tree. Belt: `git remote remove` means a
 * push has nowhere to go. Braces: `remapRegistry` nulls `remote_url`, because
 * `prepare-repo` re-creates `origin` from the registry row on the next sync.
 */
function detachRemotes(layout: RestoredLayout, add: (c: DrillCheck) => void): void {
  const detached: string[] = [];
  for (const t of layout.trees) {
    const remotes = (gitOrNull(t.dir, 'remote') ?? '').split('\n').filter((r) => r.trim() !== '');
    for (const r of remotes) {
      const url = gitOrNull(t.dir, 'remote', 'get-url', r);
      gitOrNull(t.dir, 'remote', 'remove', r);
      detached.push(`${t.sourceId ?? t.archive_path}:${r} → ${url ?? '?'}`);
    }
  }
  add({
    id: 'isolation.remotes',
    title: 'restored trees cannot reach any remote',
    status: 'pass',
    detail: detached.length ? `detached ${detached.length}: ${detached.join(', ')}` : 'no remotes were configured',
  });
}

/**
 * Point the restored registry at the restored trees, and cut its remotes.
 *
 * A restore into a different path is the normal case, not the exception, and a
 * registry row whose `local_dir` is an absolute path from the old host would
 * make the verification instance index — and eventually write to — the live
 * working trees. Every rewrite is reported.
 */
function remapRegistry(layout: RestoredLayout, add: (c: DrillCheck) => void, log: Logger): void {
  const db = openSqlite(layout.dbPath);
  const rewritten: string[] = [];
  try {
    const rows = queryAll<{ id: string; local_dir: string; remote_url: string | null }>(
      db,
      'SELECT id, local_dir, remote_url FROM content_sources',
    );
    for (const row of rows) {
      const tree = layout.trees.find((t) => t.sourceId === row.id);
      const localDir = tree ? tree.localDir : row.local_dir;
      if (localDir !== row.local_dir) rewritten.push(`${row.id}: ${row.local_dir} → ${localDir}`);
      db.prepare('UPDATE content_sources SET local_dir = ?, remote_url = NULL WHERE id = ?').run(localDir, row.id);
    }
    add({
      id: 'isolation.registry',
      title: 'restored registry points only at restored paths',
      status: 'pass',
      detail: `${rows.length} source(s); remote_url nulled${rewritten.length ? `; remapped ${rewritten.join(', ')}` : ''}`,
    });
  } catch (err) {
    // No registry table at all is survivable (an empty or pre-registry DB);
    // the integrity phase will still report what the database does contain.
    log(`[drill] note: could not read content_sources (${err instanceof Error ? err.message : String(err)})`);
    add({ id: 'isolation.registry', title: 'restored registry points only at restored paths', status: 'warn', detail: 'no content_sources table in the restored index' });
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Structural checks                                                           */
/* -------------------------------------------------------------------------- */

function checkSqlite(layout: RestoredLayout, manifest: BackupManifest, add: (c: DrillCheck) => DrillCheck): boolean {
  let allOk = true;
  const fail = (id: string, title: string, detail: string): void => {
    add({ id, title, status: 'fail', detail });
    allOk = false;
  };

  if (manifest.db.method === 'file-copy') {
    add({
      id: 'db.method',
      title: 'database snapshot method',
      status: 'warn',
      detail: 'the backup is a raw file copy, not a VACUUM INTO snapshot — consistency rests entirely on the checks below',
    });
  }

  let opened: ReturnType<typeof openSqlite>;
  try {
    opened = openSqlite(layout.dbPath);
  } catch (err) {
    fail('db.open', 'restored database opens', err instanceof Error ? err.message : String(err));
    return false;
  }
  const db = opened;
  try {
    const integrity = queryAll<Record<string, unknown>>(db, 'PRAGMA integrity_check').map((r) => String(Object.values(r)[0]));
    if (integrity.length === 1 && integrity[0] === 'ok') {
      add({ id: 'db.integrity_check', title: 'PRAGMA integrity_check', status: 'pass', detail: 'ok' });
    } else {
      fail('db.integrity_check', 'PRAGMA integrity_check', integrity.slice(0, 5).join('; ') || 'no result');
    }

    const fks = queryAll<Record<string, unknown>>(db, 'PRAGMA foreign_key_check');
    if (fks.length === 0) {
      add({ id: 'db.foreign_key_check', title: 'PRAGMA foreign_key_check', status: 'pass', detail: 'no violations' });
    } else {
      fail('db.foreign_key_check', 'PRAGMA foreign_key_check', `${fks.length} violation(s): ${JSON.stringify(fks.slice(0, 3))}`);
    }

    // Reading every counted table is the check a page-level corruption that
    // integrity_check happens to tolerate still fails: a malformed record
    // throws on SELECT. It also proves the restore is the same census as the
    // backup, not merely a well-formed database.
    const drift: string[] = [];
    for (const [table, expected] of Object.entries(manifest.db.counts)) {
      const actual = countOrNull(db, table);
      if (actual === null) drift.push(`${table}: unreadable (expected ${expected})`);
      else if (actual !== expected) drift.push(`${table}: ${actual} ≠ ${expected}`);
    }
    if (drift.length === 0) {
      const summary = Object.entries(manifest.db.counts)
        .filter(([t]) => ['pages', 'users', 'api_tokens', 'content_sources', 'images'].includes(t))
        .map(([t, n]) => `${n} ${t}`)
        .join(', ');
      add({ id: 'db.counts', title: 'every table restored at its captured row count', status: 'pass', detail: summary });
    } else {
      fail('db.counts', 'every table restored at its captured row count', drift.join('; '));
    }
  } catch (err) {
    fail('db.read', 'restored database is readable', err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
  return allOk;
}

function checkTrees(layout: RestoredLayout, manifest: BackupManifest, add: (c: DrillCheck) => DrillCheck): boolean {
  let allOk = true;
  for (const entry of manifest.trees) {
    const restored = layout.trees.find((t) => t.archive_path === entry.archive_path)!;
    // Stable, human check ids: `git.main`, `git.topic:portal`. An unregistered
    // tree is named by where it sits, which is all anyone knows about it.
    const label = entry.source_id ?? entry.local_dir;
    if (!existsSync(restored.dir)) {
      add({ id: `git.${label}`, title: `working tree ${label} restored`, status: 'fail', detail: `${restored.dir} is missing` });
      allOk = false;
      continue;
    }
    const facts = readTree(restored.dir);
    const problems: string[] = [];
    if (facts.head !== entry.head) problems.push(`HEAD ${facts.head ?? 'none'} ≠ expected ${entry.head ?? 'none'}`);
    if (facts.tracked_files !== entry.tracked_files) {
      problems.push(`${facts.tracked_files} tracked file(s) ≠ expected ${entry.tracked_files}`);
    }
    // "Clean" means "exactly as captured". A tree that was dirty at capture is
    // restored dirty on purpose — runbook §1: the files may legitimately be
    // ahead of both the index and the last commit, and inventing a clean tree
    // would be losing that work, not verifying it.
    const dirtyNow = facts.dirty.join('\n');
    if (dirtyNow !== entry.dirty.join('\n')) {
      problems.push(`working tree state differs from capture: ${facts.dirty.slice(0, 3).join(' | ') || '(clean)'}`);
    }
    if (problems.length === 0) {
      add({
        id: `git.${label}`,
        title: `working tree ${label} at the expected commit and state`,
        status: entry.dirty.length === 0 ? 'pass' : 'warn',
        detail:
          `${entry.head?.slice(0, 9) ?? 'no-commit'} (${entry.branch ?? '?'}), ${entry.tracked_files} tracked file(s)` +
          (entry.dirty.length ? `; ${entry.dirty.length} uncommitted path(s), restored as captured` : ''),
      });
    } else {
      add({ id: `git.${label}`, title: `working tree ${label} at the expected commit and state`, status: 'fail', detail: problems.join('; ') });
      allOk = false;
    }
  }
  if (manifest.trees.length === 0) {
    add({ id: 'git', title: 'git working trees', status: 'warn', detail: 'the backup contains no working trees — the content of record is not covered' });
  }
  return allOk;
}

/**
 * Every descriptor's bytes must be present, the right size, and the right
 * content. ADR-0003: the descriptor is git-tracked even when the bytes are not,
 * so a descriptor without bytes is exactly the loss the drill exists to find —
 * and it must fail cleanly and visibly rather than surface as a broken image.
 */
function checkAssets(layout: RestoredLayout, manifest: BackupManifest, add: (c: DrillCheck) => DrillCheck): boolean {
  const dir = layout.assetsDir;
  if (!existsSync(dir)) {
    add({
      id: 'assets',
      title: 'asset bytes present for every descriptor',
      status: manifest.assets.descriptors === 0 ? 'skip' : 'fail',
      detail: manifest.assets.descriptors === 0 ? 'no assets in this instance' : `assets directory ${dir} is missing`,
    });
    return manifest.assets.descriptors === 0;
  }
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const missing: string[] = [];
  const wrong: string[] = [];
  let checked = 0;
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const raw = safeJson(join(dir, name));
    const file = typeof raw?.['file'] === 'string' ? (raw['file'] as string) : name.slice(0, -'.meta.json'.length);
    const bytesPath = join(dir, file);
    // A descriptor that was already byte-less at capture is a pre-existing gap
    // the backup recorded; it is not the restore losing something.
    if (manifest.assets.missing_bytes.includes(file)) continue;
    checked += 1;
    if (!existsSync(bytesPath)) {
      missing.push(file);
      continue;
    }
    const size = statSync(bytesPath).size;
    if (typeof raw?.['byte_size'] === 'number' && size !== raw['byte_size']) {
      wrong.push(`${file}: ${size} B ≠ declared ${raw['byte_size']} B`);
      continue;
    }
    if (typeof raw?.['sha256'] === 'string') {
      const actual = createHash('sha256').update(readFileSync(bytesPath)).digest('hex');
      if (actual !== raw['sha256']) wrong.push(`${file}: sha256 mismatch`);
    }
  }
  // The index's own view: an `images` row whose bytes are gone renders a 404 in
  // the app, so it is checked from that side too.
  const db = openSqlite(layout.dbPath, { readOnly: true });
  let indexed = 0;
  try {
    for (const row of queryAll<{ file: string }>(db, 'SELECT file FROM images')) {
      indexed += 1;
      if (!existsSync(join(dir, row.file)) && !missing.includes(row.file)) missing.push(row.file);
    }
  } catch {
    /* no images table: covered by the count check */
  } finally {
    db.close();
  }

  if (missing.length === 0 && wrong.length === 0) {
    add({
      id: 'assets',
      title: 'asset bytes present for every descriptor',
      status: 'pass',
      detail: `${checked} descriptor(s), ${indexed} indexed asset(s), ${humanBytes(manifest.assets.total_bytes)}`,
    });
    if (manifest.assets.missing_bytes.length > 0) {
      add({
        id: 'assets.pre_existing_gap',
        title: 'assets already missing before the backup',
        status: 'warn',
        detail: `${manifest.assets.missing_bytes.length} descriptor(s) had no bytes at capture: ${manifest.assets.missing_bytes.slice(0, 5).join(', ')}`,
      });
    }
    return true;
  }
  add({
    id: 'assets',
    title: 'asset bytes present for every descriptor',
    status: 'fail',
    detail: [missing.length ? `missing bytes: ${missing.slice(0, 5).join(', ')}` : '', wrong.length ? `corrupt: ${wrong.slice(0, 5).join(', ')}` : '']
      .filter(Boolean)
      .join('; '),
  });
  return false;
}

function safeJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Functional checks — boot the real app against the restored copy             */
/* -------------------------------------------------------------------------- */

interface Booted {
  app: { close(): Promise<void>; get<T>(token: unknown): T; getHttpServer(): { address(): AddressInfo | string | null } };
  baseUrl: string;
}

/**
 * Boot the shipped application against the restored paths, on loopback.
 *
 * Every path the app resolves is forced through the environment, which is read
 * live at each use site and therefore wins over anything the captured config
 * file says (server-config.ts). That is what stops a restored config from
 * steering the verification instance back at the live content root.
 */
async function bootRestored(layout: RestoredLayout, log: Logger): Promise<Booted> {
  process.env['DB_URL'] = layout.dbPath;
  process.env['CONTENT_ROOT'] = layout.contentRoot;
  process.env['GIT_MIRROR_ROOT'] = layout.contentRoot;
  process.env['KNOWLEDGE_E3_ASSETS_DIR'] = layout.assetsDir;
  process.env['KNOWLEDGE_E3_CONFIG'] = layout.configFile;
  // A single-tree override and the sync opt-in would both undo the isolation
  // above; neither belongs in a drill.
  delete process.env['GIT_MIRROR_DIR'];
  delete process.env['KNOWLEDGE_E3_SYNC'];

  resetServerConfig();
  const [{ NestFactory }, { AppModule }, { configureApp }] = await Promise.all([
    import('@nestjs/core'),
    import('../src/app.module.js'),
    import('../src/bootstrap.js'),
  ]);

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app, { webDist: null });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`[drill] restored instance is up on ${baseUrl} (loopback only)`);
  return { app: app as unknown as Booted['app'], baseUrl };
}

async function functionalChecks(
  baseUrl: string,
  app: Booted['app'],
  layout: RestoredLayout,
  opts: DrillOptions,
  add: (c: DrillCheck) => DrillCheck,
): Promise<void> {
  // ---- sign in ----------------------------------------------------------
  let cookie: string | null = null;
  if (opts.username && opts.password) {
    cookie = await login(baseUrl, opts.username, opts.password);
    add({
      id: 'fn.signin',
      title: 'sign-in works with a restored credential',
      status: cookie ? 'pass' : 'fail',
      detail: cookie ? `${opts.username} signed in and got a session` : `${opts.username} could not sign in`,
    });
    if (!cookie) return;
  } else {
    // No credential was supplied, so the drill proves the auth stack end to end
    // with a throwaway admin it creates in the RESTORED copy. That is a real
    // check of users/sessions/scrypt/cookies — but it is explicitly NOT proof
    // that a real user's restored password still works, and the report says so.
    const { AuthService } = await import('../src/auth/auth.service.js');
    const username = `drill-${Date.now().toString(36)}`;
    const password = `Drill!${Math.random().toString(36).slice(2)}Aa1`;
    await app.get<InstanceType<typeof AuthService>>(AuthService).createUser({
      email: `${username}@restore-drill.invalid`,
      username,
      password,
      role: 'admin',
    });
    cookie = await login(baseUrl, username, password);
    add({
      id: 'fn.signin',
      title: 'sign-in works (auth stack end to end)',
      status: cookie ? 'pass' : 'fail',
      detail: cookie
        ? 'a throwaway admin created in the restored copy signed in; pass --username/--password to prove a RESTORED credential instead'
        : 'the throwaway admin could not sign in',
    });
    if (!cookie) return;
  }

  const users = withCookie(baseUrl, cookie);

  // ---- a known item is retrievable --------------------------------------
  const known = pickKnownItem(layout, opts.item);
  if (!known) {
    add({ id: 'fn.item', title: 'a known item is retrievable', status: 'skip', detail: 'the restored index has no published item to read' });
    add({ id: 'fn.search', title: 'search returns that item', status: 'skip', detail: 'no published item' });
  } else {
    const res = await users(`/api/v1/items/${encodeURIComponent(known.slug)}`);
    const item = (res.body as { item?: { id?: string; title?: string } | null })?.item ?? null;
    add({
      id: 'fn.item',
      title: 'a known item is retrievable',
      status: res.status === 200 && item?.id === known.id ? 'pass' : 'fail',
      detail: res.status === 200 && item?.id === known.id ? `/p/${known.slug} → "${item.title}"` : `HTTP ${res.status}, got ${JSON.stringify(item)?.slice(0, 120)}`,
    });

    // ---- search returns it ----------------------------------------------
    const term = searchTerm(known.title);
    if (!term) {
      add({ id: 'fn.search', title: 'search returns that item', status: 'skip', detail: `no usable term in the title "${known.title}"` });
    } else {
      const sres = await users(`/api/v1/search?q=${encodeURIComponent(term)}&limit=50`);
      const hits = ((sres.body as { results?: { slug: string }[] })?.results ?? []).map((h) => h.slug);
      add({
        id: 'fn.search',
        title: 'search returns that item',
        status: sres.status === 200 && hits.includes(known.slug) ? 'pass' : 'fail',
        detail: sres.status === 200 && hits.includes(known.slug) ? `"${term}" → ${hits.length} hit(s) including ${known.slug}` : `HTTP ${sres.status}, "${term}" → ${hits.slice(0, 5).join(', ') || 'no hits'}`,
      });
    }
  }

  // ---- an asset resolves -------------------------------------------------
  const asset = pickAsset(layout);
  if (!asset) {
    add({ id: 'fn.asset', title: 'an asset resolves', status: 'skip', detail: 'the restored index has no assets' });
  } else {
    const res = await users(`/assets/${asset.file}`, { raw: true });
    const bytes = res.bytes ?? 0;
    add({
      id: 'fn.asset',
      title: 'an asset resolves',
      status: res.status === 200 && bytes === asset.byte_size ? 'pass' : 'fail',
      detail: res.status === 200 && bytes === asset.byte_size ? `/assets/${asset.file} → ${bytes} B` : `HTTP ${res.status}, ${bytes} B (expected ${asset.byte_size})`,
    });
  }

  // ---- the admin health surface answers ----------------------------------
  // Not a liveness probe: `/healthz` returns ok unconditionally and proves
  // nothing (runbook §2). This one walks the whole derived index.
  const health = await users('/api/v1/admin/health/content');
  const totals = (health.body as { totals?: { items?: number } })?.totals;
  add({
    id: 'fn.health',
    title: 'content health reports on the restored index',
    status: health.status === 200 && typeof totals?.items === 'number' ? 'pass' : 'fail',
    detail: health.status === 200 && typeof totals?.items === 'number' ? `${totals.items} item(s) reported` : `HTTP ${health.status}`,
  });
}

function pickKnownItem(layout: RestoredLayout, slug?: string): { id: string; slug: string; title: string } | null {
  const db = openSqlite(layout.dbPath, { readOnly: true });
  try {
    const rows = slug
      ? queryAll<{ id: string; slug: string; title: string }>(
          db,
          `SELECT id, slug, title FROM pages WHERE slug = '${slug.replace(/'/g, "''")}' AND deleted_at IS NULL`,
        )
      : queryAll<{ id: string; slug: string; title: string }>(
          db,
          "SELECT id, slug, title FROM pages WHERE deleted_at IS NULL AND status = 'published' ORDER BY updated_at DESC LIMIT 1",
        );
    return rows[0] ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function pickAsset(layout: RestoredLayout): { file: string; byte_size: number } | null {
  const db = openSqlite(layout.dbPath, { readOnly: true });
  try {
    for (const row of queryAll<{ file: string; byte_size: number }>(db, 'SELECT file, byte_size FROM images')) {
      if (existsSync(join(layout.assetsDir, row.file))) return { file: row.file, byte_size: Number(row.byte_size) };
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The longest alphabetic word of a title: unlikely to be a stop word, and stable. */
function searchTerm(title: string): string | null {
  const words = title
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length);
  return words[0] ?? null;
}

async function login(baseUrl: string, username: string, password: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) return null;
  const setCookie: string[] =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  const session = setCookie.find((c) => c.startsWith('kp_session='));
  return session ? session.split(';')[0]! : null;
}

function withCookie(baseUrl: string, cookie: string) {
  return async (path: string, opts: { raw?: boolean } = {}): Promise<{ status: number; body?: unknown; bytes?: number }> => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    if (opts.raw) return { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: text };
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function notCovered(manifest: BackupManifest, opts: DrillOptions, checks: DrillCheck[]): string[] {
  const out = [
    'Litestream replication and the restore-on-boot path (docker-entrypoint.sh). It needs LITESTREAM_AZURE_ACCOUNT_KEY and a real Azure Blob replica; this drill neither reads nor verifies one.',
    'Remote git state. The drill detaches remotes, so it does not prove a remote is reachable, that push credentials work, or that a re-clone would reproduce the tree. A local-only source is covered only because its bytes are in the backup.',
    'Secret values (host tokens, webhook secrets). Only their env-var NAMES are captured; a restored instance cannot open a change request until they are supplied.',
    'Rebuild-from-git after a total index loss (runbook §3.7). The drill restores the index rather than reconstructing it; conformance.e2e.test.ts is what proves the rebuild reproduces live answers.',
    'The container image and its entrypoint: this boots the application in-process, not the Docker runtime.',
    'The web UI. The functional checks go through the JSON API only.',
    'Anything written after the capture started — that is the RPO window reported above.',
  ];
  if (!opts.username || !opts.password) {
    out.push('Sign-in with a RESTORED credential: no --username/--password was given, so the drill created a throwaway admin instead. Restored password hashes were not exercised.');
  }
  if (manifest.trees.length === 0) out.push('The git half entirely: this backup contains no working trees.');
  for (const c of checks) {
    if (c.status === 'skip') out.push(`Skipped check "${c.title}": ${c.detail}.`);
  }
  return out;
}

function printSummary(r: DrillReport, log: Logger): void {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const c of r.checks) counts[c.status] += 1;
  log('');
  log(`[drill] ${r.ok ? 'PASS' : 'FAIL'} — ${counts.pass} passed, ${counts.fail} failed, ${counts.warn} warned, ${counts.skip} skipped`);
  log('');
  log(`[drill] RPO ${r.rpo.seconds}s — every write made since the capture started (${r.rpo.capture_started_at}) is not in this backup.`);
  log(`[drill]     capture window ${r.rpo.capture_window_seconds}s, backup age at verification ${r.rpo.backup_age_seconds}s, newest change captured ${r.rpo.newest_change_in_backup ?? 'unknown'}.`);
  log('[drill]     On a schedule, real RPO = the interval between backups + this window.');
  log(`[drill] RTO ${r.rto.seconds}s — restore ${r.rto.phases.restore}s, integrity ${r.rto.phases.integrity}s, boot ${r.rto.phases.boot}s, functional ${r.rto.phases.functional}s.`);
  log(`[drill]     EXCLUDES: ${r.rto.excludes.join('; ')}.`);
  log('');
  log('[drill] NOT COVERED by this drill:');
  for (const line of r.not_covered) log(`[drill]   - ${line}`);
  log('');
  log(`[drill] restored instance ${r.target_kept ? `kept at ${r.target}` : 'removed'}`);
}

/**
 * Close the restored instance AND the database connection it opened.
 *
 * `app.close()` runs Nest's shutdown hooks, and `DbModule` deliberately has
 * nothing to do in its own — connections close when the process exits, which is
 * true for the server and not true here, because this process goes on to delete
 * the files that connection is holding. Destroying it explicitly is what lets
 * the cleanup below succeed on Windows.
 */
async function shutdownRestored(app: Booted['app']): Promise<void> {
  let db: { destroy?: () => Promise<unknown> } | null = null;
  try {
    db = app.get<{ destroy?: () => Promise<unknown> }>(KYSELY);
  } catch {
    // No such provider in this build; the close below is all there is.
  }
  await app.close().catch(() => undefined);
  await db?.destroy?.().catch(() => undefined);
}

/** Remove the restored copy, saying so rather than throwing when it cannot. */
function discardTarget(target: string, log: Logger): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (err) {
    log(`[drill] note: the restored copy could not be removed and is still at ${target} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function readManifest(backupDir: string): BackupManifest {
  const path = join(backupDir, MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new Error(`${path} not found. --from must point at a directory produced by scripts/backup.ts.`);
  }
  const m = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
  if (m.schema_version !== 1) throw new Error(`unsupported backup manifest schema_version ${m.schema_version}`);
  const dbArchive = join(backupDir, m.db.archive_path);
  if (!existsSync(dbArchive)) throw new Error(`the backup's database ${dbArchive} is missing`);
  // The manifest records the snapshot's digest, so a backup corrupted at rest
  // (bad media, a truncated transfer) is caught before anything is restored.
  const actual = sha256File(dbArchive);
  if (actual !== m.db.sha256) {
    throw new Error(`the backup's database digest does not match the manifest (${actual} ≠ ${m.db.sha256}) — this backup is damaged`);
  }
  return m;
}

function captureEnv(): () => void {
  const keys = ['DB_URL', 'CONTENT_ROOT', 'GIT_MIRROR_ROOT', 'GIT_MIRROR_DIR', 'KNOWLEDGE_E3_ASSETS_DIR', 'KNOWLEDGE_E3_CONFIG', 'KNOWLEDGE_E3_SYNC'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // The next consumer in this process must not inherit the drill's config.
    resetServerConfig();
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* --------------------------------- CLI ------------------------------------ */

const USAGE = `usage: drill:restore [--from <backup dir>] [--target <dir>] [--item <slug>]
                    [--username <name> --password <pw>] [--keep] [--json <file>]

With no --from it takes a fresh backup of the live instance first, then drills it.
The target must be outside the live content root and database directory; the
default is a fresh temp directory. Exits non-zero if any check fails.`;

function parseArgs(argv: string[]): DrillOptions {
  const out: DrillOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--from') out.backupDir = next();
    else if (a === '--target') out.target = next();
    else if (a === '--item') out.item = next();
    else if (a === '--username') out.username = next();
    else if (a === '--password') out.password = next();
    else if (a === '--json') out.json = next();
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  // Credentials may also arrive from the environment, so a scheduled job never
  // has to put a password on a command line.
  out.username ??= process.env['DRILL_USERNAME'];
  out.password ??= process.env['DRILL_PASSWORD'];
  return out;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runRestoreDrill(parseArgs(process.argv.slice(2)))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => {
      console.error('[drill] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
