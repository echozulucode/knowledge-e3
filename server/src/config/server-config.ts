import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Backend server configuration, loaded once from (in increasing precedence):
 *   built-in defaults  →  a YAML config file  →  environment variables.
 *
 * Env vars are read *live* at each use-site (so they always win and tests can set
 * them per-case); this object holds the defaults + file values. Defaults are
 * chosen so the typical path works with no config at all — e.g. the git mirror is
 * on at `./data/wiki` (off under test, like the in-memory DB).
 *
 * The file is found at `$KNOWLEDGE_E3_CONFIG`, else `./knowledge-e3.config.yaml`.
 * See `knowledge-e3.config.example.yaml`.
 */
export interface ServerConfig {
  /**
   * `trustProxy` is which proxy hops Express may believe about the client
   * address (`X-Forwarded-For`), see {@link TrustProxySetting}. Env `TRUST_PROXY`
   * overrides, read live by `trustProxySetting()`.
   */
  server: { port: number; trustProxy: TrustProxySetting };
  /**
   * `loginThrottle` is the sign-in lockout (issue 41), see {@link LoginThrottleConfig}.
   * Env `LOGIN_THROTTLE_WINDOW` / `LOGIN_THROTTLE_PER_USERNAME` /
   * `LOGIN_THROTTLE_PER_IP` override, read live by `loginThrottleSettings()`.
   * `mode` is always `session`; see `authModeValue` for why `disabled` refuses the boot.
   */
  auth: { mode: 'session'; loginThrottle: LoginThrottleConfig };
  /** File-provided DB URL, if any. The DB module layers env/test/prod rules on top. */
  database: { url?: string };
  /**
   * `commitQuietMs` / `commitMaxMs` are the git mirror's commit-debounce window
   * (`git.commit.quiet` / `git.commit.max`): the quiet period after the last
   * write before a commit fires, and the hard cap that makes a steady write
   * stream commit anyway. Undefined ⇒ the adapter's own defaults (2s / 15s), so
   * the numbers live in exactly one place. The window is the time an indexed
   * write has no commit behind it: shorter costs one commit (and, unmanaged,
   * one push) per burst; longer widens the gap a crash leaves for the outbox
   * replay to close. Per-instance because a cloud demo on ephemeral disk and a
   * laptop self-host want different answers.
   */
  git: {
    enabled: boolean;
    root: string;
    mainRemote?: string;
    commitQuietMs?: number;
    commitMaxMs?: number;
  };
  /**
   * Canonical content (plan §7.2–7.3): the local bundle working trees the write
   * path writes FIRST. `root` defaults to `git.root` so the file the command
   * writes is the one the mirror commits. Write-first is unconditional since
   * Phase 4 — the `writeFirst` / `KNOWLEDGE_E3_WRITE_FIRST` rollback switch is gone.
   */
  content: { root: string };
  mcp: { rateLimit: number };
  /**
   * Site-wide presentation (plan §12 decision 5, reader plan §4 R2.1). `homeTopic`
   * is the slug of the topic whose landing the site Home renders; unset leaves the
   * web app with its own guess (the `default` topic, else the first visible one),
   * so a fresh instance still has a Home.
   *
   * The rest is tenant branding. Every field is optional and every default is
   * exactly today's behaviour, so an instance with no `site:` block at all renders
   * as it always has. Logos are **asset URLs**, not filesystem paths: a logo is
   * uploaded through the content-addressed asset path (ADR-0003, `server/src/images`,
   * served at `/assets/<file>`) and so lives in the main repository beside the
   * content — it survives a rebuild-from-git and travels with a backup, which a
   * path into the container's filesystem does not.
   */
  site: SiteConfig;
  readAccess: { default: 'public' | 'authenticated' };
  /**
   * Source registry entries declared in the file (plan §7.4, Appendix B).
   * Reconciled into `content_sources` at boot: the file wins for the fields it
   * names; anything else an admin edited persists.
   */
  sources: SourceConfigEntry[];
  /** Default fetch/merge cadence in seconds for sources that set none (`sync.every`, default 300). */
  sync: { every: number };
  /**
   * How long audit rows are kept (`audit.retention`, default 365 days; `off`
   * keeps everything). A bare number is days; `90d` and `52w` also parse.
   *
   * 365 days because the questions this log answers are annual ones — "who
   * changed this last October", "was that account attacked before the audit" —
   * and because sign-in rows make the table grow with traffic rather than with
   * the library, so "keep everything" is a slow leak rather than a choice.
   * Per-instance for the same reason `sync.every` is: a laptop self-host and a
   * hosted deployment weigh disk against history differently.
   */
  audit: { retentionDays: number | null };
  /**
   * The scheduled restore drill (issue 71) — `backup.drill`.
   *
   * A backup nobody has restored is a hope, not a backup, and an unscheduled
   * drill is a drill nobody runs. This is the schedule; the drill itself is
   * `server/scripts/restore-drill.ts` and runbook §3.8.
   *
   * Per-instance, and **off by default**, which is the one place this key
   * departs from `sync.every` and `audit.retention`. Those two are cheap and
   * their default is the right answer everywhere. A drill copies the database,
   * every working tree and every asset byte to scratch and boots a second
   * application instance against the copy — potentially gigabytes of I/O — so
   * it is the one scheduled job an operator must opt into deliberately, having
   * decided where the scratch space is and how often the cost is worth paying.
   * Defaulting it on would mean a fresh `docker compose up` on a laptop starts
   * doing that on its own.
   */
  backup: BackupConfig;
}

