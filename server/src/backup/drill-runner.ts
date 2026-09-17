/**
 * How the scheduler actually runs a restore drill: as **child processes**, not
 * in this one.
 *
 * That is not a style preference, it is a correctness requirement, and it is the
 * single most important decision in this directory. `scripts/restore-drill.ts`
 * boots the real application against the restored copy, and the only way it can
 * point that instance at restored paths is by writing `DB_URL`, `CONTENT_ROOT`,
 * `GIT_MIRROR_ROOT`, `KNOWLEDGE_E3_ASSETS_DIR` and `KNOWLEDGE_E3_CONFIG` into
 * `process.env` and calling `resetServerConfig()` (see `bootRestored` there). It
 * carefully puts all of that back afterwards — which is enough for a CLI and for
 * the test suite, and is *not* enough for a live server: for the seconds the
 * restored instance is up, every request in this process that asks where the
 * content root is would be told the drill's scratch directory. A scheduled job
 * that can answer a reader with another instance's files is worse than no
 * scheduled job. So the drill runs in its own process, with its own environment,
 * and this process only ever reads the JSON report it leaves behind.
 *
 * Two child processes, in the order runbook §3.8 documents for a human:
 *
 *   1. `scripts/backup.ts --out <work>/backup`
 *   2. `scripts/restore-drill.ts --from <work>/backup --target <work>/restore --json …`
 *
 * rather than one `restore-drill.ts` with no `--from`. With no `--from` the
 * drill takes its own backup into a fresh `mkdtemp` directory that **nothing
 * ever deletes** — fine for a human who runs it twice a year, a disk leak for a
 * job that runs every night. Capturing the backup ourselves is what lets the
 * caller delete the whole workspace afterwards, pass or fail. It also separates
 * "the backup could not be taken" from "the backup could not be restored", which
 * are different findings with different first actions.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';

/** DI token, so a test can substitute a runner that never spawns anything. */
export const DRILL_RUNNER = Symbol('DRILL_RUNNER');

export interface DrillRunRequest {
  /** Empty directory the backup is captured into. */
  backupDir: string;
  /** Where the isolated instance is restored. A sibling of `backupDir`, never inside it. */
  targetDir: string;
  /** Where the drill writes its JSON report. */
  reportPath: string;
  /** Hard cap on the whole run; the children are killed past it. */
  timeoutMs: number;
}

/** One failed check, kept for the audit row — the evidence that outlives the scratch. */
export interface DrillFailedCheck {
  id: string;
  title: string;
  detail: string;
}

export interface DrillRunResult {
  ok: boolean;
  /** Measured RPO/RTO from the report; null when the run never produced one. */
  rpoSeconds: number | null;
  rtoSeconds: number | null;
  /** One line naming what went wrong. Null only when `ok`. */
  failure: string | null;
  failedChecks: DrillFailedCheck[];
}

export interface DrillRunner {
  run(req: DrillRunRequest): Promise<DrillRunResult>;
}

/**
 * The shape this module reads out of the drill's `--json` report.
 *
 * Deliberately re-declared rather than imported from
 * `server/scripts/restore-drill.ts`: `server/tsconfig.json` has
 * `rootDir: src`, so anything under `src/` that imports from `scripts/` breaks
 * the build. The coupling is therefore a contract in comments, and it is a thin
 * one — four fields out of a report the operator reads in full. Every field is
 * treated as possibly absent, because a report written by an older or newer
 * drill must degrade to "could not read the outcome", never to a false pass.
 */
interface DrillReportJson {
  ok?: unknown;
  rpo?: { seconds?: unknown };
  rto?: { seconds?: unknown };
  checks?: { id?: unknown; title?: unknown; status?: unknown; detail?: unknown }[];
}

/** `server/`, from either `src/backup/` (dev, ts) or `dist/backup/` (built). */
function serverRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..');
}

const LOADER_SPECIFIER = '@swc-node/register/esm-register';

