import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { AuditRetentionService, AUDIT_RETENTION_ACTION } from '../src/audit/audit-retention.service.js';
import { resetServerConfig } from '../src/config/server-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Plan §6 D3 — retention, which must not lag D2. */
describe('audit retention', () => {
  let app: INestApplication;
  let cookie: string;
  let db: Kysely<Database>;
  let retention: AuditRetentionService;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    retention = app.get(AuditRetentionService);
  });

  afterEach(async () => {
    delete process.env['AUDIT_RETENTION_DAYS'];
    resetServerConfig();
    await app.close();
  });

  async function seedAgedRow(ageDays: number, action = 'page.update'): Promise<void> {
    await db
      .insertInto('audit_log')
      .values({
        occurred_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
        actor_id: null,
        action,
        page_id: null,
        version_id: null,
        payload_json: null,
      })
      .execute();
  }

  async function actions(): Promise<string[]> {
    const rows = await db.selectFrom('audit_log').select('action').execute();
    return rows.map((r) => r.action);
  }

  it('removes rows past the window and keeps everything inside it', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = '365';
    await seedAgedRow(400, 'too.old');
    await seedAgedRow(366, 'just.too.old');
    await seedAgedRow(364, 'just.young.enough');
    await seedAgedRow(1, 'yesterday');

    const result = await retention.trim();

    expect(result.removed).toBe(2);
    const remaining = await actions();
    expect(remaining).toContain('just.young.enough');
    expect(remaining).toContain('yesterday');
    expect(remaining).not.toContain('too.old');
    expect(remaining).not.toContain('just.too.old');
    // The sign-in from seeding is inside the window and must survive.
    expect(remaining).toContain('auth.login');
  });

  it('makes the deletion observable from inside the log itself', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = '30';
    await seedAgedRow(90);
    await retention.trim();

    const marker = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', AUDIT_RETENTION_ACTION)
      .execute();
    expect(marker).toHaveLength(1);
    // Written AFTER the delete, so it survives its own trim.
    expect(JSON.parse(marker[0]!.payload_json!)).toMatchObject({ removed: 1, retention_days: 30 });
    expect(marker[0]!.actor_id).toBeNull();
  });

  it('says nothing when there was nothing to remove', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = '365';
    const result = await retention.trim();
    expect(result.removed).toBe(0);
    // No marker row per boot: a log full of "removed 0" is noise, and the
    // absence of a marker already means nothing was removed.
    const marker = await db.selectFrom('audit_log').selectAll().where('action', '=', AUDIT_RETENTION_ACTION).execute();
    expect(marker).toHaveLength(0);
  });

  it('`off` keeps everything', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = 'off';
    await seedAgedRow(5000, 'ancient');
    const result = await retention.trim();
    expect(result).toMatchObject({ removed: 0, retention_days: null });
    expect(await actions()).toContain('ancient');
  });

  it('refuses to start on a retention window it cannot parse', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = '1 year';
    // Loud at boot rather than a year later from history that is not there.
    await expect(retention.trim()).rejects.toThrow(/AUDIT_RETENTION_DAYS/);
  });

  it('is not reachable over HTTP', async () => {
    process.env['AUDIT_RETENTION_DAYS'] = '30';
    await seedAgedRow(90, 'should.survive.every.verb');
    // The audit surface is read-only: no verb on it can trigger a trim, and no
    // other route may delete a row either.
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (request(app.getHttpServer()) as any)[verb]('/api/v1/admin/audit').set('Cookie', cookie);
      expect(res.status).toBe(404);
    }
    expect(await actions()).toContain('should.survive.every.verb');
  });
});

/**
 * The append-only invariant, enforced against the source rather than against
 * behaviour: a future delete added anywhere else would not fail any e2e test,
 * it would just quietly make the log unreliable.
 */
describe('audit_log is append-only in the source', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('has exactly one delete and no update, both inside AuditService', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      const mutates = /(deleteFrom|updateTable)\(\s*['"]audit_log['"]\s*\)/.test(text);
      if (mutates && !file.endsWith(join('audit', 'audit.service.ts'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    const service = readFileSync(join(root, 'audit', 'audit.service.ts'), 'utf8');
    expect(service.match(/deleteFrom\(\s*'audit_log'\s*\)/g)).toHaveLength(1);
    expect(service.match(/updateTable\(\s*'audit_log'\s*\)/g)).toBeNull();
  });

  it('no controller can reach the retention job', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const reachable = sourceFiles(root)
      .filter((f) => f.endsWith('.controller.ts'))
      // `audit.trim(` / `auditLog.trim(`, never a bare `.trim()` on a string.
      .filter((f) => /AuditRetentionService|\baudit\w*\.trim\(/i.test(readFileSync(f, 'utf8')));
    expect(reachable).toEqual([]);
  });
});
