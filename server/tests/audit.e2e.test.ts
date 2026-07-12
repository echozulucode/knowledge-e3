import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * Maps to features/07-audit-and-telemetry.feature.
 *
 * Verifies:
 * - Every write (create/update/rename/delete) lands an entry in audit_log with the
 *   right action and actor_id.
 * - The audit_log table is append-only — existing rows are not mutated by later writes.
 */
describe('audit log e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let userId: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });
  afterEach(async () => app.close());

  async function createPage(title = 'Audited'): Promise<{ id: string; version: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body: 'first body', status: 'draft' })
      .expect(201);
    return { id: res.body.page.id, version: res.body.page.version_token };
  }

  it('page.create produces an audit_log entry with action and actor_id', async () => {
    const { id } = await createPage('Created');
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'page.create')
      .where('page_id', '=', id)
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_id).toBe(userId);
  });

  it('page.update produces an audit_log entry', async () => {
    const { id, version } = await createPage('Updated');
    await request(app.getHttpServer())
      .put(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(version))
      .send({ body: 'second body' })
      .expect(200);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'page.update')
      .where('page_id', '=', id)
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_id).toBe(userId);
  });

  it('page.rename produces an audit_log entry', async () => {
    const { id, version } = await createPage('OldName');
    await request(app.getHttpServer())
      .post(`/api/v1/pages/${id}/rename`)
      .set('Cookie', cookie)
      .set('If-Match', String(version))
      .send({ new_title: 'NewName', link_action: 'update_all' })
      .expect(201);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'page.rename')
      .where('page_id', '=', id)
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_id).toBe(userId);
  });

  it('page.delete produces an audit_log entry', async () => {
    const { id } = await createPage('Doomed');
    await request(app.getHttpServer())
      .delete(`/api/v1/pages/${id}`)
      .set('Cookie', cookie)
      .expect(204);
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'page.delete')
      .where('page_id', '=', id)
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_id).toBe(userId);
  });

  it('audit_log is append-only — existing rows are not mutated by later writes', async () => {
    // Seed 10 rows by performing 10 writes (5 creates + 5 updates).
    const pages: { id: string; version: number }[] = [];
    for (let i = 0; i < 5; i++) {
      pages.push(await createPage(`AppendOnly ${i}`));
    }
    for (const p of pages) {
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${p.id}`)
        .set('Cookie', cookie)
        .set('If-Match', String(p.version))
        .send({ body: `bumped ${p.id}` })
        .expect(200);
    }

    const before = await db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();
    expect(before.length).toBeGreaterThanOrEqual(10);
    const beforeSnapshot = before.slice(0, 10).map((r) => ({ ...r }));

    // Do another batch of writes; the original 10 rows must not change.
    for (let i = 0; i < 5; i++) {
      await createPage(`MoreWrites ${i}`);
    }

    const after = await db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('id', 'asc')
      .execute();
    const afterSnapshot = after.slice(0, 10);

    expect(afterSnapshot).toEqual(beforeSnapshot);
    // Sanity: the table grew (we appended) — proves we're not just reading nothing.
    expect(after.length).toBeGreaterThan(before.length);
  });
});
