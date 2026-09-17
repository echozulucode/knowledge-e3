/**
 * The ten checks behind `GET /admin/health/system` (plan §5).
 *
 * Each is a free function over its inputs rather than a service method, so a
 * test can drive one check's UNHEALTHY path directly instead of arranging a
 * whole broken instance. `SystemHealthService` composes them.
 *
 * Two of them — `database` and `content_root` — take a `deep` flag. Deep is the
 * admin page (a `PRAGMA quick_check`, a real write probe); shallow is `/readyz`,
 * which a load balancer polls every few seconds and which must therefore cost
 * roughly one round trip.
 */
import { existsSync, statSync } from 'node:fs';
import { rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { BackupDrillStatus } from '@echozedlabs/knowledge-types';
import type { Database } from '../db/schema.js';
import type { SourceStatusView } from '../sync/sync.service.js';
import { envVarPresent, resolveLocalDir } from '../sync/source-registry.service.js';
import { mirrorHealth, type MirrorHealth } from '../content-health/mirror-health.js';
import { worse, type CheckState, type SystemCheck } from './system-health.types.js';

/* -------------------------------------------------------------------------- */
/* Thresholds — each one stated here, once, with its reason.                   */
/* -------------------------------------------------------------------------- */

/**
 * Free space on the content root's filesystem. A PERCENTAGE, not a byte count,
 * because this same product runs on a laptop with a 500 GB disk and in a
 * container with a 10 GB volume, and no absolute floor is right for both.
 */
export const DISK_WARN_PERCENT = 10;
export const DISK_FAIL_PERCENT = 5;

/**
 * A source with a remote is late when it has not synced in this multiple of its
 * own cadence — §5's rule. Three cycles, so one missed fetch and one retry are
 * not an alert.
 */
export const SYNC_STALE_FACTOR = 3;

/**
 * How long a passing restore drill stays believable. A drill proves the backup
 * that existed when it ran; a month of writes later it proves progressively
 * less, and monthly is the cadence a human actually sustains.
 */
export const DRILL_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tables `migrateSqlite` creates. Used as the "migrations applied" probe: there
 * is no migration-version table in this product (the bootstrap is idempotent
 * `ifNotExists` DDL), so the honest question is not "which version ran" but
 * "does the database this process is holding have the shape this binary
 * queries". That is also the question a bad restore answers wrongly, which is
 * the failure `/healthz` cannot see and this check must.
 */
export const REQUIRED_TABLES = [
  'users',
  'sessions',
  'spaces',
  'pages',
  'page_versions',
  'revision_mirror_state',
  'space_repos',
  'page_tags',
  'primary_categories',
  'page_categories',
  'groups',
  'page_groups',
  'item_links',
  'wikilinks',
  'images',
  'image_links',
  'page_views',
  'audit_log',
  'bug_reports',
  'app_config',
  'user_prefs',
  'api_tokens',
  'content_outbox',
  'content_sources',
  'sync_conflicts',
  'sync_diagnostics',
  'login_attempts',
] as const;

/** Probe file the deep content-root check writes and removes. */
const PROBE_PREFIX = '.e3-health-probe-';

/**
 * The nearest ancestor of `path` that exists on disk — `path` itself when it
 * does, and null when nothing on the way to the filesystem root does.
 *
 * This exists because the content root is created LAZILY: `ContentStoreModule`
 * resolves it at boot but `ContentStoreRegistry.forRepo` is what actually
 * `mkdir -p`s a working tree, on first use. A fresh instance that has not been
 * written to yet therefore has no content root directory, and is perfectly
 * healthy. The honest question is not "does this directory exist" but "can this
 * instance write there", and that is a question about the nearest thing that
 * does exist.
 */
export function nearestExisting(path: string): string | null {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function check(
  id: SystemCheck['id'],
  title: string,
  state: CheckState,
  summary: string,
  opts: { action?: string | null; link?: SystemCheck['link']; evidence?: string[] } = {},
): SystemCheck {
  return {
    id,
    title,
    state,
    summary,
    action: opts.action ?? null,
    link: opts.link ?? null,
    evidence: opts.evidence ?? [],
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- */
/* 1. Database                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does the database answer, and is the file structurally sound?
 *
 * Shallow (`/readyz`): one `SELECT 1`. That is the difference between "the port
 * is listening" and "this process can serve a request", which is the whole
 * reason item 13 exists.
 *
 * Deep (the admin page): `PRAGMA quick_check`, which is §5's stated rule and
 * the cheap sibling of the `integrity_check` the restore drill runs — it skips
 * the per-row index cross-checks, so it stays a page-load-sized cost.
 */
export async function checkDatabase(db: Kysely<Database>, opts: { deep: boolean }): Promise<SystemCheck> {
  try {
    await sql`select 1`.execute(db);
  } catch (err) {
    return check('database', 'Database', 'fail', 'The database did not answer.', {
      action: 'Check that the database file is present and readable, then restart the process.',
      evidence: [message(err)],
    });
  }
  if (!opts.deep) return check('database', 'Database', 'ok', 'The database answered.');

  const evidence: string[] = [];
  try {
    const mode = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db);
    const journal = mode.rows[0]?.journal_mode;
    if (journal) evidence.push(`Journal mode: ${journal}`);
    const bytes = await databaseBytes(db);
    if (bytes !== null) evidence.push(`Database size: ${humanBytes(bytes)}`);
  } catch {
    // Evidence is a nicety; never let it decide the verdict.
  }

  try {
    const res = await sql<Record<string, unknown>>`PRAGMA quick_check`.execute(db);
    const lines = res.rows.map((r) => String(Object.values(r)[0] ?? '')).filter(Boolean);
    if (lines.length === 1 && lines[0] === 'ok') {
      return check('database', 'Database', 'ok', 'Reachable, and PRAGMA quick_check reports no corruption.', { evidence });
    }
    return check('database', 'Database', 'fail', 'PRAGMA quick_check reported corruption.', {
      action: 'Stop writes and restore from the most recent verified backup; do not repair in place.',
      evidence: [...evidence, ...lines.slice(0, 5)],
    });
  } catch (err) {
    return check('database', 'Database', 'fail', 'PRAGMA quick_check could not run.', {
      action: 'Check that the database file is present and readable, then restart the process.',
      evidence: [...evidence, message(err)],
    });
  }
}

async function databaseBytes(db: Kysely<Database>): Promise<number | null> {
  const count = await sql<{ page_count: number }>`PRAGMA page_count`.execute(db);
  const size = await sql<{ page_size: number }>`PRAGMA page_size`.execute(db);
  const pages = count.rows[0]?.page_count;
  const bytes = size.rows[0]?.page_size;
  if (typeof pages !== 'number' || typeof bytes !== 'number') return null;
  return pages * bytes;
}

/* -------------------------------------------------------------------------- */
/* 2. Schema / migrations                                                      */
/* -------------------------------------------------------------------------- */

/** Every table this binary queries is present. One `sqlite_master` read. */
export async function checkSchema(db: Kysely<Database>): Promise<SystemCheck> {
  let present: Set<string>;
  try {
    const res = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(db);
    present = new Set(res.rows.map((r) => r.name));
  } catch (err) {
    return check('schema', 'Migrations applied', 'fail', 'The schema could not be read.', {
      action: 'Check that the database file is present and readable, then restart the process.',
      evidence: [message(err)],
    });
  }
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length === 0) {
    return check('schema', 'Migrations applied', 'ok', `All ${REQUIRED_TABLES.length} expected tables are present.`);
  }
  return check('schema', 'Migrations applied', 'fail', `${missing.length} expected table(s) are missing.`, {
    action:
      'Restart the process so migrations run. If they already ran, the database this process opened is not the one it was built for — check DB_URL and the restore that produced it.',
    evidence: [`Missing: ${missing.join(', ')}`],
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Content root                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The canonical content root — the directory the write path writes FIRST
 * (plan §7.2–7.3). If it is gone or read-only, every publish fails at the file
 * write, before the index or the mirror ever sees it.
 *
 * Deep writes and removes a probe file. That is the only way to know on
 * Windows, where `fs.access(W_OK)` reports the read-only ATTRIBUTE and not the
 * ACL that actually decides. Shallow only stats it, because a load balancer
 * polling every few seconds has no business touching the disk.
 */
export async function checkContentRoot(root: string, opts: { deep: boolean }): Promise<SystemCheck> {
  const link = { label: 'Sources', href: '/admin/repos' };
  const base = nearestExisting(root);
  if (base === null) {
    return check('content_root', 'Content root', 'fail', 'Nothing on the path to the content root exists.', {
      action: `Mount the volume that holds ${root}, or point CONTENT_ROOT somewhere that exists.`,
      link,
      evidence: [root],
    });
  }
  if (!statSync(base).isDirectory()) {
    return check('content_root', 'Content root', 'fail', 'The content root path runs through a file.', {
      action: `Point CONTENT_ROOT at a directory; ${base} is a file.`,
      link,
      evidence: [root, `Blocked at: ${base}`],
    });
  }

  // A root that does not exist yet is normal on a fresh instance — the store
  // mkdirs it on the first write — so what matters is whether the nearest
  // existing ancestor can be written to.
  const pending = base !== root;
  const evidence = pending ? [root, `Not created yet; will be created under ${base} on the first write.`] : [root];
  if (!opts.deep) return check('content_root', 'Content root', 'ok', 'The content root resolves.', { evidence });

  const probe = join(base, `${PROBE_PREFIX}${process.pid}`);
  try {
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  } catch (err) {
    return check('content_root', 'Content root', 'fail', 'The content root is not writable.', {
      action: 'Fix the mount or the directory permissions — every publish writes the canonical file here before it is indexed.',
      link,
      evidence: [...evidence, message(err)],
    });
  }
  return check('content_root', 'Content root', 'ok', pending ? 'Writable; not created yet.' : 'Present and writable.', {
    link,
    evidence,
  });
}

/* -------------------------------------------------------------------------- */
/* 4. Disk headroom                                                            */
/* -------------------------------------------------------------------------- */

/** Free space on the filesystem holding the content root (and, normally, the database). */
export async function checkDisk(root: string): Promise<SystemCheck> {
  let free: number;
  let total: number;
  // The root may not exist yet (see nearestExisting); the volume it will live
  // on is the one to measure.
  const target = nearestExisting(root) ?? root;
  try {
    const fs = await statfs(target);
    free = Number(fs.bavail) * Number(fs.bsize);
    total = Number(fs.blocks) * Number(fs.bsize);
  } catch (err) {
    return check('disk', 'Disk headroom', 'warn', 'Free space could not be measured.', {
      action: 'Check free space on the content volume by hand; this instance cannot see it.',
      evidence: [root, message(err)],
    });
  }
  return diskVerdict(free, total, root);
}

/**
 * The threshold half of {@link checkDisk}, split out so both unhealthy bands
 * are testable without a full or a failing filesystem.
 */
export function diskVerdict(free: number, total: number, root: string): SystemCheck {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
    return check('disk', 'Disk headroom', 'warn', 'Free space could not be measured.', {
      action: 'Check free space on the content volume by hand; this instance cannot see it.',
      evidence: [root],
    });
  }
  const percent = (free / total) * 100;
  const evidence = [`${humanBytes(free)} free of ${humanBytes(total)} (${percent.toFixed(1)}%)`, root];
  if (percent < DISK_FAIL_PERCENT) {
    return check('disk', 'Disk headroom', 'fail', `Only ${percent.toFixed(1)}% of the content volume is free.`, {
      action: 'Free space now. A full volume fails the canonical write first, so publishes stop before anything else does.',
      evidence,
    });
  }
  if (percent < DISK_WARN_PERCENT) {
    return check('disk', 'Disk headroom', 'warn', `${percent.toFixed(1)}% of the content volume is free.`, {
      action: 'Plan to grow the volume, or prune old backups and assets.',
      evidence,
    });
  }
  return check('disk', 'Disk headroom', 'ok', `${percent.toFixed(1)}% of the content volume is free.`, { evidence });
}

/* -------------------------------------------------------------------------- */
/* 5. Sources                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every enabled source: its working tree exists, its last sync did not error,
 * and a source with a remote has synced within {@link SYNC_STALE_FACTOR} of its
 * own cadence.
 *
 * An error is `fail` (that source is not exchanging content with its remote at
 * all); lateness is `warn` (§5: a source behind on its fetch is a real problem
 * and not a reason to pull the instance out of rotation).
 */
export function checkSources(
  sources: readonly SourceStatusView[],
  opts: { contentRoot: string; defaultSyncSeconds: number; now: Date },
): SystemCheck {
  const link = { label: 'Sources', href: '/admin/repos' };
  const enabled = sources.filter((s) => s.enabled === 1);
  if (enabled.length === 0) {
    return check('sources', 'Sources', 'ok', 'No source is enabled.', { link });
  }

  let state: CheckState = 'ok';
  const evidence: string[] = [];
  let problems = 0;

  for (const source of enabled) {
    const dir = resolveLocalDir(source.local_dir, opts.contentRoot);
    if (!existsSync(dir)) {
      state = worse(state, 'fail');
      problems += 1;
      evidence.push(`${source.id}: working tree missing at ${dir}`);
      continue;
    }
    if (source.status.last_error) {
      state = worse(state, 'fail');
      problems += 1;
      evidence.push(`${source.id}: last sync failed — ${source.status.last_error}`);
      continue;
    }
    if (!source.remote_url) {
      evidence.push(`${source.id}: local only, nothing to fetch`);
      continue;
    }
    const everySeconds = source.sync_every_seconds ?? opts.defaultSyncSeconds;
    const boundMs = everySeconds * SYNC_STALE_FACTOR * 1000;
    const last = source.status.last_synced_at;
    if (!last) {
      state = worse(state, 'warn');
      problems += 1;
      evidence.push(`${source.id}: has never synced`);
      continue;
    }
    const ageMs = opts.now.getTime() - Date.parse(last);
    if (Number.isNaN(ageMs) || ageMs > boundMs) {
      state = worse(state, 'warn');
      problems += 1;
      evidence.push(`${source.id}: last synced ${last} — later than ${SYNC_STALE_FACTOR}x its ${everySeconds}s cadence`);
      continue;
    }
    evidence.push(`${source.id}: synced ${last}`);
  }

  if (state === 'ok') {
    return check('sources', 'Sources', 'ok', `All ${enabled.length} enabled source(s) are current.`, { link, evidence });
  }
  const summary =
    state === 'fail'
      ? `${problems} of ${enabled.length} enabled source(s) cannot sync.`
      : `${problems} of ${enabled.length} enabled source(s) are behind.`;
  return check('sources', 'Sources', state, summary, {
    action: 'Open Sources, use Test connection on the named source, and read its last error.',
    link,
    evidence,
  });
}

/* -------------------------------------------------------------------------- */
/* 6. Secrets                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every env var the enabled sources depend on, and whether it is set.
 *
 * **Names only, never values** — that is the contract of D4a and of the source
 * registry itself, which stores the env var NAME precisely so the token never
 * lands in the database. Reporting "set" is the whole answer; reporting the
 * value would turn a health page into a credential dump.
 */
export function checkSecrets(sources: readonly SourceStatusView[], env: NodeJS.ProcessEnv): SystemCheck {
  const link = { label: 'Sources', href: '/admin/repos' };
  const required: { name: string; why: string }[] = [];
  for (const source of sources) {
    if (source.enabled !== 1) continue;
    if (source.remote_url && source.host_token_env) {
      required.push({ name: source.host_token_env, why: `${source.id} host token` });
    }
    if (source.webhook_secret_env) {
      required.push({ name: source.webhook_secret_env, why: `${source.id} webhook secret` });
    }
  }
  if (required.length === 0) {
    return check('secrets', 'Secrets', 'ok', 'No enabled source names an env var.', { link });
  }
  // The same predicate the Sources row renders (D4a), so the page and the row
  // can never disagree about whether a token is set.
  const isSet = (name: string): boolean => envVarPresent(name, env);
  const missing = required.filter((r) => !isSet(r.name));
  const evidence = required.map((r) => `${r.name} — ${r.why} — ${isSet(r.name) ? 'set' : 'NOT SET'}`);
  if (missing.length === 0) {
    return check('secrets', 'Secrets', 'ok', `All ${required.length} referenced env var(s) are set.`, { link, evidence });
  }
  return check('secrets', 'Secrets', 'fail', `${missing.length} referenced env var(s) are not set.`, {
    action: `Set ${missing.map((m) => m.name).join(', ')} in the process environment and restart. Until then those sources cannot authenticate.`,
    link,
    evidence,
  });
}

/* -------------------------------------------------------------------------- */
/* 7-8. Git mirror: backlog, and recorded errors                               */
/* -------------------------------------------------------------------------- */

/** Both mirror rows read one `mirrorHealth()` — computed once, split into two findings. */
export function readMirror(db: Kysely<Database>, now: Date): Promise<MirrorHealth> {
  return mirrorHealth(db, now);
}

/**
 * Outbox rows indexed but not yet committed past the mirror's stuck bound.
 *
 * `warn`, never `fail`: the content IS written to the canonical file and IS in
 * the index, so the instance is serving it correctly. What is missing is the
 * commit behind it — a durability lag, which is exactly what `warn` means here.
 */
export function checkGitOutbox(mirror: MirrorHealth): SystemCheck {
  const link = { label: 'Content health', href: '/admin/health' };
  const minutes = Math.round(mirror.stuck_after_ms / 60_000);
  if (mirror.pending.count === 0) {
    return check('git_outbox', 'Git mirror backlog', 'ok', 'No write has been waiting on a commit.');
  }
  const orphaned = mirror.pending.items.filter((i) => i.mirror_state === 'missing').length;
  const evidence = mirror.pending.items
    .slice(0, 5)
    .map((i) => `${i.slug ?? i.page_id}: pending ${i.age_seconds}s, mirror ${i.mirror_state}`);
  if (orphaned > 0) evidence.unshift(`${orphaned} of them have no mirror state at all (issue 88).`);
  return check(
    'git_outbox',
    'Git mirror backlog',
    'warn',
    `${mirror.pending.count} write(s) indexed but not committed for over ${minutes} minutes.`,
    {
      action:
        'The content is on disk and served; the commit behind it is not. Check the git mirror log, then restart to let the outbox replay drain it.',
      link,
      evidence,
    },
  );
}

/**
 * Mirror states carrying an error, or dirty past the same bound.
 *
 * A recorded ERROR is `fail`: the committer tried and could not, so content is
 * not becoming durable and will not without intervention. Dirty-past-the-bound
 * with no error is the same backlog symptom as above, so it is `warn`.
 */
export function checkMirrorState(mirror: MirrorHealth): SystemCheck {
  const link = { label: 'Content health', href: '/admin/health' };
  if (mirror.mirror_errors.count === 0) {
    return check('mirror_state', 'Git mirror errors', 'ok', 'No page reports a mirror error.');
  }
  const errored = mirror.mirror_errors.items.filter((i) => i.error !== null);
  const evidence = mirror.mirror_errors.items
    .slice(0, 5)
    .map((i) => `${i.slug ?? i.page_id}: ${i.error ?? `dirty for ${i.age_seconds}s`}`);
  if (errored.length > 0) {
    return check('mirror_state', 'Git mirror errors', 'fail', `${mirror.mirror_errors.count} page(s) failed to mirror into git.`, {
      action: 'Read the error below, fix the repository (a rejected push, a lock, a full disk), then restart so the outbox replays.',
      link,
      evidence,
    });
  }
  return check(
    'mirror_state',
    'Git mirror errors',
    'warn',
    `${mirror.mirror_errors.count} page(s) have stayed dirty past the commit window.`,
    {
      action: 'Check the git mirror log; a commit is being deferred rather than failing.',
      link,
      evidence,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* 9. Conflicts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Unresolved merge conflicts. `warn`: the instance serves every indexed page,
 * but the named sources have stopped exchanging content until a human chooses.
 */
export async function checkConflicts(db: Kysely<Database>): Promise<SystemCheck> {
  const link = { label: 'Sources', href: '/admin/repos' };
  const rows = await db.selectFrom('sync_conflicts').select('source_id').where('resolved_at', 'is', null).execute();
  if (rows.length === 0) return check('conflicts', 'Merge conflicts', 'ok', 'No source is blocked on a conflict.');
  const sources = [...new Set(rows.map((r) => r.source_id))];
  return check('conflicts', 'Merge conflicts', 'warn', `${rows.length} unresolved conflict(s) across ${sources.length} source(s).`, {
    action: 'Resolve each conflict in Sources — the affected sources do not sync until they are cleared.',
    link,
    evidence: sources.map((s) => `${s}: ${rows.filter((r) => r.source_id === s).length} conflict(s)`),
  });
}

/* -------------------------------------------------------------------------- */
/* 10. Restore drill                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Has this instance's recovery actually been rehearsed?
 *
 * `never` is a `fail`, not an absence. An instance that has never restored its
 * own backup has a hope, not a backup, and issue 71 exists because nothing in
 * the product said so. `failed` is a `fail` for the obvious reason; a `passed`
 * drill older than {@link DRILL_STALE_MS} is a `warn`, because it proves the
 * backup that existed a month ago.
 */
export function checkRestoreDrill(status: BackupDrillStatus, now: Date): SystemCheck {
  const command = 'pnpm --filter @echozedlabs/server drill:restore';
  const scheduled = status.next_run_at ? `Next scheduled run: ${status.next_run_at}` : 'No next run is scheduled.';

  if (status.outcome === 'never') {
    // Still `fail`; only the words are calmer (review §4.9). The summary states
    // the consequence — unverified backups — rather than scolding the instance,
    // and the action no longer repeats it.
    return check('restore_drill', 'Restore drill', 'fail', 'Backups are unverified: the restore drill has never run.', {
      action: `Run \`${command}\` once to rehearse a restore, then schedule it.`,
      evidence: [scheduled],
    });
  }
  if (status.outcome === 'failed') {
    return check('restore_drill', 'Restore drill', 'fail', 'The last restore drill failed.', {
      action: `Read the failure below and re-run \`${command}\`. A backup that does not restore is not a backup.`,
      evidence: [
        status.failure ?? 'The drill reported no reason.',
        ...(status.last_run_at ? [`Last run: ${status.last_run_at}`] : []),
        scheduled,
      ],
    });
  }

  const evidence = [
    ...(status.last_run_at ? [`Last run: ${status.last_run_at}`] : []),
    ...(status.rpo_seconds !== null ? [`Measured RPO: ${status.rpo_seconds}s`] : []),
    ...(status.rto_seconds !== null ? [`Measured RTO: ${status.rto_seconds}s`] : []),
    scheduled,
  ];
  const ranAt = status.last_run_at ? Date.parse(status.last_run_at) : NaN;
  if (Number.isNaN(ranAt)) {
    return check('restore_drill', 'Restore drill', 'warn', 'The last restore drill passed, but did not record when.', {
      action: `Re-run \`${command}\` so the outcome carries a date.`,
      evidence,
    });
  }
  const ageDays = Math.floor((now.getTime() - ranAt) / (24 * 60 * 60 * 1000));
  if (now.getTime() - ranAt > DRILL_STALE_MS) {
    return check('restore_drill', 'Restore drill', 'warn', `The last restore drill passed ${ageDays} days ago.`, {
      action: `Re-run \`${command}\`. A drill proves the backup that existed when it ran.`,
      evidence,
    });
  }
  return check('restore_drill', 'Restore drill', 'ok', `Passed ${ageDays === 0 ? 'today' : `${ageDays} day(s) ago`}.`, { evidence });
}

/* -------------------------------------------------------------------------- */

export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
