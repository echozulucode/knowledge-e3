import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
  server: { port: number };
  auth: { mode: 'session' | 'disabled' };
  /** File-provided DB URL, if any. The DB module layers env/test/prod rules on top. */
  database: { url?: string };
  git: { enabled: boolean; root: string; mainRemote?: string };
  mcp: { rateLimit: number };
  readAccess: { default: 'public' | 'authenticated' };
}

let cached: ServerConfig | undefined;

/** Load (and memoize) the merged server config. */
export function loadServerConfig(): ServerConfig {
  if (!cached) cached = build();
  return cached;
}

/** Test hook: drop the memoized config so the next load re-reads file + env. */
export function resetServerConfig(): void {
  cached = undefined;
}

function isTest(): boolean {
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
  return {
    server: { port: num(section(f, 'server')['port'], 3000) },
    auth: { mode: section(f, 'auth')['mode'] === 'disabled' ? 'disabled' : 'session' },
    database: { url: str(section(f, 'database')['url']) },
    git: {
      // Default on for normal runs, off under test (like the in-memory DB).
      enabled: typeof git['enabled'] === 'boolean' ? (git['enabled'] as boolean) : !isTest(),
      root: str(git['root']) ?? './data/wiki',
      mainRemote: str(git['mainRemote']),
    },
    mcp: { rateLimit: num(section(f, 'mcp')['rateLimit'], 120) },
    readAccess: { default: section(f, 'readAccess')['default'] === 'public' ? 'public' : 'authenticated' },
  };
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
