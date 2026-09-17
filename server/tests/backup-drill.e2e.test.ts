/**
 * The scheduled restore drill (issue 71), drilled.
 *
 * `restore-drill.e2e.test.ts` proves the drill CODE works — it builds a real
 * instance, backs it up, restores it, and has five negative controls that must
 * fail. This file proves the SCHEDULER works: that it arms only when an
 * operator asked for it, never overlaps itself, records a failure as a finding
 * instead of throwing, keeps the evidence across a restart, and leaves no
 * scratch behind on either path.
 *
 * It substitutes the drill runner, deliberately. The alternative — a scheduler
 * test that actually copies an instance — would be slow enough that nobody runs
 * it, which is the failure this whole issue is about. The real runner's command
 * is asserted separately, as a pure function.
 *
 * Discipline inherited from `restore-drill.e2e.test.ts`, and non-negotiable:
 * **nothing here touches the developer's live data.** Every database is
 * in-memory or under the OS temp directory, every scratch root is a `mkdtemp`,
 * and `afterAll` proves the suite cleaned up after itself. A test that writes
 * into `server/data/` or `./data/wiki` has failed no matter what it asserts.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { resetServerConfig } from '../src/config/server-config.js';
import { BackupDrillService, BACKUP_DRILL_ACTION } from '../src/backup/backup-drill.service.js';
import {
  DRILL_RUNNER,
  drillChildEnv,
  drillCommands,
  type DrillRunRequest,
  type DrillRunResult,
  type DrillRunner,
} from '../src/backup/drill-runner.js';

/** Poll until `ready`, so a concurrency assertion never races the event loop. */
async function until(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!ready()) throw new Error('condition never became true');
}

/** Every path this suite owns, so `afterAll` can prove it cleaned up after itself. */
const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * A runner that spawns nothing. It records what it was asked to do — including
 * whether the scratch directory existed *while it ran*, which is how the
 * cleanup assertions tell "removed afterwards" apart from "never created".
 */
class FakeRunner implements DrillRunner {
  calls: DrillRunRequest[] = [];
  /** Workspace state observed from inside the run. */
  sawWorkspace: boolean[] = [];
  result: DrillRunResult = { ok: true, rpoSeconds: 8.2, rtoSeconds: 2.2, failure: null, failedChecks: [] };
  throws: Error | null = null;
  /** When set, the run parks here until it is resolved — for the overlap test. */
  gate: { promise: Promise<void>; open: () => void } | null = null;

  async run(req: DrillRunRequest): Promise<DrillRunResult> {
    this.calls.push(req);
    this.sawWorkspace.push(existsSync(join(req.backupDir, '..')));
    if (this.gate) await this.gate.promise;
    if (this.throws) throw this.throws;
    return this.result;
  }

  static gate(): { promise: Promise<void>; open: () => void } {
    let open = (): void => undefined;
    const promise = new Promise<void>((res) => {
      open = res;
    });
    return { promise, open };
  }
}

interface Harness {
  app: INestApplication;
  drill: BackupDrillService;
  db: Kysely<Database>;
  runner: FakeRunner;
}

/**
 * A fresh app with the fake runner wired in. `dbUrl` defaults to `:memory:`;
 * the restart test passes a file under the OS temp dir so a second app can read
 * what the first one wrote.
 */
async function makeDrillApp(opts: { dbUrl?: string; runner?: FakeRunner } = {}): Promise<Harness> {
  process.env['DB_URL'] = opts.dbUrl ?? ':memory:';
  const runner = opts.runner ?? new FakeRunner();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRILL_RUNNER)
    .useValue(runner)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, drill: app.get(BackupDrillService), db: app.get<Kysely<Database>>(KYSELY), runner };
}

/**
 * Close an app AND its database. The DB handle matters on Windows: a file-backed
 * SQLite connection left open holds the file, and `afterAll` then cannot remove
 * the temp directory it lives in — a suite that cannot clean up after itself is
 * exactly what this file is asserting about the scheduler.
 */