/**
 * `auth.loginThrottle` — failed sign-ins tolerated per sliding window, in two
 * independent buckets. Either limit may be `null` (`off` / `0`), which disables
 * that bucket only.
 *
 * - `perUsername` (default 5) stops a guesser working through one account's
 *   password; `perIp` (default 20) stops one client spraying a common password
 *   across many accounts, which the per-username bucket alone never notices.
 * - The IP is Express's `req.ip`. Behind a reverse proxy or ingress that is the
 *   proxy's address for every client — one bucket for the whole instance —
 *   unless `server.trustProxy` / `TRUST_PROXY` names the proxy hop (see
 *   {@link TrustProxySetting} and the runbook, §4 "Sign-in throttling").
 */
export interface LoginThrottleConfig {
  windowMs: number;
  perUsername: number | null;
  perIp: number | null;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleConfig = {
  windowMs: 15 * 60_000,
  perUsername: 5,
  perIp: 20,
};

export interface BackupConfig {
  drill: {
    /**
     * Cadence in seconds. **Null means off**, which is the default — and off is
     * honest: `BackupDrillStatus.outcome` then stays `never` and the health page
     * says this instance is unverified, rather than implying a schedule exists.
     */
    everySeconds: number | null;
    /**
     * Scratch root for the run's backup + restored copy. Undefined ⇒ the OS temp
     * directory. Exists because the scratch holds a full second copy of the
     * instance: `/tmp` on a container with a small writable layer is exactly
     * where a drill fails for a reason that has nothing to do with the backup.
     * Never inside the content root — the tools refuse that, loudly.
     */
    workDir?: string;
    /**
     * Hard cap on one run, after which the child process is killed and the run
     * is recorded as failed. A drill that hangs (a restored app that never
     * finishes listening, a stalled copy) must not sit holding scratch space
     * and the no-overlap lock until the next restart.
     */
    timeoutMs: number;
  };
}

export interface SiteConfig {
  /** Slug of the topic whose landing is the site Home. */
  homeTopic?: string;
  /** Wordmark. Default: the product's own name. */
  name?: string;
  /** Wordmark for the collapsed rail and mobile chrome. Default: `name`. */
  shortName?: string;
  /** Light-mode logo, as an asset URL (`/assets/<file>`) or an absolute http(s) URL. */
  logo?: string;
  /** Dark-mode logo; falls back to `logo`. */
  logoDark?: string;
  /** Browser favicon. */
  favicon?: string;
  /** Front-page hero line. Default: today's kickoff prompt. */
  tagline?: string;
  /** Placeholder in the front-page and rail search boxes. */
  searchPlaceholder?: string;
}

export interface SourceConfigEntry {
  /** `main` or `topic:<slug>`. */
  id: string;
  /** Working tree, absolute or relative to the content root. */
  local?: string;
  remote?: string;
  branch?: string;
  role?: 'authoritative' | 'reference';
  policy?: { mode?: 'direct' | 'review' | 'read-only'; branchPrefix?: string };
  host?: { kind?: 'github' | 'bitbucket-dc'; baseUrl?: string; tokenEnv?: string };
  /** `every` is seconds (a bare number or `300s`, `5m`, `1h`). */
  sync?: { every?: number; webhookSecretEnv?: string };
  /**
   * Non-OKF Markdown import (plan §8.3). Posix globs, repo-relative, selecting
   * the `.md` files this source indexes (`docs/**`, `notes/**`). Omitted ⇒ today's
   * behaviour: `concepts/*.md` at any depth. `exclude` subtracts from `include`.
   */
  include?: string[];
  exclude?: string[];
  /** Content type for an imported file whose frontmatter names none (a content-type label or key). */
  defaultType?: string;
}

let cached: ServerConfig | undefined;

/** Load (and memoize) the merged server config. */
export function loadServerConfig(): ServerConfig {
  if (!cached) cached = build();
  return cached;
}

/**
 * Test hook: drop the memoized config so the next load re-reads file + env.
 * Also clears the admin-declared asset registry below, so one test's pinned
 * covers cannot grant the next test's anonymous visitor anything.
 */
export function resetServerConfig(): void {
  cached = undefined;
  declaredAssets = new Set<string>();
}

export function isTest(): boolean {
  // VITEST is set in every vitest worker and is more reliable than NODE_ENV,
  // which other tests/tools can mutate. Keeps the mirror off during the suite.
  return process.env['NODE_ENV'] === 'test' || process.env['VITEST'] != null;
}

function configFilePath(): string | null {
  const explicit = process.env['KNOWLEDGE_E3_CONFIG'];
  if (explicit) {
    const abs = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(abs)) throw new Error(`KNOWLEDGE_E3_CONFIG points at a missing file: ${abs}`);
    return abs;
  }
  const fallback = resolve(process.cwd(), 'knowledge-e3.config.yaml');
  return existsSync(fallback) ? fallback : null;
}

