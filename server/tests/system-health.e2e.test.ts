/**
 * System health endpoints (plan §5, sequencing items 12 and 13, issue 71):
 *
 *   GET /admin/health/system  — @AdminOnly, the full report
 *   GET /readyz               — @Public, a bounded subset, bare status only
 *   GET /healthz              — @Public, liveness, unconditional BY DESIGN
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import type { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { SYSTEM_CHECK_IDS } from '../src/system-health/system-health.types.js';
import { READINESS_CHECKS } from '../src/system-health/system-health.service.js';

interface Check {
  id: string;
  title: string;
  state: 'ok' | 'warn' | 'fail';
  summary: string;
  action: string | null;
  link: { label: string; href: string } | null;
  evidence: string[];
}

describe('system health e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let db: Kysely<Database>;
  let root: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    root = app.get(ContentPathResolver).root;
  });
  afterEach(async () => {
    if (existsSync(root) && !statSync(root).isDirectory()) rmSync(root, { force: true });
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    await app.close();
  });

  /**
   * Break the content root for real.
   *
   * Deleting it is NOT a break: the store mkdirs a working tree on first write,
   * so a fresh instance legitimately has no root directory yet and must stay
   * healthy. Replacing it with a FILE is the unrecoverable shape — nothing can
   * ever be created under it — and it is the one a bad mount actually produces.
   */
  const breakContentRoot = (): void => {
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'not a directory');
  };

  const report = async () =>
    (await request(app.getHttpServer()).get('/api/v1/admin/health/system').set('Cookie', cookie).expect(200)).body as {
      verdict: string;
      checked_at: string;
      checks: Check[];
    };
  const byId = (checks: Check[], id: string): Check => {
    const found = checks.find((c) => c.id === id);
    if (!found) throw new Error(`no check ${id}`);
    return found;
  };

  // -------------------------------------------------------------- the report

  it('returns every check, each with its own state, explanation and next step', async () => {
    const body = await report();
    expect(body.checks.map((c) => c.id)).toEqual([...SYSTEM_CHECK_IDS]);
    expect(Date.parse(body.checked_at)).not.toBeNaN();
    for (const check of body.checks) {
      expect(['ok', 'warn', 'fail']).toContain(check.state);
      expect(check.summary.length).toBeGreaterThan(0);
      expect(check.title.length).toBeGreaterThan(0);
      // Every non-ok row must tell the operator what to do; that is the whole
      // difference between this page and a list of rows to form an opinion over.
      if (check.state !== 'ok') expect(check.action, `${check.id} has no action`).toBeTruthy();
    }
  });

  it('a fresh instance is At risk, and it is the never-run restore drill that says so', async () => {
    const body = await report();
    const drill = byId(body.checks, 'restore_drill');
    expect(drill.state).toBe('fail');
    expect(drill.summary).toBe('Backups are unverified: the restore drill has never run.');
    expect(body.verdict).toBe('at_risk');
    // Nothing else on a fresh instance is broken — the verdict is the drill's.
    const otherFails = body.checks.filter((c) => c.id !== 'restore_drill' && c.state === 'fail');
    expect(otherFails.map((c) => `${c.id}: ${c.summary}`)).toEqual([]);
  });

  it('reports the database and the schema as healthy on a migrated instance', async () => {
    const body = await report();
    expect(byId(body.checks, 'database').state).toBe('ok');
    expect(byId(body.checks, 'schema').state).toBe('ok');
    expect(byId(body.checks, 'content_root').state).toBe('ok');
  });

  it('turns an unresolved merge conflict into a Degraded finding', async () => {
    await db
      .insertInto('sync_conflicts')
      .values({
        id: 'c-e2e',
        source_id: 'main',
        path: 'concepts/x.md',
        page_id: null,
        ours: null,
        theirs: null,
        base: null,
        detected_at: new Date().toISOString(),
        resolved_at: null,
        resolution: null,
        resolved_by: null,
      })
      .execute();
    const conflicts = byId((await report()).checks, 'conflicts');
    expect(conflicts.state).toBe('warn');
    expect(conflicts.evidence.join(' ')).toContain('main');
  });

  it('turns a broken content root into an At risk finding', async () => {
    breakContentRoot();
    const check = byId((await report()).checks, 'content_root');
    expect(check.state).toBe('fail');
    expect(check.summary).toBe('The content root path runs through a file.');
  });

  it('does NOT complain about a content root that simply has not been written to yet', async () => {
    rmSync(root, { recursive: true, force: true });
    const check = byId((await report()).checks, 'content_root');
    expect(check.state).toBe('ok');
    expect(check.evidence.join(' ')).toMatch(/will be created under/);
  });

  it('does NOT run the Content health report — the two have different costs', async () => {
    // The OKF export/audit path is the expensive half of Content health. If it
    // ever creeps in here, this endpoint inherits a whole-library render per
    // page load, which §5 rules out explicitly.
    const body = await report();
    expect(body).not.toHaveProperty('queues');
    expect(body).not.toHaveProperty('audit');
    expect(body).not.toHaveProperty('signals');
  });

  // ---------------------------------------------------------------- admin only

  it('refuses a non-admin', async () => {
    const { cookie: userCookie } = await seedUserAndLogin(app);
    await request(app.getHttpServer()).get('/api/v1/admin/health/system').set('Cookie', userCookie).expect(403);
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/health/system');
    expect([401, 403]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('restore');
  });

  // -------------------------------------------------------------------- probes

  describe('/readyz', () => {
    it('is 200 and ready on a healthy instance', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/readyz').expect(200);
      expect(res.body).toEqual({ status: 'ready' });
    });

    it('is 503 and not ready when a readiness dependency really is broken', async () => {
      breakContentRoot();
      const res = await request(app.getHttpServer()).get('/api/v1/readyz').expect(503);
      expect(res.body).toEqual({ status: 'not ready' });
    });

    it('leaks nothing to an anonymous caller — a status and a code, never the detail', async () => {
      breakContentRoot();
      const res = await request(app.getHttpServer()).get('/api/v1/readyz').expect(503);
      expect(Object.keys(res.body as object)).toEqual(['status']);
      const body = JSON.stringify(res.body) + res.text;
      // None of the things the admin report returns may appear here.
      expect(body).not.toContain(root);
      expect(body).not.toContain('content_root');
      expect(body).not.toContain('Content root');
      expect(body).not.toContain('runs through a file');
      expect(body).not.toContain('evidence');
    });

    it('is bounded to the readiness subset — an At risk report can still be ready', async () => {
      // The instance has never run a restore drill, so /admin/health/system says
      // At risk. That is a statement about the past and must not evict the
      // instance from a load balancer.
      expect((await report()).verdict).toBe('at_risk');
      await request(app.getHttpServer()).get('/api/v1/readyz').expect(200);
      expect(READINESS_CHECKS).not.toContain('restore_drill');
      expect(READINESS_CHECKS).not.toContain('git_outbox');
      expect(READINESS_CHECKS).not.toContain('disk');
      expect(READINESS_CHECKS).not.toContain('sources');
    });
  });

  describe('/healthz', () => {
    it('stays unconditional liveness: still ok when a readiness dependency is broken', async () => {
      breakContentRoot();
      await request(app.getHttpServer()).get('/api/v1/readyz').expect(503);
      // Deliberate. Liveness failing means "restart this process", and a restart
      // does not create a content root — it only throws away in-flight work.
      const res = await request(app.getHttpServer()).get('/api/v1/healthz').expect(200);
      expect(res.text).toBe('ok');
    });
  });
});