async function closeHarness(h: Harness): Promise<void> {
  await h.app.close();
  await h.db.destroy().catch(() => undefined);
}

async function auditRows(db: Kysely<Database>): Promise<{ actor_id: string | null; payload: Record<string, unknown> }[]> {
  const rows = await db.selectFrom('audit_log').selectAll().where('action', '=', BACKUP_DRILL_ACTION).execute();
  return rows.map((r) => ({ actor_id: r.actor_id, payload: JSON.parse(r.payload_json ?? '{}') as Record<string, unknown> }));
}

/** Every env key this suite touches, cleared between cases so one cannot leak into the next. */
const ENV_KEYS = ['BACKUP_DRILL_EVERY', 'BACKUP_DRILL_WORK_DIR', 'BACKUP_DRILL_TIMEOUT', 'KNOWLEDGE_E3_BACKUP_DRILL', 'KNOWLEDGE_E3_DRILL'] as const;

describe('scheduled restore drill', () => {
  let h: Harness | null = null;
  let scratch: string;

  beforeEach(() => {
    scratch = temp('e3-drill-scratch-');
    // The scheduler's scratch root. Never the content root, never ./data.
    process.env['BACKUP_DRILL_WORK_DIR'] = scratch;
    // The suite-level opt-in, mirroring KNOWLEDGE_E3_SYNC: without it the
    // scheduler stays off under test whatever the cadence says, so a stray
    // BACKUP_DRILL_EVERY in a developer's shell can never start copying their
    // instance during a test run.
    process.env['KNOWLEDGE_E3_BACKUP_DRILL'] = '1';
    resetServerConfig();
  });

  afterEach(async () => {
    if (h) await closeHarness(h);
    h = null;
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
  });

  afterAll(() => {
    for (const dir of temps) {
      // Never fatal: on Windows a handle released a moment ago can still hold a
      // file, and a temp directory that outlives the suite is untidy, not unsafe.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* leave it to the OS */
      }
    }
  });

  // ------------------------------------------------------------------ arming

  it("reports 'never' and no schedule on an instance that has never drilled", async () => {
    // No BACKUP_DRILL_EVERY: the default, and the default is OFF.
    h = await makeDrillApp();
    expect(h.drill.scheduled).toBe(false);
    expect(await h.drill.status()).toEqual({
      // Unverified, not healthy-with-no-data. This distinction is issue 71.
      outcome: 'never',
      last_run_at: null,
      rpo_seconds: null,
      rto_seconds: null,
      failure: null,
      next_run_at: null,
    });
    expect(h.runner.calls).toHaveLength(0);
  });

  it('arms from the cadence and publishes when the next run is due', async () => {
    process.env['BACKUP_DRILL_EVERY'] = '1h';
    resetServerConfig();
    h = await makeDrillApp();

    expect(h.drill.scheduled).toBe(true);
    const status = await h.drill.status();
    expect(status.outcome).toBe('never');
    const next = Date.parse(status.next_run_at!);
    // An hour away, give or take the time the app took to boot.
    expect(next - Date.now()).toBeGreaterThan(3_500_000);
    expect(next - Date.now()).toBeLessThanOrEqual(3_600_000);
    // Deliberately NOT run at boot: booting is the worst moment to start
    // copying the whole instance, and the moment an operator restarts most.
    expect(h.runner.calls).toHaveLength(0);
  });

  it('the armed timer actually fires a run', async () => {
    process.env['BACKUP_DRILL_EVERY'] = '1';
    resetServerConfig();
    h = await makeDrillApp();
    expect(h.drill.scheduled).toBe(true);

    await until(() => h!.runner.calls.length > 0);
    // At least one: the cadence here is the shortest the parser can express, so
    // a second tick can legitimately land while a loaded machine is still
    // getting back to this line. What is being proved is that the timer fires
    // at all — the no-overlap guarantee has its own test.
    expect(h.runner.calls.length).toBeGreaterThanOrEqual(1);
    expect((await h.drill.status()).outcome).toBe('passed');
  });

  it('does not arm inside a drill of itself', async () => {
    // The drill boots the full AppModule against the restored copy, from the
    // captured config file — the file that turned the schedule on. Without this
    // guard a drill would schedule a drill inside itself.
    process.env['BACKUP_DRILL_EVERY'] = '1h';
    process.env['KNOWLEDGE_E3_DRILL'] = '1';
    resetServerConfig();
    h = await makeDrillApp();
    expect(h.drill.scheduled).toBe(false);
    expect((await h.drill.status()).next_run_at).toBeNull();
  });

  it('refuses a cadence it cannot parse rather than silently not scheduling', async () => {
    // The silent-fallback failure mode here IS issue 71: no drill at all, and a
    // health page that says so only if you read it closely.
    process.env['BACKUP_DRILL_EVERY'] = 'weekly';
    resetServerConfig();
    await expect(makeDrillApp()).rejects.toThrow(/BACKUP_DRILL_EVERY/);
  });

  it('`off` is a schedule an operator can choose, and reads as no schedule', async () => {
    process.env['BACKUP_DRILL_EVERY'] = 'off';
    resetServerConfig();
    h = await makeDrillApp();
    expect(h.drill.scheduled).toBe(false);
    expect((await h.drill.status()).next_run_at).toBeNull();
  });

  // ----------------------------------------------------------------- overlap

  it('never overlaps a run with itself', async () => {
    const runner = new FakeRunner();
    runner.gate = FakeRunner.gate();
    h = await makeDrillApp({ runner });

    const first = h.drill.runNow();
    // Wait until the first run is parked inside the runner, so the callers
    // below really are concurrent with it rather than merely queued behind it.
    await until(() => runner.calls.length === 1);
    // Three more callers while the first is still inside the runner.
    const others = [h.drill.runNow(), h.drill.runNow(), h.drill.runNow()];
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.calls).toHaveLength(1);

    runner.gate.open();
    const results = await Promise.all([first, ...others]);
    // One copy of the instance, one verdict, handed to every caller.
    expect(runner.calls).toHaveLength(1);
    for (const r of results) expect(r.outcome).toBe('passed');

    // And the lock is released: the next run is a real second run.
    runner.gate = null;
    await h.drill.runNow();
    expect(runner.calls).toHaveLength(2);
  });

  // ----------------------------------------------------------------- failure

  it('records a failed drill with its reason and does not throw', async () => {
    const runner = new FakeRunner();
    runner.result = {
      ok: false,
      rpoSeconds: 9.1,
      rtoSeconds: null,
      failure: 'asset bytes present for every descriptor: 1 descriptor has no bytes',
      failedChecks: [{ id: 'assets.bytes', title: 'asset bytes present', detail: '1 descriptor has no bytes' }],
    };
    h = await makeDrillApp({ runner });

    // A finding, not an exception: background work must never escalate.
    const status = await h.drill.runNow();
    expect(status.outcome).toBe('failed');
    expect(status.failure).toMatch(/no bytes/);
    expect(status.rpo_seconds).toBe(9.1);
    expect(await h.drill.status()).toMatchObject({ outcome: 'failed', failure: status.failure });
  });

  it('records a runner that throws as a failed drill, not as a crash', async () => {
    const runner = new FakeRunner();
    runner.throws = new Error('scratch volume is full');
    h = await makeDrillApp({ runner });

    const status = await h.drill.runNow();
    expect(status).toMatchObject({ outcome: 'failed', failure: 'scratch volume is full' });
  });

  it('refuses a scratch root inside the content root, and says why', async () => {
    // The scratch is a second copy of the instance; putting it inside the
    // content root would make the backup contain a copy of itself.
    const { contentRoot } = await import('../src/config/server-config.js');
    process.env['BACKUP_DRILL_WORK_DIR'] = join(contentRoot(), 'drill-scratch');
    resetServerConfig();
    h = await makeDrillApp();

    const status = await h.drill.runNow();
    expect(status.outcome).toBe('failed');
    expect(status.failure).toMatch(/overlaps the content root/);
    expect(h.runner.calls).toHaveLength(0);
    expect(existsSync(join(contentRoot(), 'drill-scratch'))).toBe(false);
  });

  // ------------------------------------------------------------------- audit

  it('leaves an audit row whether it passed or failed', async () => {
    const runner = new FakeRunner();
    h = await makeDrillApp({ runner });

    await h.drill.runNow();
    runner.result = {
      ok: false,
      rpoSeconds: null,
      rtoSeconds: null,
      failure: 'integrity_check: malformed database',
      failedChecks: [{ id: 'db.integrity', title: 'PRAGMA integrity_check', detail: 'malformed database' }],
    };
    await h.drill.runNow();

    const rows = await auditRows(h.db);
    expect(rows).toHaveLength(2);
    // System-authored, like `audit.retention_trim`.
    expect(rows.every((r) => r.actor_id === null)).toBe(true);
    expect(rows[0]!.payload).toMatchObject({ outcome: 'passed', rpo_seconds: 8.2, rto_seconds: 2.2, failure: null });
    expect(rows[1]!.payload).toMatchObject({ outcome: 'failed', failure: 'integrity_check: malformed database' });
    // The scratch is deleted, so the failed checks have to survive in the row —
    // that is the trade for not leaving gigabytes on disk after every failure.
    expect(rows[1]!.payload['failed_checks']).toEqual([
      { id: 'db.integrity', title: 'PRAGMA integrity_check', detail: 'malformed database' },
    ]);
  });

  // ----------------------------------------------------------------- cleanup

  it('deletes its scratch on the passing path and on the failing one', async () => {
    const runner = new FakeRunner();
    h = await makeDrillApp({ runner });

    await h.drill.runNow();
    runner.result = { ok: false, rpoSeconds: null, rtoSeconds: null, failure: 'boom', failedChecks: [] };
    await h.drill.runNow();
    runner.throws = new Error('boom harder');
    await h.drill.runNow();

    expect(runner.calls).toHaveLength(3);
    // The workspace existed while each run was inside the runner …
    expect(runner.sawWorkspace).toEqual([true, true, true]);
    // … and none of them is left behind, on any of the three paths.
    for (const call of runner.calls) {
      expect(existsSync(call.backupDir)).toBe(false);
      expect(existsSync(call.targetDir)).toBe(false);
    }
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('restores the backup and the restored copy into separate, non-overlapping directories', async () => {
    h = await makeDrillApp();
    await h.drill.runNow();
    const call = h.runner.calls[0]!;
    // The drill refuses a target that overlaps the artifact it is restoring, so
    // these must be siblings — never one inside the other.
    expect(call.targetDir.startsWith(call.backupDir)).toBe(false);
    expect(call.backupDir.startsWith(call.targetDir)).toBe(false);
    expect(call.reportPath.endsWith('report.json')).toBe(true);
  });

  // --------------------------------------------------------------- restart

  it('keeps the verdict across a restart, and does not invent a schedule for it', async () => {
    const dataDir = temp('e3-drill-db-');
    const dbUrl = join(dataDir, 'kp.sqlite');
    process.env['BACKUP_DRILL_EVERY'] = '1h';
    resetServerConfig();

    const first = await makeDrillApp({ dbUrl });
    const before = await first.drill.runNow();
    expect(before.outcome).toBe('passed');
    await closeHarness(first);

    // Restart with NO schedule: the evidence must survive, and `next_run_at`
    // must not — a persisted "next run" would claim a schedule this instance
    // does not have.
    delete process.env['BACKUP_DRILL_EVERY'];
    resetServerConfig();
    h = await makeDrillApp({ dbUrl });

    expect(h.drill.scheduled).toBe(false);
    expect(await h.drill.status()).toEqual({
      outcome: 'passed',
      last_run_at: before.last_run_at,
      rpo_seconds: 8.2,
      rto_seconds: 2.2,
      failure: null,
      next_run_at: null,
    });
    // And the run it did not perform is not in this instance's log twice.
    expect(await auditRows(h.db)).toHaveLength(1);
  });

  it("falls back to 'never' when the stored verdict cannot be read", async () => {
    const dataDir = temp('e3-drill-db-');
    const dbUrl = join(dataDir, 'kp.sqlite');
    h = await makeDrillApp({ dbUrl });
    await h.drill.runNow();
    // A row from an older shape, a hand edit, a truncated write. The only claim
    // this value ever makes is "restoring this instance was verified", and a
    // half-read row cannot make it.
    await h.db
      .updateTable('app_config')
      .set({ value_json: JSON.stringify({ outcome: 'probably fine' }) })
      .where('key', '=', 'backup.drill_status')
      .execute();

    expect((await h.drill.status()).outcome).toBe('never');
  });
});