function readConfigFile(): Record<string, unknown> {
  const path = configFilePath();
  if (!path) return {};
  try {
    return (parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>) ?? {};
  } catch (err) {
    throw new Error(`failed to parse config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function build(): ServerConfig {
  const f = readConfigFile();
  const git = section(f, 'git');
  const gitCommit = section(git, 'commit');
  const content = section(f, 'content');
  const retention = days(section(f, 'audit')['retention'], 'audit.retention');
  return {
    server: { port: num(section(f, 'server')['port'], 3000), trustProxy: trustProxyValue(section(f, 'server')['trustProxy'], 'server.trustProxy') ?? false },
    auth: {
      mode: authModeValue(section(f, 'auth')['mode']),
      loginThrottle: loginThrottleConfig(section(section(f, 'auth'), 'loginThrottle')),
    },
    database: { url: str(section(f, 'database')['url']) },
    git: {
      // Default on for normal runs, off under test (like the in-memory DB).
      enabled: typeof git['enabled'] === 'boolean' ? (git['enabled'] as boolean) : !isTest(),
      root: str(git['root']) ?? './data/wiki',
      mainRemote: str(git['mainRemote']),
      commitQuietMs: millis(gitCommit['quiet'], 'git.commit.quiet'),
      commitMaxMs: millis(gitCommit['max'], 'git.commit.max'),
    },
    content: {
      root: str(content['root']) ?? testContentRoot() ?? str(git['root']) ?? './data/wiki',
    },
    mcp: { rateLimit: num(section(f, 'mcp')['rateLimit'], 120) },
    site: siteConfig(section(f, 'site')),
    readAccess: { default: section(f, 'readAccess')['default'] === 'authenticated' ? 'authenticated' : 'public' },
    sources: sourceEntries(f['sources']),
    sync: { every: duration(section(f, 'sync')['every']) ?? 300 },
    // `??` would be wrong here: `null` is the operator asking for "keep
    // everything", which must not fall back to the default.
    audit: { retentionDays: retention === undefined ? DEFAULT_AUDIT_RETENTION_DAYS : retention },
    backup: backupConfig(section(section(f, 'backup'), 'drill')),
  };
}

/**
 * `backup.drill`. The cadence defaults to null (off) rather than to a number,
 * so an absent block and `every: off` mean the same thing and neither pretends
 * a drill is scheduled.
 */
function backupConfig(drill: Record<string, unknown>): BackupConfig {
  return {
    drill: {
      everySeconds: cadence(drill['every'], 'backup.drill.every') ?? null,
      ...(str(drill['workDir']) ? { workDir: str(drill['workDir']) } : {}),
      timeoutMs: millis(drill['timeout'], 'backup.drill.timeout') ?? DEFAULT_DRILL_TIMEOUT_MS,
    },
  };
}

/**
 * The `site:` block. Every key is optional and a malformed one is *dropped*
 * rather than thrown, following `homeTopic`'s precedent: branding is cosmetic,
 * and a typo in a logo URL must cost the operator their logo, never the site its
 * front page. (`git.commit.*` throws instead — that one is a durability knob.)
 */
function siteConfig(s: Record<string, unknown>): SiteConfig {
  const out: SiteConfig = {};
  const put = (key: keyof SiteConfig, value: string | undefined): void => {
    if (value) out[key] = value;
  };
  put('homeTopic', str(s['homeTopic']));
  put('name', str(s['name']));
  put('shortName', str(s['shortName']));
  put('logo', assetUrl(s['logo']));
  put('logoDark', assetUrl(s['logoDark']));
  put('favicon', assetUrl(s['favicon']));
  put('tagline', str(s['tagline']));
  put('searchPlaceholder', str(s['searchPlaceholder']));
  return out;
}

/**
 * A branding image the browser can fetch: a root-relative URL (`/assets/<file>`,
 * the content-addressed path an uploaded asset gets) or an absolute http(s) URL.
 *
 * Everything else is undefined, which lands the caller on the built-in mark:
 * a container filesystem path (`/var/lib/...` is a URL and is accepted, but
 * a Windows path is not a URL at all), a bare relative path that would
 * resolve differently per route, a protocol-relative `//host/x` that silently
 * downgrades, and any other scheme — `javascript:` and `data:` above all, since
 * this value ends up in an `<img src>` on every page of the site.
 */
export function assetUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  if (/\s/.test(raw)) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  // Root-relative only, and never protocol-relative.
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  // `..` in a URL is legal but never intended here, and it is the shape a
  // mistyped filesystem path takes.
  if (raw.split('/').includes('..')) return undefined;
  return raw;
}

/**
 * True when `file` is the bare filename of an asset the operator has declared as
 * this site's identity (logo, dark logo, favicon).
 *
 * `/assets/<file>` is otherwise readable anonymously only when a *published page
 * in a public topic* embeds it, which a logo never is — it is embedded in the
 * chrome, not in an item. Declaring a file in `site:` is the operator saying it
 * is the public face of the instance, so it is served on the same terms as the
 * login screen it appears on.
 */
export function isSiteBrandingAsset(file: string): boolean {
  const { logo, logoDark, favicon } = loadServerConfig().site;
  for (const url of [logo, logoDark, favicon]) {
    if (url && url.startsWith('/assets/') && url.slice('/assets/'.length) === file) return true;
  }
  return declaredAssets.has(file);
}

/**
 * Every filename `isSiteBrandingAsset` answers true for, as a list — for the
 * Files admin, which must filter and page on "used by the site" in SQL rather
 * than one predicate call per row. Same sources, same rule.
 */
export function siteBrandingAssetFiles(): string[] {
  const { logo, logoDark, favicon } = loadServerConfig().site;
  const files = new Set(declaredAssets);
  for (const url of [logo, logoDark, favicon]) {
    if (url && url.startsWith('/assets/')) files.add(url.slice('/assets/'.length));
  }
  return [...files];
}

/**
 * Chrome images an ADMIN declared through the app rather than through this
 * file — today, the covers on the home page's pinned topics.
 *
 * They belong to exactly the same rule as the logo and for exactly the same
 * reason: `/assets/<file>` is otherwise public only while a *published page*
 * embeds it, and a pinned-topic cover is embedded in the front page's chrome,
 * so nothing ever links it and it 404s for the anonymous visitor who is this
 * product's default reader. Rather than a second predicate with a second set of
 * rules, `isSiteBrandingAsset` answers for both.
 *
 * A module-level set rather than a database read because the predicate is on
 * the synchronous asset-serving path (`ImagesController.serve`), which must not
 * grow an `await` per byte served. `ConfigService` owns the contents: it primes
 * this at boot and refreshes it on every read and write of the pin list, so the
 * registry cannot drift from `app_config` for longer than one request.
 *
 * Only the bare filename of a root-relative `/assets/` URL grants anything — an
 * off-instance `https://cdn…` cover declares nothing here, the same way an
 * off-instance logo does not.
 */
let declaredAssets: ReadonlySet<string> = new Set<string>();

export function declareSiteAssets(urls: Iterable<string | null | undefined>): void {
  const files = new Set<string>();
  for (const url of urls) {
    if (typeof url === 'string' && url.startsWith('/assets/')) files.add(url.slice('/assets/'.length));
  }
  declaredAssets = files;
}

function sourceEntries(value: unknown): SourceConfigEntry[] {
  if (!Array.isArray(value)) return [];
  const out: SourceConfigEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const id = str(e['id']);
    if (!id) throw new Error('sources[]: every entry needs an `id` (`main` or `topic:<slug>`)');
    const policy = section(e, 'policy');
    const host = section(e, 'host');
    const sync = section(e, 'sync');
    const role = str(e['role']);
    const mode = str(policy['mode']) ?? (typeof e['policy'] === 'string' ? (e['policy'] as string) : undefined);
    const kind = str(host['kind']) ?? (typeof e['host'] === 'string' ? (e['host'] as string) : undefined);
    if (role !== undefined && role !== 'authoritative' && role !== 'reference') throw new Error(`sources[${id}]: invalid role "${role}"`);
    if (mode !== undefined && mode !== 'direct' && mode !== 'review' && mode !== 'read-only') throw new Error(`sources[${id}]: invalid policy.mode "${mode}"`);
    if (kind !== undefined && kind !== 'github' && kind !== 'bitbucket-dc') throw new Error(`sources[${id}]: invalid host.kind "${kind}"`);
    const entry: SourceConfigEntry = { id };
    const local = str(e['local']);
    const remote = str(e['remote']);
    const branch = str(e['branch']);
    if (local) entry.local = local;
    if (remote) entry.remote = remote;
    if (branch) entry.branch = branch;
    if (role) entry.role = role;
    if (mode || str(policy['branchPrefix'])) entry.policy = { ...(mode ? { mode } : {}), ...(str(policy['branchPrefix']) ? { branchPrefix: str(policy['branchPrefix']) } : {}) };
    if (kind || str(host['baseUrl']) || str(host['tokenEnv'])) {
      entry.host = {
        ...(kind ? { kind } : {}),
        ...(str(host['baseUrl']) ? { baseUrl: str(host['baseUrl']) } : {}),
        ...(str(host['tokenEnv']) ? { tokenEnv: str(host['tokenEnv']) } : {}),
      };
    }
    const include = strList(e['include']);
    const exclude = strList(e['exclude']);
    const defaultType = str(e['defaultType']);
    if (include) entry.include = include;
    if (exclude) entry.exclude = exclude;
    if (defaultType) entry.defaultType = defaultType;
    const every = duration(sync['every']);
    if (every !== undefined || str(sync['webhookSecretEnv'])) {
      entry.sync = { ...(every !== undefined ? { every } : {}), ...(str(sync['webhookSecretEnv']) ? { webhookSecretEnv: str(sync['webhookSecretEnv']) } : {}) };
    }
    out.push(entry);
  }
  return out;
}

/**
 * A list of non-empty strings: a YAML sequence, or a single scalar as a
 * one-element list. Undefined when absent; blank/non-string members are dropped.
 */
function strList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const one = str(value);
    return one ? [one] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const s = str(raw);
    if (s) out.push(s);
  }
  return out.length ? out : undefined;
}

