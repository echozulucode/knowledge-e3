/**
 * The scheduled restore drill (issue 71).
 *
 * The recovery half of 71 has been done and rehearsed for a while: `backup` and
 * `drill:restore` restore the whole recovery unit into an isolated instance,
 * verify it, boot the real application against the copy and put numbers on RPO
 * and RTO (runbook §3.8). What kept 71 open is that **nothing ran them**, and a
 * drill nobody runs is the same failure as a backup nobody restored.
 *
 * It belongs here rather than in CI, and the two are not substitutes. CI proves
 * the drill CODE works — `tests/restore-drill.e2e.test.ts` builds an instance,
 * drills it, and has five negative controls that must fail. A scheduled run
 * proves **this instance's data** restores: these working trees, this database,
 * these asset bytes, on this disk, at this size. Different claims, and only the
 * second one is the one an operator is asked about after an outage.
 *
 * Precedent followed: `SyncService` schedules per-source cycles with
 * `setInterval` from a config key, and `AuditRetentionService` is a scheduled
 * job that records what it did *into the audit log itself*. This does both.
 *
 * Three properties this job must have that a sync cycle does not:
 *
 *  1. **It is expensive.** The run copies the database, every working tree and
 *     every asset byte to scratch and boots a second application instance
 *     against the copy — potentially gigabytes of I/O. Hence: off by default,
 *     never overlapping itself, a hard time limit, and a quiesce step before it
 *     starts.
 *  2. **It must never take the server down or block a request.** It runs in
 *     child processes (see `drill-runner.ts` for why that is load-bearing and
 *     not a preference), every failure path is caught, and a failed drill is
 *     recorded as a *finding*, never thrown.
 *  3. **Its evidence must outlive it.** The scratch is deleted pass or fail, so
 *     what survives is the persisted status (`app_config`) and an audit row
 *     naming the checks that failed. "When did we last verify we could restore"
 *     is a question an auditor asks, and it must be answerable from the log.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { BackupDrillStatus } from '@echozedlabs/knowledge-types';
import { AuditService } from '../audit/audit.service.js';
import { nowIso } from '../common/ids.js';
import { ConfigService } from '../config/config.service.js';
import { backupDrillSchedule, contentRoot, isTest, loadServerConfig } from '../config/server-config.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';
import { SyncService } from '../sync/sync.service.js';
import { DRILL_RUNNER, type DrillRunResult, type DrillRunner } from './drill-runner.js';

/** The action a drill run writes about itself. Not a content action — no page_id. */
export const BACKUP_DRILL_ACTION = 'backup.drill_run';

/**
 * Where the outcome is persisted.
 *
 * `app_config` is how this codebase already stores operational state that must
 * survive a restart and is not derived from the content: the read-access mode,
 * the password policy, the personal-token policy, the curated sections. It is
 * the right home here for three further reasons. It needs no migration, so the
 * shape can grow with the health page. It is captured by `scripts/backup.ts`
 * (`app_config` is one of its counted tables), so the drill's own verdict
 * travels inside the artifact it is a verdict about. And it lives in the SQLite
 * index — the disposable half of the recovery unit (ADR-0001) — which is
 * exactly right for a *measurement*: losing the record of the last drill costs
 * you the knowledge that you drilled, and the honest consequence of that is
 * `outcome: 'never'`, which is what this returns when the row is gone.
 */
const DRILL_STATUS_KEY = 'backup.drill_status';

/**
 * How long the pre-run quiesce may take before the drill proceeds anyway. A hot
 * capture is not a wasted capture (runbook §4: the files win over the index, so
 * the worst case is a rebuild), so waiting forever for a busy instance to go
 * quiet would trade a real drill for no drill.
 */
const QUIESCE_TIMEOUT_MS = 30_000;

/** The subset of {@link BackupDrillStatus} that is persisted. See {@link nextRunAtIso}. */
interface StoredDrillStatus {
  outcome: 'passed' | 'failed';
  last_run_at: string;
  rpo_seconds: number | null;
  rto_seconds: number | null;
  failure: string | null;
}

/**
 * The honest default. An instance that has never drilled is **unverified**, not
 * healthy-with-no-data, and keeping those two apart is the whole point of
 * issue 71 — so this is what `status()` returns whenever there is no usable
 * record, including when there is a record it cannot read.
 */
function neverDrilled(nextRunAt: string | null): BackupDrillStatus {
  return { outcome: 'never', last_run_at: null, rpo_seconds: null, rto_seconds: null, failure: null, next_run_at: nextRunAt };
}

