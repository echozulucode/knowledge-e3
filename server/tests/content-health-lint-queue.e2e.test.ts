/**
 * Content health's `lint_failed_inbound` queue carries its diagnostics (plan
 * B4). Before, a row said only that an item was broken; runbook §3.5(b) then
 * sent the operator to a SQL query for which file, which repository and which
 * key. The row now carries all three, from the `sync_diagnostics` row that put
 * the item in the queue — for BOTH doors that write that table: a file that
 * arrived through git sync, and a concept an admin imported as an OKF bundle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { LINT_DIAGNOSTICS_CAP, inboundLintFrom } from '../src/content-health/content-health.service.js';
import { PagesService } from '../src/pages/pages.service.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

interface LintRow {
  id: string;
  lint?: {
    source_id: string;
    path: string;
    detected_at: string;
    diagnostics: { code: string; severity: string; message: string; path?: string }[];
    diagnostics_total: number;
  };
}

describe('content health: the lint queue carries source, path and diagnostics', () => {
  let app: INestApplication;
  let cookie: string;
  let db: Kysely<Database>;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-lint-queue-'));
    process.env['GIT_MIRROR_ROOT'] = join(tmp, 'wiki');
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(tmp, { recursive: true, force: true });
  });

  async function lintQueue(): Promise<{ count: number; items: LintRow[] }> {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);
    return res.body.queues.lint_failed_inbound;
  }

  it('names the source, the file and each broken key for a file that arrived through sync', async () => {
    const spaces = app.get(SpacesService);
    await spaces.createCategory({ name: 'Guides' });
    await spaces.create({ name: 'Game Dev' });

    const bare = join(tmp, 'origin.git');
    const clone = join(tmp, 'clone');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['clone', '-q', bare, clone]);
    git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(clone, 'config', 'user.email', 'upstream@example.com');
    git(clone, 'config', 'user.name', 'Upstream');
    mkdirSync(join(clone, 'concepts'), { recursive: true });
    // No type and no primary category: two error-severity rules.
    writeFileSync(join(clone, 'concepts', 'loose-notes.md'), '---\ntitle: Loose Notes\nstatus: published\n---\n\nUntyped.\n', 'utf8');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'add loose notes');
    git(clone, 'push', '-q', 'origin', 'main');

    await app.get(SourceRegistryService).upsert('topic:game-dev', { remote_url: bare, branch: 'main', mode: 'direct' });
    await app.get(SyncService).runNow('topic:game-dev');
    const loose = (await app.get(PagesService).getBySlug('loose-notes'))!;

    const queue = await lintQueue();
    const row = queue.items.find((i) => i.id === loose.id);
    expect(row?.lint).toMatchObject({ source_id: 'topic:game-dev', path: 'concepts/loose-notes.md' });
    const codes = row!.lint!.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['type.missing', 'category.missing']));
    const typeMissing = row!.lint!.diagnostics.find((d) => d.code === 'type.missing')!;
    expect(typeMissing).toMatchObject({ severity: 'error', path: 'type' });
    expect(typeMissing.message).not.toBe('');
    expect(row!.lint!.diagnostics_total).toBe(row!.lint!.diagnostics.length);
    // The stored `fix` is for the machine that recorded it; the queue does not ship it.
    expect(JSON.stringify(row!.lint)).not.toContain('"fix"');
    // Errors lead, so the capped list always names what keeps the item a draft.
    const severities = row!.lint!.diagnostics.map((d) => d.severity);
    expect(severities.indexOf('error')).toBe(0);
  });

  it('names the import door, the file and each broken key for a concept imported as an OKF bundle', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({
        files: [
          {
            path: 'concepts/below-standard.md',
            // Conformant OKF (it has a type) but below local policy: no primary category, no description.
            content: ['---', 'type: Knowledge Page', 'title: Below Standard', 'e3_status: published', '---', '', 'Body.', ''].join('\n'),
          },
        ],
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const pageId = (res.body.ids as string[])[0]!;

    const queue = await lintQueue();
    const row = queue.items.find((i) => i.id === pageId);
    expect(row?.lint?.path).toBe('concepts/below-standard.md');
    // A bundle has no registered source; the door records its own constant, and the queue reports it as-is.
    expect(row?.lint?.source_id).toBe('okf-import');
    expect(row!.lint!.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['category.missing']));
    expect(row!.lint!.diagnostics.find((d) => d.code === 'category.missing')).toMatchObject({ path: 'categories' });
  });

  it('caps the diagnostics a row carries and says how many were left off', async () => {
    const pages = app.get(PagesService);
    const admin = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
    const page = await pages.create(admin.id, { title: 'Everything Wrong', body: 'x', status: 'draft', frontmatter: { type: 'Concept' } });
    const many = Array.from({ length: LINT_DIAGNOSTICS_CAP + 3 }, (_, i) => ({
      code: `rule.${i}`,
      severity: i === LINT_DIAGNOSTICS_CAP + 2 ? 'error' : 'warning',
      message: `Rule ${i} failed.`,
      path: `key_${i}`,
      fix: { description: 'not shipped' },
    }));
    await db
      .insertInto('sync_diagnostics')
      .values({
        id: 'diag_many',
        source_id: 'topic:handbook',
        path: 'docs/everything-wrong.md',
        page_id: page.id,
        diagnostics_json: JSON.stringify(many),
        detected_at: new Date().toISOString(),
        cleared_at: null,
        commented_at: null,
      })
      .execute();

    const row = (await lintQueue()).items.find((i) => i.id === page.id)!;
    expect(row.lint!.diagnostics).toHaveLength(LINT_DIAGNOSTICS_CAP);
    expect(row.lint!.diagnostics_total).toBe(LINT_DIAGNOSTICS_CAP + 3);
    // The one error was last in the file and is first in the row.
    expect(row.lint!.diagnostics[0]).toEqual({ code: `rule.${LINT_DIAGNOSTICS_CAP + 2}`, severity: 'error', message: `Rule ${LINT_DIAGNOSTICS_CAP + 2} failed.`, path: `key_${LINT_DIAGNOSTICS_CAP + 2}` });
    expect(row.lint!.diagnostics[1]!.code).toBe('rule.0');
  });

  it('never throws on a stored row it cannot read, and still names the source and file', () => {
    const base = { source_id: 'main', path: 'concepts/x.md', detected_at: '2026-09-13T00:00:00.000Z' };
    expect(inboundLintFrom({ ...base, diagnostics_json: 'not json' })).toEqual({ ...base, diagnostics: [], diagnostics_total: 0 });
    expect(inboundLintFrom({ ...base, diagnostics_json: '{"code":"x"}' })).toMatchObject({ diagnostics: [], diagnostics_total: 0 });
    expect(
      inboundLintFrom({ ...base, diagnostics_json: JSON.stringify([null, 7, { message: 'no code' }, { code: 'type.missing', severity: 'bogus' }]) }),
    ).toMatchObject({ diagnostics: [{ code: 'type.missing', severity: 'error', message: '' }], diagnostics_total: 1 });
  });
});