/** `300`, `"300"`, `"300s"`, `"5m"`, `"1h"` → seconds; undefined when absent or malformed. */
function duration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const seconds = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  return seconds > 0 ? Math.round(seconds) : undefined;
}

/**
 * `1500`, `"1500"`, `"1500ms"`, `"2s"`, `"5m"`, `"1h"` → milliseconds; undefined
 * when absent. Unlike `duration()` this THROWS on a malformed value rather than
 * silently falling back: the commit window is a durability knob, and an
 * operator who typed `"2 sec"` must find out at boot, not from a git log that
 * still commits on the default cadence.
 *
 * (`h` is accepted for `backup.drill.timeout`, whose natural unit is minutes to
 * hours rather than milliseconds. It is a pure widening — an `h` value used to
 * throw — so no existing key's meaning changes.)
 */
function millis(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const bad = (): never => {
    throw new Error(`${key}: expected a duration like 2000, "1500ms", "2s", "5m" or "1h" (got ${JSON.stringify(value)})`);
  };
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : bad();
  if (typeof value !== 'string') return bad();
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  if (!m) return bad();
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const ms = unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1_000 : n;
  return ms > 0 ? Math.round(ms) : bad();
}

/** Default cap on one drill run: 30 minutes. See {@link BackupConfig}. */
export const DEFAULT_DRILL_TIMEOUT_MS = 30 * 60_000;