/**
 * A `file://` URL for the swc ESM loader — a URL, not a path, because `--import`
 * rejects a bare Windows absolute path (`Only URLs with a scheme in: file, data,
 * and node ... Received protocol 'c:'`) and this product is developed on Windows
 * and shipped on Alpine. Resolved three ways, because none of them works
 * everywhere:
 *
 *  1. `import.meta.resolve` — correct, honours the package's `exports` map, and
 *     absent under the vitest transform, which rewrites `import.meta`.
 *  2. The package's own entry point, resolved as CJS, then the loader file
 *     beside it. `exports` forbids the subpath to `require.resolve` but not the
 *     main entry, and the built loader has sat at `esm/esm-register.mjs` (with
 *     `lib/` as the older layout) for the life of this dependency.
 *  3. The bare specifier, which Node resolves from the child's cwd. That is the
 *     same thing `package.json`'s `backup` / `drill:restore` scripts rely on, so
 *     it is a real fallback rather than a guess — it is just cwd-dependent,
 *     which is why it is last.
 */
function drillLoader(): string {
  const metaResolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof metaResolve === 'function') {
    try {
      // Already a URL; that is exactly the form `--import` wants.
      return metaResolve(LOADER_SPECIFIER);
    } catch {
      /* fall through */
    }
  }
  try {
    const pkgDir = dirname(createRequire(import.meta.url).resolve('@swc-node/register'));
    for (const rel of ['esm/esm-register.mjs', 'lib/esm-register.mjs']) {
      const candidate = join(pkgDir, rel);
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
  } catch {
    /* fall through */
  }
  return LOADER_SPECIFIER;
}

/**
 * The exact argv of both children, as a pure function so a test can assert the
 * command without running gigabytes of I/O.
 *
 * `scripts/*.ts` are TypeScript and are **not** compiled into `dist` (the
 * server's tsconfig has `include: ["src/**"]`), so both invocations go through
 * the same `@swc-node/register` loader `package.json`'s `backup` and
 * `drill:restore` scripts use. {@link drillLoader} resolves it to an absolute
 * `file://` URL rather than passing a bare specifier, because a bare specifier
 * is resolved from the child's cwd — and the cwd here is the SERVER's cwd,
 * deliberately: that is what makes the child find the same
 * `knowledge-e3.config.yaml` the running server found, so the backup can never
 * disagree with the live instance about where its data is.
 */
export function drillCommands(req: DrillRunRequest): { label: string; argv: string[] }[] {
  const loader = drillLoader();
  const scripts = join(serverRoot(), 'scripts');
  return [
    {
      label: 'backup',
      argv: [
        '--import',
        loader,
        join(scripts, 'backup.ts'),
        '--out',
        req.backupDir,
      ],
    },
    {
      label: 'drill',
      argv: [
        '--import',
        loader,
        join(scripts, 'restore-drill.ts'),
        '--from',
        req.backupDir,
        '--target',
        req.targetDir,
        '--json',
        req.reportPath,
      ],
    },
  ];
}

/**
 * Environment for the children. Three entries matter beyond inheritance:
 *
 *  - `KNOWLEDGE_E3_DRILL=1` — the restored instance the drill boots is the full
 *    `AppModule`, scheduler included, and it is booted from the captured config
 *    file, which is the very file that turned the schedule on. Without this
 *    marker a drill would arm a drill inside itself. `BackupDrillService` refuses
 *    to arm when it sees it.
 *  - `SWC_NODE_PROJECT` — the loader looks for `tsconfig.json` at the child's
 *    **cwd**, and the child's cwd is the server's, which is the repository root
 *    in dev and `/app` in the container. Neither has one; `server/` does. The
 *    `pnpm --filter` invocations an operator types never hit this because pnpm
 *    runs them with cwd `server/`. Naming the tsconfig explicitly is what lets
 *    the child keep the server's cwd — and keeping it is the point, because
 *    `DB_URL`, `CONTENT_ROOT` and the config-file search are all resolved
 *    relative to cwd, and a backup tool that disagrees with the running app
 *    about where its data is has no value at all.
 *  - `KNOWLEDGE_E3_SYNC` is dropped, for the same reason the drill drops it: a
 *    restored copy that fetches and pushes is not a rehearsal.
 */
