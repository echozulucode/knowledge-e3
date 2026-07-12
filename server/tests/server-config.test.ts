import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerConfig, resetServerConfig } from '../src/config/server-config.js';

describe('server config loader', () => {
  afterEach(() => {
    delete process.env['KNOWLEDGE_E3_CONFIG'];
    resetServerConfig();
  });

  it('uses safe defaults with no config file (mirror off under test)', () => {
    resetServerConfig();
    const cfg = loadServerConfig();
    expect(cfg.server.port).toBe(3000);
    expect(cfg.auth.mode).toBe('session');
    expect(cfg.mcp.rateLimit).toBe(120);
    expect(cfg.readAccess.default).toBe('authenticated');
    expect(cfg.git.root).toBe('./data/wiki');
    expect(cfg.git.enabled).toBe(false); // NODE_ENV=test → off by default
  });

  it('reads values from the YAML config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-cfg-'));
    const file = join(dir, 'knowledge-e3.config.yaml');
    writeFileSync(
      file,
      [
        'server: { port: 8080 }',
        'auth: { mode: disabled }',
        'git: { enabled: true, root: ./custom/wiki, mainRemote: git@host:org/k.git }',
        'mcp: { rateLimit: 30 }',
        'readAccess: { default: public }',
      ].join('\n'),
      'utf8',
    );
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();

    const cfg = loadServerConfig();
    expect(cfg.server.port).toBe(8080);
    expect(cfg.auth.mode).toBe('disabled');
    expect(cfg.git.enabled).toBe(true); // explicit file value overrides the test default
    expect(cfg.git.root).toBe('./custom/wiki');
    expect(cfg.git.mainRemote).toBe('git@host:org/k.git');
    expect(cfg.mcp.rateLimit).toBe(30);
    expect(cfg.readAccess.default).toBe('public');

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when KNOWLEDGE_E3_CONFIG points at a missing file', () => {
    process.env['KNOWLEDGE_E3_CONFIG'] = join(tmpdir(), 'does-not-exist-e3.yaml');
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/missing file/);
  });
});