/**
 * The shortest drill cadence this accepts, outside the test suite. A drill is
 * gigabytes of I/O and a second booted application, so a cadence in seconds is
 * never what an operator meant — it is what `every: 7` looks like when they
 * meant seven days. Refusing it at boot is how they find out. The suite is
 * exempt so a test can prove the timer fires without waiting a minute.
 */
export const MIN_DRILL_EVERY_SECONDS = 60;

/**
 * `86400`, `"24h"`, `"7d"`, `"1w"` → seconds; `"off"`/`"never"`/`0` → null,
 * meaning the drill is not scheduled. Undefined when the key is absent.
 *
 * THROWS on anything else, like `days()` and unlike `duration()`. The failure
 * mode a silent fallback produces here is the exact failure issue 71 is about:
 * an operator who typed `"weekly"` would get *no drill at all* and a health page
 * that says so only if they read it closely. A refused boot is louder.
 */
function cadence(value: unknown, key: string): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const bad = (): never => {
    throw new Error(`${key}: expected a cadence like 86400, "24h", "7d", "1w" or "off" (got ${JSON.stringify(value)})`);
  };
  let seconds: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return bad();
    seconds = Math.round(value);
  } else if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === '') return undefined;
    if (raw === 'off' || raw === 'never' || raw === 'false' || raw === 'no') return null;
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/.exec(raw);
    if (!m) return bad();
    const n = Number(m[1]);
    const mult = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 }[m[2] ?? 's'] ?? 1;
    if (!Number.isFinite(n)) return bad();
    seconds = Math.round(n * mult);
  } else {
    return bad();
  }
  if (seconds === 0) return null;
  if (seconds < MIN_DRILL_EVERY_SECONDS && !isTest()) {
    throw new Error(
      `${key}: ${seconds}s is too frequent for a restore drill (minimum ${MIN_DRILL_EVERY_SECONDS}s). ` +
        'A bare number is SECONDS — did you mean "7d"?',
    );
  }
  return seconds;
}

