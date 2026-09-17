/**
 * The restore drill, drilled (issue 71).
 *
 * An automated drill nobody runs is the same failure as the documentation
 * nobody rehearsed, so the drill is itself a test subject here:
 *
 *  1. A small but real instance is built through the command path — items in
 *     the main repo and in a dedicated topic repo, an uploaded asset with its
 *     `.meta.json` sidecar, all committed by the real routing mirror into real
 *     git working trees. Then it is backed up, restored into a temp location,
 *     and every functional check must pass.
 *  2. **Negative controls**, which are the half that matters: delete an asset's
 *     bytes, corrupt the database, dirty a working tree, and the drill must
 *     FAIL and name what is wrong. Without these the suite would only prove the
 *     drill runs, not that it detects.
 *  3. The isolation guard: the drill must refuse to restore anywhere that could
 *     touch live data, and it must leave the source instance byte-identical.
 *
 * Everything here lives under the OS temp directory. Nothing in `server/data`,
 * `./data/wiki`, or the developer's live index is read or written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { curateCategories, seedAdminAndLogin } from './helpers.js';
import { runBackup } from '../scripts/backup.js';
import { runRestoreDrill, type DrillCheck, type DrillReport } from '../scripts/restore-drill.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { resetServerConfig } from '../src/config/server-config.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';

/** A real 1x1 PNG — the attachment policy types an upload by its magic bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const SILENT = (): void => undefined;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function check(report: DrillReport, id: string): DrillCheck {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}" in: ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

/** Every path this suite owns, so `afterAll` can prove it cleaned up after itself. */
const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('restore drill: backup → restore into an isolated instance → verify', () => {
  let liveRoot: string;
  let liveDb: string;
  let backupDir: string;
  let assetFile: string;
  let itemSlug: string;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedEnv = {
      DB_URL: process.env['DB_URL'],
      GIT_MIRROR_ROOT: process.env['GIT_MIRROR_ROOT'],
      CONTENT_ROOT: process.env['CONTENT_ROOT'],
      KNOWLEDGE_E3_ASSETS_DIR: process.env['KNOWLEDGE_E3_ASSETS_DIR'],
      KNOWLEDGE_E3_CONFIG: process.env['KNOWLEDGE_E3_CONFIG'],
    };

    // A FILE-backed database, unlike the rest of the suite's `:memory:`, because
    // a backup of an in-memory database is not a thing that exists.
    liveRoot = temp('e3-drill-live-root-');
    liveDb = join(temp('e3-drill-live-db-'), 'kp.sqlite');
    process.env['DB_URL'] = liveDb;
    process.env['GIT_MIRROR_ROOT'] = liveRoot;
    resetServerConfig();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REVISION_MIRROR)
      // The production wiring: the mirror commits from the same working trees
      // the write-first command writes into. Copied from conformance.e2e.test.ts
      // deliberately — the drill must be exercised against a real git-of-record
      // instance, not a fixture that only looks like one.
      .useFactory({
        factory: (kysely: Kysely<Database>, outbox: OutboxService, resolver: ContentPathResolver) =>
          new RoutingRevisionMirror(resolver.root, kysely, {
            quietMs: 20,
            maxMs: 50,
            onCommitted: (committed, at) =>
              outbox.markProcessed(committed.map((c) => ({ pageId: c.itemId, path: c.path })), at),
          }),
        inject: [KYSELY, OutboxService, ContentPathResolver],
      })
      .compile();
    const app: INestApplication = moduleRef.createNestApplication();
    configureApp(app, { webDist: null });
    await app.init();
    const { cookie } = await seedAdminAndLogin(app);
    // Both items are created published, so their primary category is curated first.
    await curateCategories(app, 'engineering');

    // An asset first, so `image_links` resolves against the images index at save
    // time exactly as it does after a restore.
    const upload = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(201);
    assetFile = upload.body.file as string;
    const mirror = app.get<RoutingRevisionMirror>(REVISION_MIRROR);
    await mirror.notifyAssetsChanged();
    await mirror.flush();

    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw:
          '---\ntitle: Deployment Pipeline\ntype: Concept\nstatus: published\ntopic: Ops\n' +
          'tags: [ops]\ncategories: [engineering]\ndescription: How a change reaches production.\n---\n' +
          `The pipeline builds, tests, and ships every change.\n\n![Diagram](/assets/${assetFile})\n`,
      })
      .expect(201);
    itemSlug = created.body.item.slug as string;
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw:
          '---\ntitle: Rotate Secrets\ntype: How-To\nstatus: published\ntopic: Ops\n' +
          'categories: [engineering]\ndescription: How credentials are rotated.\n---\nSee the pipeline first.\n',
      })
      .expect(201);

    await mirror.flush();
    expect(await app.get(OutboxService).pending()).toHaveLength(0);
    expect(git(join(liveRoot, 'main'), 'status', '--porcelain')).toBe('');

    // The instance is stopped before the backup, as the runbook's "Take a
    // backup" says: the DB snapshot is consistent either way, but the file
    // halves want the writers quiesced.
    await app.close();

    backupDir = temp('e3-drill-backup-');
    await runBackup({ outDir: backupDir, force: true, log: SILENT });
  }, 180_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetServerConfig();
    for (const dir of temps) {
      // Best effort: `DbModule.onModuleDestroy` deliberately does not close the
      // Kysely connection ("connections close when the process exits"), so on
      // Windows the live fixture's SQLite file is still held open here and the
      // directory cannot be unlinked. Leaving a temp dir behind is not a test
      // failure; the OS reclaims it.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* the OS temp directory is not this suite's problem to guarantee */
      }
    }
  });

  /** A private copy of the backup, so a negative control cannot poison the others. */
  function copyBackup(): string {
    const dir = temp('e3-drill-mutant-');
    cpSync(backupDir, dir, { recursive: true });
    return dir;
  }

  it('captures all three parts of the recovery unit and says what it did not capture', () => {
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    // git: the main working tree, at a real commit, with its files.
    expect(manifest.trees.length).toBeGreaterThanOrEqual(1);
    const main = manifest.trees.find((t: { source_id: string | null }) => t.source_id === 'main') ?? manifest.trees[0];
    expect(main.head).toMatch(/^[0-9a-f]{40}$/);
    expect(main.dirty).toEqual([]);
    expect(main.tracked_files).toBeGreaterThan(0);
    // assets: bytes AND the git-tracked descriptor (ADR-0003).
    expect(manifest.assets.byte_files).toBe(1);
    expect(manifest.assets.descriptors).toBe(1);
    expect(manifest.assets.missing_bytes).toEqual([]);
    // sqlite: a consistent snapshot, with the rows that live nowhere else.
    expect(manifest.db.method).toBe('vacuum-into');
    expect(manifest.db.counts.pages).toBe(2);
    expect(manifest.db.counts.users).toBeGreaterThanOrEqual(1);
    expect(manifest.db.counts.images).toBe(1);
    // and the honesty half, which is a deliverable, not a nicety.
    expect(manifest.not_captured.join(' ')).toMatch(/Litestream/);
    expect(manifest.not_captured.join(' ')).toMatch(/Secret VALUES/);
  });

  it('restores into a fresh instance that signs in, serves an item, searches, and resolves an asset', async () => {
    // `item` is named rather than left to the default (newest published), so
    // the functional checks are pinned to the item that carries the asset.
    const report = await runRestoreDrill({
      backupDir,
      target: temp('e3-drill-target-'),
      item: itemSlug,
      keep: true,
      log: SILENT,
    });

    expect(report.ok).toBe(true);
    expect(check(report, 'db.integrity_check').status).toBe('pass');
    expect(check(report, 'db.foreign_key_check').status).toBe('pass');
    expect(check(report, 'db.counts').status).toBe('pass');
    expect(check(report, 'git.main').status).toBe('pass');
    expect(check(report, 'assets').status).toBe('pass');
    // Functional, not just structural: a restore that passes integrity_check
    // and cannot serve a page has not been verified.
    expect(check(report, 'fn.signin').status).toBe('pass');
    expect(check(report, 'fn.item').status).toBe('pass');
    expect(check(report, 'fn.item').detail).toContain(itemSlug);
    expect(check(report, 'fn.search').status).toBe('pass');
    expect(check(report, 'fn.asset').status).toBe('pass');
    expect(check(report, 'fn.asset').detail).toContain(assetFile);
    expect(check(report, 'fn.health').status).toBe('pass');

    // RPO and RTO are recorded, which is what turns "we have backups" into a
    // number someone can make a decision with.
    expect(report.rpo.seconds).toBeGreaterThanOrEqual(0);
    expect(report.rpo.newest_change_in_backup).toBeTruthy();
    expect(report.rto.seconds).toBeGreaterThan(0);
    expect(report.rto.phases.functional).toBeGreaterThanOrEqual(0);
    expect(report.rto.excludes.length).toBeGreaterThan(0);
    // The gap list is the report's honesty check and must never be empty.
    expect(report.not_covered.join(' ')).toMatch(/Litestream/);

    // Isolation, observed rather than assumed: the restored copy can reach no
    // remote, and the source instance is untouched.
    expect(check(report, 'isolation.remotes').status).toBe('pass');
    expect(git(join(liveRoot, 'main'), 'status', '--porcelain')).toBe('');
    expect(existsSync(join(report.target, 'RESTORED-BY-DRILL.txt'))).toBe(true);
  }, 180_000);

  it('FAILS when an asset\'s bytes are missing from the backup', async () => {
    const mutant = copyBackup();
    const assetsDir = join(mutant, 'content', 'main', 'assets');
    expect(existsSync(join(assetsDir, assetFile))).toBe(true);
    // The bytes go; the `.meta.json` descriptor stays. That is exactly the
    // ADR-0003 shape a restore must surface rather than swallow: git carries
    // the descriptor, and whether it carries the bytes is a placement policy.
    rmSync(join(assetsDir, assetFile));

    const report = await runRestoreDrill({ backupDir: mutant, target: temp('e3-drill-target-'), keep: true, log: SILENT });

    expect(report.ok).toBe(false);
    const assets = check(report, 'assets');
    expect(assets.status).toBe('fail');
    expect(assets.detail).toContain(assetFile);
    // The DB is fine, so the failure is attributed to the right part.
    expect(check(report, 'db.integrity_check').status).toBe('pass');
  }, 180_000);

  it('FAILS when the backed-up database is corrupt', async () => {
    const mutant = copyBackup();
    const db = join(mutant, 'kp.sqlite');
    // Truncate to the first few pages: the header still says how big the
    // database should be, so SQLite reports a malformed image rather than a
    // small but valid one. Then re-stamp the manifest digest, so the drill's
    // damaged-artifact guard does not short-circuit the check under test.
    const size = statSync(db).size;
    truncateSync(db, Math.max(4096, Math.floor(size * 0.4)));
    restampDigest(mutant, db);

    const report = await runRestoreDrill({ backupDir: mutant, target: temp('e3-drill-target-'), keep: true, log: SILENT });

    expect(report.ok).toBe(false);
    // The file may refuse to open, fail integrity_check, or come back with a
    // short row census — a corrupt database must not slip through all three.
    const named = report.checks.filter((c) => c.id.startsWith('db.') && c.status === 'fail');
    expect(named.length).toBeGreaterThan(0);
    // And a broken database is never booted and called verified.
    expect(check(report, 'functional').status).toBe('skip');
  }, 180_000);

  it('FAILS when a restored working tree is not the tree that was captured', async () => {
    const mutant = copyBackup();
    // An uncommitted edit in the backup: the manifest says this tree was clean,
    // so the restore no longer reproduces the captured state.
    const concepts = join(mutant, 'content', 'main', 'ops', 'concepts');
    const file = readdirSync(concepts)[0]!;
    writeFileSync(join(concepts, file), `${readFileSync(join(concepts, file), 'utf8')}\nTampered.\n`, 'utf8');

    const report = await runRestoreDrill({ backupDir: mutant, target: temp('e3-drill-target-'), keep: true, log: SILENT });

    expect(report.ok).toBe(false);
    expect(check(report, 'git.main').status).toBe('fail');
    expect(check(report, 'git.main').detail).toMatch(/differs from capture/);
  }, 180_000);

  it('refuses to restore anywhere that could touch live data', async () => {
    // Inside the live content root — the mistake that would turn a rehearsal
    // into an incident.
    await expect(
      runRestoreDrill({ backupDir, target: join(liveRoot, 'restore-here'), log: SILENT }),
    ).rejects.toThrow(/overlaps/);
    // And into the backup it is restoring from.
    await expect(runRestoreDrill({ backupDir, target: join(backupDir, 'here'), log: SILENT })).rejects.toThrow(/overlaps/);
    // A non-empty target is not a fresh instance.
    const occupied = temp('e3-drill-occupied-');
    writeFileSync(join(occupied, 'something.txt'), 'in the way', 'utf8');
    await expect(runRestoreDrill({ backupDir, target: occupied, log: SILENT })).rejects.toThrow(/not empty/);
    // None of that wrote anything into the live root.
    expect(existsSync(join(liveRoot, 'restore-here'))).toBe(false);
    expect(git(join(liveRoot, 'main'), 'status', '--porcelain')).toBe('');
  }, 120_000);

  it('refuses a backup whose database was damaged at rest', async () => {
    const mutant = copyBackup();
    truncateSync(join(mutant, 'kp.sqlite'), 1024); // digest no longer matches the manifest
    await expect(runRestoreDrill({ backupDir: mutant, target: temp('e3-drill-target-'), log: SILENT })).rejects.toThrow(
      /digest does not match/,
    );
  }, 120_000);
});

/** Re-stamp `db.sha256`/`db.bytes` after deliberately damaging a backup's database. */
function restampDigest(backupDir: string, dbPath: string): void {
  const manifestPath = join(backupDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    db: { sha256: string; bytes: number };
  };
  manifest.db.sha256 = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  manifest.db.bytes = statSync(dbPath).size;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
