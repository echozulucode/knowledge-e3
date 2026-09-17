import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, resolveConfig } from '../src/cli.js';
import { ConfigError, loadConfigFile, validateConfig } from '../src/config.js';
import { tempDir, writeFiles } from './helpers.js';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('configuration', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    writeFiles(dir, { 'notes/a.md': '# A\n', 'repo/b.md': '# B\n' });
  });
  afterEach(() => cleanup());

  it('loads YAML with paths relative to the config file, defaults filled in', () => {
    const file = join(dir, 'knowledge-mcp.yaml');
    writeFileSync(
      file,
      [
        'sources:',
        '  - { id: notes, type: folder, path: ./notes }',
        '  - { id: handbook, type: git, path: repo, pull: on-start, topic: Handbook }',
        '  - { id: intranet, type: server, url: "https://kb.example.com", token_env: KB_TOKEN, topics: [ops] }',
      ].join('\n'),
    );
    const config = loadConfigFile(file);
    expect(config.sources).toEqual([
      { id: 'notes', type: 'folder', path: join(dir, 'notes'), default_status: 'published' },
      { id: 'handbook', type: 'git', path: join(dir, 'repo'), default_status: 'published', topic: 'Handbook', pull: 'on-start' },
      { id: 'intranet', type: 'server', url: 'https://kb.example.com/api/v1', token_env: 'KB_TOKEN', topics: ['ops'], timeout_ms: 15000 },
    ]);
  });

  it('loads JSON and keeps an explicit API root; git pull defaults to manual', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ sources: [{ id: 'r', type: 'git', path: 'repo' }, { id: 's', type: 'server', url: 'http://localhost:3000/api/v1/' }] }));
    const config = loadConfigFile(file);
    expect(config.sources[0]).toMatchObject({ type: 'git', pull: 'manual' });
    expect(config.sources[1]).toMatchObject({ url: 'http://localhost:3000/api/v1' });
  });

  it('reports every problem at once, with clear messages', () => {
    const found = problems(() =>
      validateConfig(
        {
          extra: 1,
          sources: [
            { id: 'bad:id', type: 'folder', path: 'notes' },
            { id: 'dup', type: 'folder', path: 'missing-dir' },
            { id: 'dup', type: 'folder', path: 'notes' },
            { id: 'g', type: 'git', path: 'repo', pull: 'always' },
            { id: 's', type: 'server', url: 'ftp://x' },
            { id: 't', type: 'server', url: 'https://user:pw@x.example' },
            { id: 'u', type: 'server', url: 'https://x.example', token_env: 'not a name', timeout_ms: 5 },
            { id: 'v', type: 'wiki', path: 'notes' },
            { id: 'w', type: 'folder', path: 'notes', pul: 'on-start' },
          ],
        },
        dir,
      ),
    );
    const text = found.join('\n');
    expect(text).toContain('unknown top-level key `extra`');
    expect(text).toContain('`id` must be 1-64 letters');
    expect(text).toContain('`path` does not exist');
    expect(text).toContain('duplicate source id `dup`');
    expect(text).toContain('`pull` must be manual or on-start');
    expect(text).toContain('`url` must be http(s)');
    expect(text).toContain('must not contain credentials');
    expect(text).toContain('`token_env` must be an environment variable NAME');
    expect(text).toContain('`timeout_ms` must be an integer');
    expect(text).toContain('`type` must be one of folder, git, server');
    expect(text).toContain('unknown key `pul`');
  });

  it('refuses a token in the config file without echoing it', () => {
    const secret = 'kp_pat_SUPERSECRET_VALUE_123';
    const found = problems(() => validateConfig({ sources: [{ id: 's', type: 'server', url: 'https://x.example', token: secret, api_secret: secret }] }, dir));
    expect(found.join('\n')).toContain('never put a token in the config file');
    expect(found.join('\n')).not.toContain(secret);
    expect(found.join('\n')).not.toContain(String(secret.length));
  });

  it('does not quote the offending line of an unparseable file', () => {
    const file = join(dir, 'broken.yaml');
    writeFileSync(file, 'sources:\n  - id: x\n    token: "kp_pat_LEAKED_IN_BROKEN_YAML\n  bad: [\n');
    const found = problems(() => loadConfigFile(file));
    expect(found.join('\n')).toContain('not valid YAML');
    expect(found.join('\n')).not.toContain('LEAKED');
  });

  it('parses flags, supports zero-config --folder with unique ids, and KNOWLEDGE_MCP_CONFIG', () => {
    expect(parseArgs(['--folder', 'a', '--folder=b', '--config', 'c.yaml'])).toEqual({ help: false, version: false, folders: ['a', 'b'], config: 'c.yaml' });
    expect(problems(() => parseArgs(['--frobnicate']))).toEqual(['unknown argument: --frobnicate']);
    expect(problems(() => parseArgs(['--config']))).toEqual(['--config needs a value']);

    writeFiles(dir, { 'x/notes/c.md': '# C\n' });
    const zero = resolveConfig(parseArgs(['--folder', 'notes', '--folder', 'x/notes']), {}, dir);
    expect(zero.sources.map((s) => s.id)).toEqual(['notes', 'notes-2']);

    const file = join(dir, 'env.yaml');
    writeFileSync(file, 'sources:\n  - { id: notes, type: folder, path: notes }\n');
    const viaEnv = resolveConfig(parseArgs(['--folder', 'repo']), { KNOWLEDGE_MCP_CONFIG: file }, dir);
    expect(viaEnv.sources.map((s) => s.id)).toEqual(['notes', 'repo']);

    expect(problems(() => resolveConfig(parseArgs([]), {}, dir))[0]).toContain('no sources configured');
    expect(problems(() => resolveConfig(parseArgs(['--folder', 'nope']), {}, dir))[0]).toContain('not a directory');
  });
});
