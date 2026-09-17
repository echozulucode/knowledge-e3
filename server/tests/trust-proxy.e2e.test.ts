/**
 * `server.trustProxy` / `TRUST_PROXY` (issue 41 follow-up).
 *
 * Behind Azure Container Apps ingress every client reaches the server from the
 * ingress address. Without a trusted hop the per-IP sign-in bucket is one bucket
 * for the whole instance; trusting EVERY hop instead would let a client choose
 * its own address through `X-Forwarded-For`. These tests pin both halves:
 *
 *   - untrusted (default): a forged X-Forwarded-For does not buy a fresh bucket;
 *   - one trusted hop: distinct forwarded clients get distinct buckets;
 *   - the parser refuses `true` and garbage at boot rather than guessing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { loadServerConfig, resetServerConfig, trustProxySetting } from '../src/config/server-config.js';
import { makeApp } from './helpers.js';

const ENV_KEYS = ['TRUST_PROXY', 'LOGIN_THROTTLE_PER_IP', 'LOGIN_THROTTLE_PER_USERNAME', 'KNOWLEDGE_E3_CONFIG'] as const;

function login(app: INestApplication, username: string, forwardedFor?: string) {
  const req = request(app.getHttpServer()).post('/api/v1/auth/login');
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send({ username, password: 'wrong-password-2718' });
}

describe('trust proxy setting', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
  });

  describe('parsing', () => {
    it('is off by default, and reads hop counts, address lists and off from TRUST_PROXY', () => {
      expect(trustProxySetting()).toBe(false);
      process.env['TRUST_PROXY'] = '1';
      expect(trustProxySetting()).toBe(1);
      process.env['TRUST_PROXY'] = 'off';
      expect(trustProxySetting()).toBe(false);
      process.env['TRUST_PROXY'] = '0';
      expect(trustProxySetting()).toBe(false);
      process.env['TRUST_PROXY'] = ' 10.0.0.0/8, loopback ';
      expect(trustProxySetting()).toBe('10.0.0.0/8,loopback');
    });

    it('refuses "true" and unreadable values instead of guessing', () => {
      process.env['TRUST_PROXY'] = 'true';
      expect(() => trustProxySetting()).toThrow(/TRUST_PROXY: "true" trusts every hop/);
      process.env['TRUST_PROXY'] = 'the ingress';
      expect(() => trustProxySetting()).toThrow(/TRUST_PROXY/);
    });

    it('reads server.trustProxy from the config file, with the env winning', () => {
      const dir = mkdtempSync(join(tmpdir(), 'e3-trustproxy-'));
      const file = join(dir, 'knowledge-e3.config.yaml');
      writeFileSync(file, 'server: { port: 3000, trustProxy: 2 }\n', 'utf8');
      process.env['KNOWLEDGE_E3_CONFIG'] = file;
      resetServerConfig();
      expect(loadServerConfig().server.trustProxy).toBe(2);
      expect(trustProxySetting()).toBe(2);
      process.env['TRUST_PROXY'] = '1';
      expect(trustProxySetting()).toBe(1);

      writeFileSync(file, 'server: { trustProxy: true }\n', 'utf8');
      delete process.env['TRUST_PROXY'];
      resetServerConfig();
      expect(() => loadServerConfig()).toThrow(/server\.trustProxy/);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('the sign-in throttle keys on the address the setting allows', () => {
    it('untrusted: a forged X-Forwarded-For does not get a fresh per-IP bucket', async () => {
      process.env['LOGIN_THROTTLE_PER_IP'] = '3';
      process.env['LOGIN_THROTTLE_PER_USERNAME'] = 'off';
      app = await makeApp();
      await login(app, 'a', '198.51.100.1').expect(401);
      await login(app, 'b', '198.51.100.2').expect(401);
      await login(app, 'c', '198.51.100.3').expect(401);
      // Every request came from the same socket; the header was ignored.
      await login(app, 'd', '198.51.100.4').expect(429);
    });

    it('one trusted hop: distinct forwarded clients are distinct buckets', async () => {
      process.env['TRUST_PROXY'] = '1';
      process.env['LOGIN_THROTTLE_PER_IP'] = '3';
      process.env['LOGIN_THROTTLE_PER_USERNAME'] = 'off';
      app = await makeApp();
      for (const name of ['a', 'b', 'c']) await login(app, name, '198.51.100.7').expect(401);
      await login(app, 'd', '198.51.100.7').expect(429);
      // A different client behind the same ingress is unaffected.
      await login(app, 'e', '203.0.113.20').expect(401);
    });
  });
});