export function drillChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KNOWLEDGE_E3_DRILL: '1',
    SWC_NODE_PROJECT: join(serverRoot(), 'tsconfig.json'),
  };
  delete env['KNOWLEDGE_E3_SYNC'];
  return env;
}

@Injectable()
export class ChildProcessDrillRunner implements DrillRunner {
  private readonly logger = new Logger('backup-drill');

  async run(req: DrillRunRequest): Promise<DrillRunResult> {
    let commands: { label: string; argv: string[] }[];
    try {
      commands = drillCommands(req);
    } catch (err) {
      // The loader or the scripts are not where this build expects them. That is
      // a finding about the deployment, not a crash: report it like any other
      // failed drill so it lands on the health page instead of in a stack trace.
      return failed(`the drill could not be launched: ${message(err)}`);
    }

    const deadline = Date.now() + req.timeoutMs;
    for (const { label, argv } of commands) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.reportOr(req, `the drill exceeded its ${Math.round(req.timeoutMs / 1000)}s time limit`);
      const exit = await this.spawnChild(label, argv, remaining);
      if (exit.timedOut) {
        return this.reportOr(req, `the ${label} step exceeded the ${Math.round(req.timeoutMs / 1000)}s time limit and was killed`);
      }
      if (exit.code !== 0) {
        // The drill writes its report *and* exits non-zero when a check fails,
        // so the report is the better answer whenever there is one; the tail of
        // the child's output is the fallback for a crash before it got that far.
        return this.reportOr(req, `${label} exited ${exit.code ?? 'on a signal'}${exit.tail ? `: ${exit.tail}` : ''}`);
      }
    }
    return this.reportOr(req, 'the drill produced no report');
  }

  /**
   * Read the JSON report if it exists, else fail with `fallback`. A report that
   * says `ok: false` wins over the fallback message, because it names the
   * specific check that failed rather than an exit code.
   */
  private reportOr(req: DrillRunRequest, fallback: string): DrillRunResult {
    const report = readReport(req.reportPath);
    if (!report) return failed(fallback);
    const failedChecks = (Array.isArray(report.checks) ? report.checks : [])
      .filter((c) => c?.status === 'fail')
      .map((c) => ({ id: String(c.id ?? '?'), title: String(c.title ?? ''), detail: String(c.detail ?? '') }));
    const ok = report.ok === true && failedChecks.length === 0;
    return {
      ok,
      rpoSeconds: finite(report.rpo?.seconds),
      rtoSeconds: finite(report.rto?.seconds),
      failure: ok ? null : failedChecks.length ? summarize(failedChecks) : fallback,
      failedChecks,
    };
  }

  private spawnChild(
    label: string,
    argv: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, argv, {
        // The server's own cwd, so the child resolves the same config file.
        cwd: process.cwd(),
        env: drillChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Only the tail is kept. The drill is chatty by design (an operator reads
      // its whole transcript), and buffering all of it in the server process to
      // quote one line back would be a memory cost for no benefit.
      const tail: string[] = [];
      const keep = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) tail.push(line.trim());
        }
        while (tail.length > 20) tail.shift();
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A drill that ignores the polite signal is holding a booted app and a
        // scratch copy; give it a moment, then stop it for real.
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
      }, timeoutMs);
      timer.unref?.();

      const done = (code: number | null): void => {
        clearTimeout(timer);
        resolveRun({ code, timedOut, tail: tail[tail.length - 1] ?? '' });
      };
      child.on('error', (err) => {
        tail.push(message(err));
        done(null);
      });
      child.on('close', (code) => done(code));
      this.logger.debug?.(`[${label}] ${argv.join(' ')}`);
    });
  }
}

function readReport(path: string): DrillReportJson | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DrillReportJson;
  } catch {
    return null;
  }
}

/** One line an operator can act on, from however many checks failed. */
function summarize(checks: DrillFailedCheck[]): string {
  const first = checks[0]!;
  const rest = checks.length > 1 ? ` (+${checks.length - 1} more)` : '';
  return `${first.title || first.id}${first.detail ? `: ${first.detail}` : ''}${rest}`;
}

function failed(failure: string): DrillRunResult {
  return { ok: false, rpoSeconds: null, rtoSeconds: null, failure, failedChecks: [] };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