/**
 * The drill schedule with env winning over the file, the same precedence
 * `AUDIT_RETENTION_DAYS` has: `BACKUP_DRILL_EVERY` (a cadence, or `off`),
 * `BACKUP_DRILL_WORK_DIR`, `BACKUP_DRILL_TIMEOUT`.
 *
 * Read live at each use so a test — and an operator restarting with a different
 * env — gets the current answer rather than whatever was cached at first boot.
 */
export function backupDrillSchedule(): BackupConfig['drill'] {
  const cfg = loadServerConfig().backup.drill;
  const every = cadence(process.env['BACKUP_DRILL_EVERY'], 'BACKUP_DRILL_EVERY');
  return {
    everySeconds: every === undefined ? cfg.everySeconds : every,
    ...(process.env['BACKUP_DRILL_WORK_DIR'] ?? cfg.workDir
      ? { workDir: process.env['BACKUP_DRILL_WORK_DIR'] ?? cfg.workDir }
      : {}),
    timeoutMs: millis(process.env['BACKUP_DRILL_TIMEOUT'], 'BACKUP_DRILL_TIMEOUT') ?? cfg.timeoutMs,
  };
}

/**
 * `auth.loginThrottle`. Malformed values THROW, like `git.commit.*`: this is a
 * security knob, and an operator who typed `perIp: "twenty"` must find out at
 * boot rather than from an instance that is quietly running on the defaults.
 */
function loginThrottleConfig(t: Record<string, unknown>): LoginThrottleConfig {
  const perUsername = attemptLimit(t['perUsername'], 'auth.loginThrottle.perUsername');
  const perIp = attemptLimit(t['perIp'], 'auth.loginThrottle.perIp');
  return {
    windowMs: millis(t['window'], 'auth.loginThrottle.window') ?? DEFAULT_LOGIN_THROTTLE.windowMs,
    perUsername: perUsername === undefined ? DEFAULT_LOGIN_THROTTLE.perUsername : perUsername,
    perIp: perIp === undefined ? DEFAULT_LOGIN_THROTTLE.perIp : perIp,
  };
}

/**
 * How to run with authentication on, shared by both refusals (config file here,
 * env in `auth-mode.ts`). The seed is the documented admin bootstrap (README,
 * azure-deploy-guide §6a): an instance with no admin account is exactly the
 * situation `disabled` used to paper over.
 */
export const CREATE_ADMIN_HINT =
  'create an admin account with `pnpm --filter @echozedlabs/server seed` (in the container: `node server/dist/seed.js`; ' +
  'SEED_ADMIN_USERNAME / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD choose the credentials)';

/**
 * `auth.mode`. Only `session` exists: every HTTP request is a signed-in user, a
 * token's owner, or the anonymous public-read visitor. `disabled` (every request
 * acting as the local admin) was removed on purpose - "at minimum we need an
 * admin password" (the admin UX review §6, answer 5) - so a file
 * that still says it REFUSES the boot rather than being quietly read as
 * `session`: its operator expects no sign-in, and has to learn that they need an
 * admin account before the instance is any use. Any other value is a typo,
 * refused like the other malformed auth knobs.
 */
function authModeValue(value: unknown): 'session' {
  if (value === undefined || value === null) return 'session';
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (raw === '' || raw === 'session') return 'session';
  if (raw === 'disabled') {
    const file = configFilePath();
    throw new Error(
      `Authentication cannot be disabled (auth.mode: disabled${file ? ` in ${file}` : ''}). ` +
        `Set auth.mode to session or remove it, and ${CREATE_ADMIN_HINT}.`,
    );
  }
  throw new Error(`auth.mode: expected "session" (got ${JSON.stringify(value)})`);
}

