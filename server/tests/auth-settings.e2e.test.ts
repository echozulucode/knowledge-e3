/**
 * Admin → Authentication settings with provenance (the admin UX review §4.7).
 *
 * Contract pinned here: `GET /admin/auth/settings` reports every auth setting
 * the page shows with WHERE its value came from — `admin` (with who and when),
 * `env` (with the variable names), `config`, or `default` — so the page never
 * claims an admin chose something a deploy file did, or the reverse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { resetServerConfig } from '../src/config/server-config.js';

const ENV_KEYS = [
  'KNOWLEDGE_E3_CONFIG',
  'KNOWLEDGE_E3_DEFAULT_READ_ACCESS',
  'LOGIN_THROTTLE_WINDOW',
  'LOGIN_THROTTLE_PER_USERNAME',
  'LOGIN_THROTTLE_PER_IP',
] as const;

describe('admin auth settings provenance e2e', () => {
  let app: INestApplication | undefined;
  let saved: Record<string, string | undefined>;
  let tmp: string | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetServerConfig();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  async function boot() {
    app = await makeApp();
    const admin = await seedAdminAndLogin(app);
    const settings = async () =>
      (await request(app!.getHttpServer()).get('/api/v1/admin/auth/settings').set('Cookie', admin.cookie).expect(200)).body;
    return { admin, settings };
  }

  it('reports built-in defaults when nothing has been set anywhere', async () => {
    const { settings } = await boot();
    const body = await settings();
    const defaultProvenance = { source: 'default', updated_at: null, updated_by_username: null, env_vars: [] };

    expect(body.read_access).toMatchObject({ read_mode: 'public', provenance: defaultProvenance, editable: true });
    expect(body.read_access.deploy_default).toMatchObject({ read_mode: 'public', source: 'default' });
    expect(body.password_policy).toEqual({
      policy: { min_length: 8, require_number: false, require_symbol: false, require_uppercase: false },
      provenance: defaultProvenance,
      editable: true,
    });
    expect(body.token_policy).toEqual({ max_days: null, provenance: defaultProvenance, editable: true });
    expect(body.login_throttle).toEqual({
      window_ms: 15 * 60_000,
      per_username: 5,
      per_ip: 20,
      provenance: defaultProvenance,
      editable: false,
    });
  });

  it('names the admin and the time once a setting is saved in admin', async () => {
    const { admin, settings } = await boot();
    const before = new Date(Date.now() - 1000).toISOString();
    await request(app!.getHttpServer())
      .put('/api/v1/admin/auth/password-policy')
      .set('Cookie', admin.cookie)
      .send({ min_length: 12, require_number: true, require_symbol: false, require_uppercase: false })
      .expect(200);
    await request(app!.getHttpServer())
      .put('/api/v1/admin/auth/token-policy')
      .set('Cookie', admin.cookie)
      .send({ max_days: null })
      .expect(200);
    await request(app!.getHttpServer())
      .put('/api/v1/admin/access')
      .set('Cookie', admin.cookie)
      .send({ read_mode: 'authenticated' })
      .expect(200);

    const body = await settings();
    for (const section of [body.password_policy, body.token_policy, body.read_access]) {
      expect(section.provenance.source).toBe('admin');
      expect(section.provenance.updated_by_username).toBe('admin');
      expect(section.provenance.updated_at >= before).toBe(true);
      expect(section.provenance.env_vars).toEqual([]);
    }
    expect(body.password_policy.policy.min_length).toBe(12);
    // Saving "no maximum" is still an admin choice, not the default.
    expect(body.token_policy.max_days).toBeNull();
    expect(body.read_access.read_mode).toBe('authenticated');
    // The deploy default it overrides is still reported.
    expect(body.read_access.deploy_default).toMatchObject({ read_mode: 'public', source: 'default' });
  });

  it('attributes deploy-time values to the environment by variable name', async () => {
    process.env['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'] = 'authenticated';
    process.env['LOGIN_THROTTLE_PER_IP'] = '7';
    const { settings } = await boot();
    const body = await settings();

    expect(body.read_access.read_mode).toBe('authenticated');
    expect(body.read_access.provenance).toEqual({
      source: 'env',
      updated_at: null,
      updated_by_username: null,
      env_vars: ['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'],
    });
    expect(body.login_throttle.per_ip).toBe(7);
    expect(body.login_throttle.provenance).toMatchObject({ source: 'env', env_vars: ['LOGIN_THROTTLE_PER_IP'] });
    // Names only: the response never needs a variable's value to explain itself.
    expect(JSON.stringify(body.login_throttle.provenance)).not.toContain('"7"');
  });

  it('attributes values from the config file to the config file', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-auth-settings-'));
    const file = join(tmp, 'knowledge-e3.config.yaml');
    writeFileSync(file, ['readAccess: { default: authenticated }', 'auth: { loginThrottle: { perUsername: 3 } }'].join('\n'), 'utf8');
    process.env['KNOWLEDGE_E3_CONFIG'] = file;
    resetServerConfig();
    const { settings } = await boot();
    const body = await settings();

    expect(body.read_access.read_mode).toBe('authenticated');
    expect(body.read_access.provenance.source).toBe('config');
    expect(body.login_throttle.per_username).toBe(3);
    expect(body.login_throttle.provenance).toMatchObject({ source: 'config', env_vars: [] });
    // Untouched settings are still defaults.
    expect(body.password_policy.provenance.source).toBe('default');
  });

  it('is 401 without a session and 403 for a non-admin', async () => {
    app = await makeApp();
    await seedAdminAndLogin(app);
    const { cookie } = await seedUserAndLogin(app);
    await request(app.getHttpServer()).get('/api/v1/admin/auth/settings').expect(401);
    await request(app.getHttpServer()).get('/api/v1/admin/auth/settings').set('Cookie', cookie).expect(403);
  });
});
