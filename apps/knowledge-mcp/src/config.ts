/**
 * Configuration: which sources this server may read, and nothing else.
 *
 *   sources:
 *     - { id: notes, type: folder, path: ./notes }
 *     - { id: handbook, type: git, path: ~/src/handbook, pull: on-start }
 *     - { id: intranet, type: server, url: https://kb.example.com, token_env: KNOWLEDGE_E3_TOKEN, topics: [ops] }
 *
 * A token is NEVER read from this file. `token_env` names the environment
 * variable that holds it; a `token` key in the file is a configuration error
 * (reported without echoing its value), because a secret in a config file ends
 * up in dotfile repos and screenshots.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type PullPolicy = 'manual' | 'on-start';
export type DefaultStatus = 'draft' | 'published';

interface LocalSourceFields {
  id: string;
  /** Absolute path as configured (resolved against the config file's directory). Realpath checks happen at load. */
  path: string;
  /** Repo-relative globs selecting the item files. Default: the OKF `concepts/` layout when present, else every `*.md`. */
  include?: string[];
  exclude?: string[];
  /** Topic for files that name none (and the topic the root `index.md` presents). */
  topic?: string;
  /** Status of a file whose frontmatter declares none. Default `published`. */
  default_status: DefaultStatus;
}

export interface FolderSourceConfig extends LocalSourceFields {
  type: 'folder';
}

export interface GitSourceConfig extends LocalSourceFields {
  type: 'git';
  /** `manual` (default): never touch the remote. `on-start`: one fast-forward-only pull at startup. */
  pull: PullPolicy;
}

export interface ServerSourceConfig {
  id: string;
  type: 'server';
  /** API root, e.g. `https://kb.example.com/api/v1` (a bare origin gets `/api/v1` appended). */
  url: string;
  /** Name of the environment variable holding a personal access token. */
  token_env?: string;
  /** Restrict this source to these topics (slug, id or name). */
  topics?: string[];
  timeout_ms: number;
}

export type SourceConfig = FolderSourceConfig | GitSourceConfig | ServerSourceConfig;

export interface KnowledgeMcpConfig {
  sources: SourceConfig[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid knowledge-mcp configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 15_000;

const KEYS: Record<SourceConfig['type'], string[]> = {
  folder: ['id', 'type', 'path', 'include', 'exclude', 'topic', 'default_status'],
  git: ['id', 'type', 'path', 'include', 'exclude', 'topic', 'default_status', 'pull'],
  server: ['id', 'type', 'url', 'token_env', 'topics', 'timeout_ms'],
};

/** Read and validate a YAML or JSON config file. Relative paths resolve against the file's directory. */
export function loadConfigFile(file: string): KnowledgeMcpConfig {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new ConfigError([`config file not found: ${abs}`]);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError([`config file could not be read: ${abs} (${(err as NodeJS.ErrnoException).code ?? 'error'})`]);
  }
  let doc: unknown;
  try {
    doc = extname(abs).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    // Parser messages quote the offending line, which could be a pasted secret: say where, not what.
    const where = err && typeof err === 'object' && 'linePos' in err ? ' (see the reported line)' : '';
    throw new ConfigError([`config file is not valid ${extname(abs).toLowerCase() === '.json' ? 'JSON' : 'YAML'}: ${abs}${where}`]);
  }
  return validateConfig(doc, dirname(abs));
}

/** Validate a parsed config document. Collects every problem instead of stopping at the first. */
export function validateConfig(doc: unknown, baseDir: string): KnowledgeMcpConfig {
  const problems: string[] = [];
  if (!isRecord(doc)) throw new ConfigError(['the config must be a mapping with a `sources` list']);
  for (const key of Object.keys(doc)) {
    if (key !== 'sources') problems.push(`unknown top-level key \`${key}\` (only \`sources\` is supported)`);
  }
  const list = doc['sources'];
  if (!Array.isArray(list) || list.length === 0) {
    problems.push('`sources` must be a non-empty list');
    throw new ConfigError(problems);
  }
  const sources: SourceConfig[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const where = `sources[${index}]`;
    const rawId = isRecord(entry) ? entry['id'] : undefined;
    if (typeof rawId === 'string') {
      if (seen.has(rawId)) problems.push(`${where}: duplicate source id \`${rawId}\``);
      seen.add(rawId);
    }
    const source = validateSource(entry, where, baseDir, problems);
    if (source) sources.push(source);
  });
  if (problems.length) throw new ConfigError(problems);
  return { sources };
}