/** `5`, `"5"` → 5; `0` / `"off"` → null (bucket disabled); undefined when absent. Throws otherwise. */
function attemptLimit(value: unknown, key: string): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (raw === '') return undefined;
  if (raw === 'off' || raw === false) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${key}: expected a whole number of failed attempts, or "off" (got ${JSON.stringify(value)})`);
  }
  return n === 0 ? null : n;
}

/**
 * The login throttle with env winning over the file, the same precedence
 * `AUDIT_RETENTION_DAYS` has: `LOGIN_THROTTLE_WINDOW` (a duration like `15m`),
 * `LOGIN_THROTTLE_PER_USERNAME`, `LOGIN_THROTTLE_PER_IP` (a count, or `off`).
 * Read live so a test — and a restarted process — gets the current answer.
 */
export function loginThrottleSettings(): LoginThrottleConfig {
  const cfg = loadServerConfig().auth.loginThrottle;
  const perUsername = attemptLimit(process.env['LOGIN_THROTTLE_PER_USERNAME'], 'LOGIN_THROTTLE_PER_USERNAME');
  const perIp = attemptLimit(process.env['LOGIN_THROTTLE_PER_IP'], 'LOGIN_THROTTLE_PER_IP');
  return {
    windowMs: millis(process.env['LOGIN_THROTTLE_WINDOW'], 'LOGIN_THROTTLE_WINDOW') ?? cfg.windowMs,
    perUsername: perUsername === undefined ? cfg.perUsername : perUsername,
    perIp: perIp === undefined ? cfg.perIp : perIp,
  };
}

/**
 * Which deploy-time layer an auth setting's effective value came from, for the
 * provenance line on Admin → Authentication ("From environment (LOGIN_THROTTLE_PER_IP)").
 * `env_vars` names the variables in effect — names only, never their values,
 * though none of these carries a secret.
 */
export interface DeploySettingOrigin {
  source: 'env' | 'config' | 'default';
  env_vars: string[];
}

/** An env var counts as set when it is present and not blank, which is when the loaders read it. */
function envSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '';
}

/**
 * The raw value at `path` in the config file, or undefined. Re-reads the file
 * rather than asking the memoized `ServerConfig`, whose normalized values cannot
 * tell "the file said public" from "the file said nothing" — and this is only
 * asked by an admin opening the Authentication page.
 */
function configFileValue(path: readonly string[]): unknown {
  let node: unknown = readConfigFile();
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node === null || (typeof node === 'string' && node.trim() === '') ? undefined : node;
}

/**
 * Where the deploy default for read access comes from: `KNOWLEDGE_E3_DEFAULT_READ_ACCESS`,
 * else `readAccess.default` in the file, else the built-in `public`. Same
 * precedence (and the same "an unrecognised value is ignored" rule) as
 * `defaultReadAccessMode()` in config.service.ts, which reads its value from here.
 */
export function readAccessDefaultOrigin(): DeploySettingOrigin & { value: 'public' | 'authenticated' } {
  const env = process.env['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'];
  if (env === 'public' || env === 'authenticated') {
    return { value: env, source: 'env', env_vars: ['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'] };
  }
  const file = configFileValue(['readAccess', 'default']);
  const value = loadServerConfig().readAccess.default;
  return file === undefined ? { value, source: 'default', env_vars: [] } : { value, source: 'config', env_vars: [] };
}

const LOGIN_THROTTLE_ENV = ['LOGIN_THROTTLE_WINDOW', 'LOGIN_THROTTLE_PER_USERNAME', 'LOGIN_THROTTLE_PER_IP'] as const;

/**
 * Where the login throttle's settings come from, as one answer for the whole
 * group: env if any of its variables is set (they win field by field), else the
 * file if it names any field, else the defaults. There is no admin layer — the
 * throttle is a deploy-time security knob and is shown read-only.
 */
export function loginThrottleOrigin(): DeploySettingOrigin {
  const env_vars = LOGIN_THROTTLE_ENV.filter(envSet);
  if (env_vars.length > 0) return { source: 'env', env_vars };
  const inFile = ['window', 'perUsername', 'perIp'].some((k) => configFileValue(['auth', 'loginThrottle', k]) !== undefined);
  return { source: inFile ? 'config' : 'default', env_vars: [] };
}

/**
 * Express's `trust proxy`: which hops in front of this server may tell it the
 * client's address through `X-Forwarded-For`. `false` (the default) believes
 * only the socket — right for a server nobody proxies, and wrong behind Azure
 * Container Apps ingress or any TLS terminator, where every client then shares
 * the proxy's address and per-IP limits (the sign-in throttle, the MCP rate
 * limiter) become one bucket for the whole instance.
 *
 * - a whole number of hops you control (`1` behind Container Apps ingress);
 * - or a comma-separated list of proxy addresses/CIDRs, or Express's names
 *   `loopback`, `linklocal`, `uniquelocal`.
 *
 * `true` ("trust every hop") is REFUSED: it makes `X-Forwarded-For` wholly
 * client-chosen, so anyone could rotate their own throttle bucket per request.
 */
export type TrustProxySetting = false | number | string;

/** Parse a `trustProxy` value. Undefined when absent; THROWS on anything unsafe or unreadable. */
function trustProxyValue(value: unknown, key: string): TrustProxySetting | undefined {
  if (value === undefined || value === null) return undefined;
  const bad = (why: string): never => {
    throw new Error(`${key}: ${why} (got ${JSON.stringify(value)})`);
  };
  if (value === false) return false;
  if (value === true) return bad('"true" trusts every hop, which lets any client choose its own address; give a hop count or proxy addresses');
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? (value === 0 ? false : value) : bad('expected a whole number of hops');
  if (typeof value !== 'string') return bad('expected a hop count or a comma-separated list of proxy addresses');
  const raw = value.trim();
  if (raw === '' || /^(off|false|0)$/i.test(raw)) return false;
  if (/^true$/i.test(raw)) return bad('"true" trusts every hop, which lets any client choose its own address; give a hop count or proxy addresses');
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const ok = parts.every((p) => /^(loopback|linklocal|uniquelocal)$/i.test(p) || /^[0-9a-f:.]+(\/\d{1,3})?$/i.test(p));
  return ok && parts.length ? parts.join(',') : bad('expected a hop count, proxy addresses/CIDRs, or loopback/linklocal/uniquelocal');
}

/** `trust proxy` with `TRUST_PROXY` winning over `server.trustProxy`. Read live. */
export function trustProxySetting(): TrustProxySetting {
  const env = trustProxyValue(process.env['TRUST_PROXY'], 'TRUST_PROXY');
  return env === undefined ? loadServerConfig().server.trustProxy : env;
}

/** Audit rows are kept for a year unless the operator says otherwise. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/**
 * `365`, `"365"`, `"365d"`, `"52w"` → days; `"off"`/`"never"`/`0` → null, meaning
 * keep everything. Undefined when the key is absent.
 *
 * THROWS on anything else, like `millis()` and unlike `duration()`: this is the
 * one knob in this file whose misreading destroys data. An operator who typed
 * `"1 year"` must find out at boot, not a year later from the history that is
 * no longer there.
 */
function days(value: unknown, key: string): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const bad = (): never => {
    throw new Error(`${key}: expected a retention window like 365, "365d", "52w" or "off" (got ${JSON.stringify(value)})`);
  };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return bad();
    return value === 0 ? null : Math.round(value);
  }
  if (typeof value !== 'string') return bad();
  const raw = value.trim().toLowerCase();
  if (raw === '') return undefined;
  if (raw === 'off' || raw === 'never' || raw === 'forever') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(d|w)?$/.exec(raw);
  if (!m) return bad();
  const n = Number(m[1]);
  const total = m[2] === 'w' ? n * 7 : n;
  if (!Number.isFinite(total) || total < 0) return bad();
  return total === 0 ? null : Math.round(total);
}

/**
 * Live env override for audit retention (`AUDIT_RETENTION_DAYS`, in days; `off`
 * keeps everything) — env wins over the file, the same precedence
 * `GIT_COMMIT_QUIET_MS` has. Null means nothing is ever deleted.
 */
export function auditRetentionDays(): number | null {
  const env = days(process.env['AUDIT_RETENTION_DAYS'], 'AUDIT_RETENTION_DAYS');
  return env === undefined ? loadServerConfig().audit.retentionDays : env;
}

let testRoot: string | undefined;

/**
 * Under test, with no explicit root (`CONTENT_ROOT` / `GIT_MIRROR_ROOT`), the
 * canonical files land in a per-process temp dir so the suite never writes
 * into ./data. Null outside the suite (the normal default applies).
 */
function testContentRoot(): string | null {
  if (!isTest() || process.env['CONTENT_ROOT'] || process.env['GIT_MIRROR_ROOT']) return null;
  testRoot ??= mkdtempSync(join(tmpdir(), 'e3-content-'));
  return testRoot;
}

/**
 * The git mirror's commit-debounce window, env winning over the config file
 * (`GIT_COMMIT_QUIET_MS` / `GIT_COMMIT_MAX_MS`, both in milliseconds) — the same
 * precedence GIT_MIRROR_ROOT has. Either half may be undefined; the adapter then
 * keeps its default for that half, so a deployment can shorten only the cap.
 */
export function commitWindow(): { quietMs?: number; maxMs?: number } {
  const cfg = loadServerConfig().git;
  return {
    quietMs: millis(process.env['GIT_COMMIT_QUIET_MS'], 'GIT_COMMIT_QUIET_MS') ?? cfg.commitQuietMs,
    maxMs: millis(process.env['GIT_COMMIT_MAX_MS'], 'GIT_COMMIT_MAX_MS') ?? cfg.commitMaxMs,
  };
}

/** Live env override for the canonical content root (env wins, like GIT_MIRROR_ROOT does for the mirror). */
export function contentRoot(): string {
  return process.env['CONTENT_ROOT'] ?? process.env['GIT_MIRROR_ROOT'] ?? loadServerConfig().content.root;
}


function section(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
