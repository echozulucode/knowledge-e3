import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * Maps to features/07-audit-and-telemetry.feature scenario:
 *   "Page-view telemetry is captured client-side"
 *
 * Validates the server side: POST /api/v1/events/page-view inserts a row in
 * page_views with the user_id and timestamp.
 */
describe('telemetry e2e', () => {
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

  it('POST /events/page-view inserts a page_views row with user_id and timestamp', async () => {
    // Create a page so we have a real page_id reference (FK presence isn't
    // strictly enforced by the schema for page_views, but using a real id keeps
    // the test honest).
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Telemetry Subject', body: 'x', status: 'published' })
      .expect(201);
    const pageId = created.body.page.id as string;

    const beforeMs = Date.now();
    await request(app.getHttpServer())
      .post('/api/v1/events/page-view')
      .set('Cookie', cookie)
      .send({ page_id: pageId })
      .expect(204);
    const afterMs = Date.now();

    const rows = await db
      .selectFrom('page_views')
      .selectAll()
      .where('page_id', '=', pageId)
      .execute();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.user_id).toBe(userId);

    // Timestamp falls within the test window.
    const viewedAt = new Date(row.viewed_at).getTime();
    expect(viewedAt).toBeGreaterThanOrEqual(beforeMs);
    expect(viewedAt).toBeLessThanOrEqual(afterMs);
  });

  it('captures optional dwell_ms when supplied', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Telemetry Dwell', body: 'x', status: 'published' })
      .expect(201);
    const pageId = created.body.page.id as string;

    await request(app.getHttpServer())
      .post('/api/v1/events/page-view')
      .set('Cookie', cookie)
      .send({ page_id: pageId, dwell_ms: 12345 })
      .expect(204);

    const row = await db
      .selectFrom('page_views')
      .selectAll()
      .where('page_id', '=', pageId)
      .executeTakeFirst();
    expect(row?.dwell_ms).toBe(12345);
  });

  it('rejects unauthenticated page-view events with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/events/page-view')
      .send({ page_id: 'whatever' })
      .expect(401);
  });

  it('rejects an unknown page_id with 400 instead of a 500 FK error (P2-9)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/events/page-view')
      .set('Cookie', cookie)
      .send({ page_id: 'page_does_not_exist' })
      .expect(400);

    const rows = await db.selectFrom('page_views').selectAll().execute();
    expect(rows.length).toBe(0);
  });
});