function validateSource(entry: unknown, where: string, baseDir: string, problems: string[]): SourceConfig | null {
  if (!isRecord(entry)) {
    problems.push(`${where}: must be a mapping`);
    return null;
  }
  const before = problems.length;
  const id = entry['id'];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    problems.push(`${where}: \`id\` must be 1-64 letters, digits, \`-\` or \`_\` (it prefixes item refs as \`<id>:<item>\`)`);
  }
  const label = typeof id === 'string' && ID_PATTERN.test(id) ? `source \`${id}\`` : where;
  const type = entry['type'];
  if (type !== 'folder' && type !== 'git' && type !== 'server') {
    problems.push(`${label}: \`type\` must be one of folder, git, server`);
    return null;
  }
  // The rule this file exists to enforce. Report the key, never the value.
  for (const key of Object.keys(entry)) {
    if (/token|secret|password/i.test(key) && key !== 'token_env') {
      problems.push(
        `${label}: \`${key}\` is not allowed — never put a token in the config file; set it in an environment variable and name that variable with \`token_env\``,
      );
    } else if (!KEYS[type].includes(key)) {
      problems.push(`${label}: unknown key \`${key}\` for a ${type} source`);
    }
  }

  if (type === 'server') {
    const url = entry['url'];
    let parsed: URL | null = null;
    if (typeof url !== 'string') problems.push(`${label}: \`url\` is required`);
    else {
      try {
        parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          problems.push(`${label}: \`url\` must be http(s)`);
          parsed = null;
        } else if (parsed.username || parsed.password) {
          problems.push(`${label}: \`url\` must not contain credentials; use \`token_env\``);
          parsed = null;
        }
      } catch {
        problems.push(`${label}: \`url\` is not a valid URL`);
      }
    }
    const tokenEnv = entry['token_env'];
    if (tokenEnv !== undefined && (typeof tokenEnv !== 'string' || !ENV_NAME_PATTERN.test(tokenEnv))) {
      problems.push(`${label}: \`token_env\` must be an environment variable NAME (letters, digits, underscore)`);
    }
    const topics = entry['topics'];
    if (topics !== undefined && !isStringList(topics)) problems.push(`${label}: \`topics\` must be a list of strings`);
    const timeout = entry['timeout_ms'];
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 100 || timeout > 600_000)) {
      problems.push(`${label}: \`timeout_ms\` must be an integer between 100 and 600000`);
    }
    if (problems.length > before || !parsed) return null;
    const out: ServerSourceConfig = { id: id as string, type, url: apiRoot(parsed), timeout_ms: (timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS };
    if (typeof tokenEnv === 'string') out.token_env = tokenEnv;
    if (isStringList(topics) && topics.length) out.topics = topics.map((t) => t.trim()).filter(Boolean);
    return out;
  }

  const path = entry['path'];
  let abs = '';
  if (typeof path !== 'string' || !path.trim()) problems.push(`${label}: \`path\` is required`);
  else {
    abs = resolvePath(path, baseDir);
    if (!existsSync(abs)) problems.push(`${label}: \`path\` does not exist: ${abs}`);
    else if (!statSync(abs).isDirectory()) problems.push(`${label}: \`path\` is not a directory: ${abs}`);
  }
  for (const key of ['include', 'exclude'] as const) {
    if (entry[key] !== undefined && !isStringList(entry[key])) problems.push(`${label}: \`${key}\` must be a list of glob strings`);
  }
  const topic = entry['topic'];
  if (topic !== undefined && (typeof topic !== 'string' || !topic.trim())) problems.push(`${label}: \`topic\` must be a non-empty string`);
  const status = entry['default_status'];
  if (status !== undefined && status !== 'draft' && status !== 'published') {
    problems.push(`${label}: \`default_status\` must be draft or published`);
  }
  const pull = entry['pull'];
  if (type === 'git' && pull !== undefined && pull !== 'manual' && pull !== 'on-start') {
    problems.push(`${label}: \`pull\` must be manual or on-start`);
  }
  if (problems.length > before) return null;

  const local: LocalSourceFields = { id: id as string, path: abs, default_status: (status as DefaultStatus | undefined) ?? 'published' };
  if (isStringList(entry['include']) && entry['include'].length) local.include = entry['include'];
  if (isStringList(entry['exclude']) && entry['exclude'].length) local.exclude = entry['exclude'];
  if (typeof topic === 'string') local.topic = topic.trim();
  return type === 'git' ? { ...local, type, pull: (pull as PullPolicy | undefined) ?? 'manual' } : { ...local, type };
}

/**
 * Zero-config: `--folder <path>` (repeatable). Each folder becomes a `folder`
 * source whose id is derived from the directory name, made unique.
 */
export function foldersToSources(folders: string[], baseDir: string, taken: Iterable<string> = []): FolderSourceConfig[] {
  const used = new Set(taken);
  const problems: string[] = [];
  const out: FolderSourceConfig[] = [];
  for (const folder of folders) {
    const abs = resolvePath(folder, baseDir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      problems.push(`--folder ${folder}: not a directory: ${abs}`);
      continue;
    }
    const stem = basename(abs).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 56) || 'folder';
    let id = stem;
    for (let n = 2; used.has(id); n += 1) id = `${stem}-${n}`;
    used.add(id);
    out.push({ id, type: 'folder', path: abs, default_status: 'published' });
  }
  if (problems.length) throw new ConfigError(problems);
  return out;
}

function resolvePath(path: string, baseDir: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** `https://kb.example.com` → `https://kb.example.com/api/v1`; an explicit API root is kept. */
function apiRoot(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  const root = /\/api\/v\d+$/.test(path) ? path : `${path}/api/v1`;
  return `${url.origin}${root}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