@Injectable()
export class BackupDrillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('backup-drill');
  private timer: ReturnType<typeof setInterval> | null = null;
  private everyMs = 0;
  private nextRunAt: Date | null = null;
  /** The one in-flight run, if any. Present ⇒ a second run must not start. */
  private running: Promise<BackupDrillStatus> | null = null;
  /** Workspaces this process created, so shutdown can remove one a kill would strand. */
  private readonly workspaces = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly sync: SyncService,
    @Inject(REVISION_MIRROR) private readonly mirror: RevisionMirrorPort,
    @Inject(DRILL_RUNNER) private readonly runner: DrillRunner,
  ) {}

  onApplicationBootstrap(): void {
    // The drill boots the full `AppModule` against the restored copy, from the
    // captured config file — the very file that turned the schedule on. Without
    // this guard a drill would schedule a drill inside itself.
    if (process.env['KNOWLEDGE_E3_DRILL'] === '1') return;
    // Opt-in under test, the same shape `SyncService` uses for its engines: the
    // suite must never start copying a developer's instance because a stray
    // `BACKUP_DRILL_EVERY` was left in their shell.
    if (isTest() && process.env['KNOWLEDGE_E3_BACKUP_DRILL'] !== '1') return;
    this.arm();
  }

  async onModuleDestroy(): Promise<void> {
    this.disarm();
    // Let an in-flight run finish recording its outcome; it is a child process,
    // so it is not holding this process open, and abandoning it would lose the
    // evidence of the very run that was happening during the restart.
    await Promise.allSettled([this.running]);
    for (const dir of this.workspaces) this.discard(dir);
  }

  /**
   * The status the health page reads (issue 71's readiness half consumes this).
   * `next_run_at` is computed from the live timer rather than persisted: a
   * stored "next run" is wrong the moment the process restarts with a different
   * cadence, and wrong in the worst direction — it would claim a schedule an
   * instance with `backup.drill.every: off` does not have.
   */
  async status(): Promise<BackupDrillStatus> {
    const next = this.nextRunAtIso();
    const stored = await this.config.getAppConfig<unknown>(DRILL_STATUS_KEY, null).catch(() => null);
    const parsed = parseStored(stored);
    if (!parsed) return neverDrilled(next);
    return { ...parsed, next_run_at: next };
  }

  /**
   * Run one drill now and record it. Used by the timer and by the tests; there
   * is deliberately no HTTP route to it — `AuditRetentionService` set that
   * precedent, and an unauthenticated (or even an admin) button that starts
   * gigabytes of I/O is a denial-of-service surface, not a feature.
   *
   * Never throws: a drill that fails is a finding, and the finding is the
   * returned status.
   */
  runNow(): Promise<BackupDrillStatus> {
    // Join an in-flight run rather than starting a second one. Same guarantee
    // as the timer's skip, expressed the way a caller awaiting a result needs.
    if (this.running) return this.running;
    const run = this.execute().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  /** True when a schedule is armed. Reported in the log line and asserted by the tests. */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  // ---------------------------------------------------------------- internals

  private arm(): void {
    const { everySeconds, timeoutMs, workDir } = backupDrillSchedule();
    if (everySeconds === null) {
      // Said out loud, once, because silence here reads like "nothing to report"
      // and the truth is the opposite.
      this.logger.log(
        'restore drill: not scheduled (backup.drill.every is off). This instance stays UNVERIFIED until a drill runs — see runbook §3.8.',
      );
      return;
    }
    this.everyMs = everySeconds * 1000;
    this.nextRunAt = new Date(Date.now() + this.everyMs);
    // `setInterval`, not an immediate run: boot is the worst moment to start
    // copying the whole instance, and it is the moment an operator is most
    // likely to be restarting repeatedly. `SyncService` arms its cycles the
    // same way. `unref` so a drill schedule never keeps the process alive.
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref?.();
    this.logger.log(
      `restore drill: every ${everySeconds}s · limit ${Math.round(timeoutMs / 1000)}s · scratch ${workDir ?? tmpdir()} · first run ${this.nextRunAt.toISOString()}`,
    );
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  private async tick(): Promise<void> {
    this.nextRunAt = new Date(Date.now() + this.everyMs);
    if (this.running) {
      // Skipping, not queueing. A run that outlives its own interval means the
      // instance is bigger than the cadence assumed; queueing would turn that
      // into an ever-growing backlog of gigabyte copies.
      this.logger.warn('restore drill: previous run is still going; skipping this tick (consider a longer backup.drill.every)');
      return;
    }
    await this.runNow();
  }

  /** One run, end to end. Every exit path records an outcome and deletes the scratch. */
  private async execute(): Promise<BackupDrillStatus> {
    const { timeoutMs } = backupDrillSchedule();
    const startedAt = Date.now();
    let work: string | null = null;
    try {
      work = this.makeWorkspace();
      await this.quiesce();
      this.logger.log(`restore drill: starting (scratch ${work})`);
      const result = await this.runner.run({
        backupDir: join(work, 'backup'),
        // A sibling of the backup, never inside it: the drill refuses a target
        // that overlaps the artifact it is restoring.
        targetDir: join(work, 'restore'),
        reportPath: join(work, 'report.json'),
        timeoutMs,
      });
      return await this.record(result, startedAt);
    } catch (err) {
      // Anything at all — an unwritable scratch root, a runner that threw, a
      // bug here. A drill is background work: it reports, it does not escalate.
      return await this.record(
        { ok: false, rpoSeconds: null, rtoSeconds: null, failure: message(err), failedChecks: [] },
        startedAt,
      );
    } finally {
      if (work) this.discard(work);
    }
  }

  /**
   * Scratch for one run: `<workDir or OS temp>/e3-drill-<random>/`, holding the
   * backup, the restored copy and the JSON report.
   *
   * Never inside the content root, and never inside the directory holding the
   * live database. Both tools already refuse both — `prepareOutDir` in
   * `backup.ts` and `assertIsolated` in `restore-drill.ts`, which is the guard
   * that stops a drill from ever being able to touch live data and must stay
   * exactly as strict as it is. But they refuse *after* resolving live paths,
   * and what an operator then reads is "restore target … overlaps the backup's
   * database directory", which sounds like a bug in the tool rather than what it
   * is: `backup.drill.workDir` pointed at the data volume. Putting the scratch
   * on the big volume beside `/data/kp.sqlite` is the single most natural thing
   * to configure here, so it gets its own message.
   *
   * The checks are written out rather than imported from
   * `scripts/recovery-unit.ts` because `server/tsconfig.json` sets
   * `rootDir: src` — nothing under `src/` may import from `scripts/`. The DB
   * path is resolved the way `resolveLivePaths` (recovery-unit.ts) and
   * `resolveDbUrl` (db.module.ts) resolve it; if either changes, change this.
   */
  private makeWorkspace(): string {
    const { workDir } = backupDrillSchedule();
    const root = workDir ? (isAbsolute(workDir) ? workDir : resolve(process.cwd(), workDir)) : tmpdir();
    const forbidden: [string, string][] = [[resolve(contentRoot()), 'the content root']];
    const dbUrl = process.env['DB_URL'] ?? loadServerConfig().database.url ?? './data/kp.sqlite';
    // `:memory:` is not a path; there is no directory to stay out of.
    if (dbUrl !== ':memory:') forbidden.push([dirname(resolve(dbUrl)), "the live database's directory"]);
    for (const [path, what] of forbidden) {
      if (!overlaps(root, path)) continue;
      throw new Error(
        `backup.drill.workDir ${root} overlaps ${what} (${path}). The drill's scratch is a second copy of this instance, ` +
          'and the drill refuses to restore anywhere that could touch live data; put the scratch on a path outside both.',
      );
    }
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'e3-drill-'));
    this.workspaces.add(dir);
    return dir;
  }

  /** Remove one workspace, pass or fail. Never throws — a leaked temp dir is not worth an outage. */
  private discard(dir: string): void {
    this.workspaces.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Worth saying: on Windows a handle the restored instance has not released
      // yet can hold a file, and the operator needs to know what to sweep up.
      this.logger.warn(`restore drill: could not remove scratch ${dir}: ${message(err)}`);
    }
  }

  /**
   * Let the writers finish before the copy starts.
   *
   * The drill's structural checks compare each restored tree's HEAD, tracked
   * file count and `git status --porcelain` against what the manifest recorded
   * at capture. A sync cycle or a debounced commit landing *between* those two
   * observations produces a mismatch that looks exactly like a corrupt backup —
   * a false failure, which is the most expensive kind of finding because it
   * costs an operator a night proving the backup is fine.
   *
   * Both steps are cheap, public and bounded:
   *  - `SyncService.settle()` waits on any in-flight fetch/merge/index cycle. It
   *    does not stop the *next* one — there is no pause API and inventing one
   *    would be a new failure mode (a pause nobody lifts) for a narrow window.
   *  - `RevisionMirrorPort.flush()` commits whatever the debounced committer is
   *    still holding, which both closes the window and makes the artifact more
   *    complete. It can also push, for a source no sync engine manages — the
   *    same push a publish triggers, so not a new class of event, but it *is* a
   *    side effect of running a drill and is documented as one in runbook §3.8.
   *
   * Failures here are logged and ignored. A quiesce that did not work is a
   * reason the drill might report a dirty tree, not a reason to skip the drill.
   */
  private async quiesce(): Promise<void> {
    await bounded(this.sync.settle(), QUIESCE_TIMEOUT_MS).catch((err) =>
      this.logger.warn(`restore drill: sync did not settle before the capture: ${message(err)}`),
    );
    await bounded(this.mirror.flush?.() ?? Promise.resolve(), QUIESCE_TIMEOUT_MS).catch((err) =>
      this.logger.warn(`restore drill: the git mirror did not flush before the capture: ${message(err)}`),
    );
  }

  /**
   * Persist the outcome, write the audit row, log it. In that order, and each
   * step independently guarded: a drill that ran must not lose its verdict
   * because the log write failed, and vice versa.
   */
  private async record(result: DrillRunResult, startedAtMs: number): Promise<BackupDrillStatus> {
    const stored: StoredDrillStatus = {
      outcome: result.ok ? 'passed' : 'failed',
      last_run_at: nowIso(),
      rpo_seconds: result.rpoSeconds,
      rto_seconds: result.rtoSeconds,
      failure: result.ok ? null : result.failure ?? 'the drill failed without saying why',
    };
    await this.config
      .setAppConfig(DRILL_STATUS_KEY, stored, null)
      .catch((err) => this.logger.error(`restore drill: could not persist the outcome: ${message(err)}`));

    // The audit row is the durable evidence. The scratch is gone by the time an
    // operator reads this, so the failed checks travel in the payload — that is
    // the trade for not leaving gigabytes on disk after every failed run.
    await this.audit
      .record({
        actor_id: null,
        action: BACKUP_DRILL_ACTION,
        payload: {
          outcome: stored.outcome,
          rpo_seconds: stored.rpo_seconds,
          rto_seconds: stored.rto_seconds,
          duration_seconds: Math.round((Date.now() - startedAtMs) / 100) / 10,
          failure: stored.failure,
          ...(result.failedChecks.length ? { failed_checks: result.failedChecks } : {}),
        },
      })
      .catch((err) => this.logger.error(`restore drill: could not write the audit row: ${message(err)}`));

    if (stored.outcome === 'passed') {
      this.logger.log(`restore drill PASSED — RPO ${stored.rpo_seconds ?? '?'}s, RTO ${stored.rto_seconds ?? '?'}s`);
    } else {
      // `warn`, not `error`: a failed drill is a finding about the backup, and
      // the server it is running on is perfectly healthy.
      this.logger.warn(`restore drill FAILED — ${stored.failure}`);
    }
    return { ...stored, next_run_at: this.nextRunAtIso() };
  }

  private nextRunAtIso(): string | null {
    return this.timer && this.nextRunAt ? this.nextRunAt.toISOString() : null;
  }
}

