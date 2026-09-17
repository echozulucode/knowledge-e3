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
    expect(cfg.readAccess.default).toBe('public');
    expect(cfg.git.root).toBe('./data/wiki');
    expect(cfg.git.enabled).toBe(false); // NODE_ENV=test → off by default
    // Under test the canonical files never land in ./data: a per-process temp root.
    expect(cfg.content.root).toContain('e3-content-');
  });

  it('content.root is explicit or falls back; the removed writeFirst key is ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-cfg-'));
    const file = join(dir, 'knowledge-e3.config.yaml');
    // `writeFirst` was the Phase 3 rollback switch, removed in Phase 4: a stale
    // config file still carrying it must load, with the key simply dropped.
    writeFileSync(file, ['git: { root: ./custom/wiki }', 'content: { writeFirst: false }'].join('\n'), 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();
    // (content.root itself still falls back to the test temp dir here; the
    // git.root fallback only applies outside the suite.)
    expect(loadServerConfig().content).not.toHaveProperty('writeFirst');

    writeFileSync(file, 'content: { root: ./custom/content }\n', 'utf8');
    resetServerConfig();
    expect(loadServerConfig().content).toEqual({ root: './custom/content' });

    rmSync(dir, { recursive: true, force: true });
  });

  it('reads values from the YAML config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-cfg-'));
    const file = join(dir, 'knowledge-e3.config.yaml');
    writeFileSync(
      file,
      [
        'server: { port: 8080 }',
        'auth: { mode: session }',
        'git: { enabled: true, root: ./custom/wiki, mainRemote: git@host:org/k.git }',
        'mcp: { rateLimit: 30 }',
        'readAccess: { default: authenticated }',
      ].join('\n'),
      'utf8',
    );
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();

    const cfg = loadServerConfig();
    expect(cfg.server.port).toBe(8080);
    expect(cfg.auth.mode).toBe('session');
    expect(cfg.git.enabled).toBe(true); // explicit file value overrides the test default
    expect(cfg.git.root).toBe('./custom/wiki');
    expect(cfg.git.mainRemote).toBe('git@host:org/k.git');
    expect(cfg.mcp.rateLimit).toBe(30);
    expect(cfg.readAccess.default).toBe('authenticated');

    rmSync(dir, { recursive: true, force: true });
  });

  it('reads auth.loginThrottle, disables a bucket with off, and refuses a malformed limit at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-cfg-'));
    const file = join(dir, 'knowledge-e3.config.yaml');
    writeFileSync(file, 'auth: { mode: session, loginThrottle: { window: 10m, perUsername: 3, perIp: off } }\n', 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();
    expect(loadServerConfig().auth.loginThrottle).toEqual({ windowMs: 10 * 60_000, perUsername: 3, perIp: null });

    writeFileSync(file, 'auth: { loginThrottle: { perIp: twenty } }\n', 'utf8');
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/auth\.loginThrottle\.perIp/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses auth.mode: disabled with the fix in the message, and a typo too', () => {
    // Authentication cannot be turned off (the admin UX review §6,
    // answer 5). A stale file saying so must stop the load, not read as session.
    const dir = mkdtempSync(join(tmpdir(), 'e3-cfg-'));
    const file = join(dir, 'knowledge-e3.config.yaml');
    writeFileSync(file, 'auth: { mode: disabled }\n', 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/Authentication cannot be disabled/);
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/set auth\.mode to session or remove it.*create an admin account.*seed/i);

    writeFileSync(file, 'auth: { mode: sesion }\n', 'utf8');
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/auth\.mode: expected "session"/);

    writeFileSync(file, 'auth: { mode: session }\n', 'utf8');
    resetServerConfig();
    expect(loadServerConfig().auth.mode).toBe('session');

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when KNOWLEDGE_E3_CONFIG points at a missing file', () => {
    process.env['KNOWLEDGE_E3_CONFIG'] = join(tmpdir(), 'does-not-exist-e3.yaml');
    resetServerConfig();
    expect(() => loadServerConfig()).toThrow(/missing file/);
  });
});