/**
 * The real runner, asserted as a pure function. Nothing here spawns a process —
 * but a scheduler that builds the wrong command line would pass every test
 * above and never drill anything in production.
 */
describe('the command the scheduler runs', () => {
  const req: DrillRunRequest = {
    backupDir: join(tmpdir(), 'e3-drill-x', 'backup'),
    targetDir: join(tmpdir(), 'e3-drill-x', 'restore'),
    reportPath: join(tmpdir(), 'e3-drill-x', 'report.json'),
    timeoutMs: 60_000,
  };

  it('is the two documented commands, in the documented order', () => {
    const [backup, drill] = drillCommands(req);
    expect(backup!.label).toBe('backup');
    expect(drill!.label).toBe('drill');

    // `scripts/*.ts` are not compiled into dist (the server tsconfig includes
    // src only), so both go through the same swc loader `package.json`'s
    // `backup` / `drill:restore` scripts use — resolved to an absolute path,
    // because a bare specifier would be resolved from the child's cwd.
    for (const cmd of [backup!, drill!]) {
      expect(cmd.argv[0]).toBe('--import');
      // A `file://` URL, not a path: `--import` rejects a bare Windows absolute
      // path, and this product is developed on Windows and shipped on Alpine.
      expect(cmd.argv[1]).toMatch(/^file:\/\/.*esm-register/);
      expect(existsSync(fileURLToPath(cmd.argv[1]!))).toBe(true);
      expect(existsSync(cmd.argv[2]!)).toBe(true);
    }
    expect(backup!.argv[2]).toMatch(/backup\.ts$/);
    expect(backup!.argv.slice(3)).toEqual(['--out', req.backupDir]);

    expect(drill!.argv[2]).toMatch(/restore-drill\.ts$/);
    // `--from` is what makes the backup ours to delete: with no `--from` the
    // drill mkdtemps its own backup that nothing ever removes.
    expect(drill!.argv.slice(3)).toEqual([
      '--from',
      req.backupDir,
      '--target',
      req.targetDir,
      '--json',
      req.reportPath,
    ]);
    // Never `--keep`: a scheduled job that keeps a full restored copy on every
    // failure fills the disk, and it will fail repeatedly.
    expect(drill!.argv).not.toContain('--keep');
  });

  it('runs with the tsconfig the loader needs and the markers the drill needs', () => {
    const env = drillChildEnv();
    // The loader looks for tsconfig.json at the child's cwd, which is the
    // SERVER's cwd (repo root in dev, /app in the container) — neither has one.
    // Naming it is what lets the child keep that cwd, and keeping it is what
    // makes the child resolve DB_URL / CONTENT_ROOT / the config file exactly as
    // the running server did.
    expect(env['SWC_NODE_PROJECT']).toBe(join(import.meta.dirname, '..', 'tsconfig.json'));
    expect(existsSync(env['SWC_NODE_PROJECT']!)).toBe(true);
    // Stops a drill from scheduling a drill inside itself …
    expect(env['KNOWLEDGE_E3_DRILL']).toBe('1');
    // … and stops the restored copy from fetching or pushing.
    expect(env['KNOWLEDGE_E3_SYNC']).toBeUndefined();
  });
});