/** True when either path is the other or sits underneath it. Case-insensitive on Windows. */
function overlaps(a: string, b: string): boolean {
  const [x, y] = process.platform === 'win32' ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  const inside = (child: string, parent: string): boolean => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return inside(x, y) || inside(y, x);
}

/**
 * A stored row read back defensively. Anything unrecognisable — an older shape,
 * a hand-edited row, a truncated write — becomes "never drilled" rather than a
 * partially-trusted status, because the only claim this value ever makes is
 * "restoring this instance was verified", and a half-read row cannot make it.
 */
function parseStored(value: unknown): StoredDrillStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['outcome'] !== 'passed' && v['outcome'] !== 'failed') return null;
  if (typeof v['last_run_at'] !== 'string' || v['last_run_at'] === '') return null;
  return {
    outcome: v['outcome'],
    last_run_at: v['last_run_at'],
    rpo_seconds: typeof v['rpo_seconds'] === 'number' ? v['rpo_seconds'] : null,
    rto_seconds: typeof v['rto_seconds'] === 'number' ? v['rto_seconds'] : null,
    failure: typeof v['failure'] === 'string' ? v['failure'] : null,
  };
}

/** Resolve with `p`, or reject once `ms` has passed. The timer never holds the process open. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      (e) => {
        clearTimeout(timer);
        rej(e);
      },
    );
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
