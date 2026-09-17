import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { seedFirstMvpCorpus } from '../src/seed.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * The OKF v0.2 health-audit endpoint: the three-tier report (conformance /
 * policy / advisories) plus the derived trust/freshness signal roll-up.
 */
describe('OKF audit (/okf/audit) e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    const db = app.get<Kysely<Database>>(KYSELY);
    await seedFirstMvpCorpus(db, login.userId);
  });

  afterEach(async () => app.close());

  it('returns a three-tier report and a signal summary', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/okf/audit')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.okf_version).toBe('0.2');
    expect(res.body.conformant).toBe(true); // everything E3 emits is conformant
    expect(Array.isArray(res.body.conformance)).toBe(true);
    expect(Array.isArray(res.body.policy)).toBe(true);
    expect(Array.isArray(res.body.advisories)).toBe(true);

    // The signal roll-up tallies every concept across the tier/freshness axes.
    const s = res.body.signals;
    expect(s.total).toBe(res.body.item_count);
    const tierTotal =
      s.byTrustTier.unverified + s.byTrustTier['machine-confirmed'] + s.byTrustTier['human-reviewed'];
    expect(tierTotal).toBe(s.total);
    expect(s.byFreshness.fresh + s.byFreshness.stale).toBe(s.total);
  });

  it('accepts an asOf date for reproducible staleness', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/okf/audit?asOf=2000-01-01')
      .set('Cookie', cookie)
      .expect(200);
    // Nothing is stale as of the year 2000.
    expect(res.body.signals.byFreshness.stale).toBe(0);
  });

  it('is admin-only', async () => {
    const nonAdmin = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .get('/api/v1/okf/audit')
      .set('Cookie', nonAdmin.cookie)
      .expect(403);
  });
});
