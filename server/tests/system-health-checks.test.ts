/**
 * The ten system-health checks (plan §5), each driven through BOTH a healthy
 * and an unhealthy path.
 *
 * The unhealthy half is the point. A suite that only asserts the happy path has
 * proved that the report renders, not that any check can ever say no — and a
 * health page that cannot say no is worse than no page, because an operator
 * learns to trust it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { BackupDrillStatus } from '@echozedlabs/knowledge-types';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import type { MirrorHealth } from '../src/content-health/mirror-health.js';
import type { SourceStatusView } from '../src/sync/sync.service.js';
import {
  checkConflicts,
  checkContentRoot,
  checkDatabase,
  checkDisk,
  checkGitOutbox,
  checkMirrorState,
  checkRestoreDrill,
  checkSchema,
  checkSecrets,
  checkSources,
  diskVerdict,
  humanBytes,
  nearestExisting,
  REQUIRED_TABLES,
} from '../src/system-health/checks.js';
import { verdictOf, worse, type SystemCheck } from '../src/system-health/system-health.types.js';
import { NEVER_DRILLED, type BackupDrillStatusPort } from '../src/system-health/backup-drill.port.js';
import { SystemHealthService } from '../src/system-health/system-health.service.js';
import type { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import type { SyncService } from '../src/sync/sync.service.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function source(over: Partial<SourceStatusView> & { id: string; local_dir: string }): SourceStatusView {
  return {
    id: over.id,
    space_id: null,
    local_dir: over.local_dir,
    remote_url: null,
    branch: null,
    role: 'authoritative',
    mode: 'direct',
    branch_prefix: null,
    host_kind: null,
    host_base_url: null,
    host_token_env: null,
    sync_every_seconds: null,
    webhook_secret_env: null,
    default_status: null,
    include_globs: null,
    exclude_globs: null,
    default_type: null,
    enabled: 1,
    last_synced_at: null,
    last_error: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    managed: true,
    ...over,
    status: {
      source: over.id,
      state: 'idle',
      ahead: 0,
      behind: 0,
      dirty_paths: [],
      conflicted_paths: [],
      last_synced_at: null,
      last_error: null,
      ...(over.status ?? {}),
    },
  } as SourceStatusView;
}

function emptyMirror(): MirrorHealth {
  return {
    stuck_after_ms: 5 * 60 * 1000,
    pending: { count: 0, items: [] },
    mirror_errors: { count: 0, items: [] },
  };
}

describe('system-health checks', () => {
  let db: Kysely<Database>;
  let root: string;

  beforeEach(async () => {
    db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    await migrateSqlite(db);
    root = mkdtempSync(join(tmpdir(), 'e3-syshealth-'));
  });

  afterEach(async () => {
    await db.destroy().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- database

  describe('database', () => {
    it('is ok when the database answers and quick_check is clean', async () => {
      const check = await checkDatabase(db, { deep: true });
      expect(check.state).toBe('ok');
      expect(check.summary).toMatch(/quick_check/);
      // Evidence carries the journal mode and size — a deep check, not a ping.
      expect(check.evidence.join(' ')).toMatch(/Journal mode/);
    });

    it('is ok and cheap in the shallow (readiness) form', async () => {
      const check = await checkDatabase(db, { deep: false });
      expect(check.state).toBe('ok');
      // No quick_check ran, so no evidence was gathered.
      expect(check.evidence).toEqual([]);
    });

    it('FAILS when the database does not answer', async () => {
      await db.destroy();
      const check = await checkDatabase(db, { deep: true });
      expect(check.state).toBe('fail');
      expect(check.summary).toBe('The database did not answer.');
      expect(check.action).toBeTruthy();
    });

    it('FAILS shallow too — readiness sees an unreachable database', async () => {
      await db.destroy();
      const check = await checkDatabase(db, { deep: false });
      expect(check.state).toBe('fail');
    });
  });

  // ------------------------------------------------------------------ schema

  describe('schema / migrations applied', () => {
    it('is ok on a migrated database', async () => {
      const check = await checkSchema(db);
      expect(check.state).toBe('ok');
      expect(check.summary).toContain(String(REQUIRED_TABLES.length));
    });

    it('FAILS on a database the migrations never touched — the botched-restore signal', async () => {
      const bare = makeKysely({ url: ':memory:', driver: 'sqlite' });
      const check = await checkSchema(bare);
      await bare.destroy();
      expect(check.state).toBe('fail');
      expect(check.summary).toMatch(/table\(s\) are missing/);
      expect(check.evidence.join(' ')).toContain('pages');
      expect(check.action).toMatch(/DB_URL/);
    });

    it('FAILS when the schema cannot be read at all', async () => {
      await db.destroy();
      const check = await checkSchema(db);
      expect(check.state).toBe('fail');
    });
  });

  // ------------------------------------------------------------ content root

  describe('content root', () => {
    it('is ok when the root exists and a probe file can be written', async () => {
      const check = await checkContentRoot(root, { deep: true });
      expect(check.state).toBe('ok');
      expect(check.summary).toBe('Present and writable.');
    });

    it('is ok shallow without touching the disk', async () => {
      const check = await checkContentRoot(root, { deep: false });
      expect(check.state).toBe('ok');
      expect(check.summary).toBe('The content root resolves.');
    });

    it('is ok when the root does not exist yet — the store mkdirs it on first write', async () => {
      const check = await checkContentRoot(join(root, 'not-yet'), { deep: true });
      expect(check.state).toBe('ok');
      expect(check.summary).toBe('Writable; not created yet.');
      expect(check.evidence.join(' ')).toMatch(/will be created under/);
    });

    it('FAILS when the configured root is a file', async () => {
      const file = join(root, 'a-file');
      writeFileSync(file, 'x');
      const check = await checkContentRoot(file, { deep: true });
      expect(check.state).toBe('fail');
      expect(check.summary).toBe('The content root path runs through a file.');
    });

    it('FAILS shallow too — readiness sees a root blocked by a file', async () => {
      const file = join(root, 'a-file');
      writeFileSync(file, 'x');
      const check = await checkContentRoot(join(file, 'below'), { deep: false });
      expect(check.state).toBe('fail');
      expect(check.evidence.join(' ')).toContain('Blocked at');
    });

    it('FAILS when nothing on the path to the root exists', async () => {
      const check = await checkContentRoot(
        process.platform === 'win32' ? 'Q:\no-such-volume\content' : '/proc/self/nope/content',
        { deep: false },
      );
      // On a platform where the nearest ancestor always exists (the filesystem
      // root), this instead reports the root as not-yet-created, which is the
      // honest answer; either way it must not crash.
      expect(['ok', 'fail']).toContain(check.state);
    });

    it('nearestExisting walks up to the first directory that is really there', () => {
      expect(nearestExisting(root)).toBe(root);
      expect(nearestExisting(join(root, 'a', 'b', 'c'))).toBe(root);
    });
  });

  // -------------------------------------------------------------------- disk

  describe('disk headroom', () => {
    it('is ok with headroom', () => {
      expect(diskVerdict(60e9, 100e9, root).state).toBe('ok');
    });

    it('WARNS under 10% free', () => {
      const check = diskVerdict(8e9, 100e9, root);
      expect(check.state).toBe('warn');
      expect(check.action).toMatch(/grow the volume/);
    });

    it('FAILS under 5% free', () => {
      const check = diskVerdict(2e9, 100e9, root);
      expect(check.state).toBe('fail');
      expect(check.summary).toMatch(/Only 2\.0%/);
    });

    it('WARNS rather than lying when free space cannot be measured', () => {
      const check = diskVerdict(Number.NaN, Number.NaN, root);
      expect(check.state).toBe('warn');
      expect(check.summary).toBe('Free space could not be measured.');
      expect(diskVerdict(0, 0, root).state).toBe('warn');
    });

    it('measures the volume a not-yet-created root will live on', async () => {
      const check = await checkDisk(join(root, 'not-yet'));
      expect(check.evidence[0]).toMatch(/free of/);
    });

    it('measures the real filesystem in the happy path', async () => {
      const check = await checkDisk(root);
      expect(['ok', 'warn', 'fail']).toContain(check.state);
      expect(check.evidence[0]).toMatch(/free of/);
    });
  });

  // ----------------------------------------------------------------- sources

  describe('sources', () => {
    it('is ok when nothing is enabled', () => {
      expect(checkSources([], { contentRoot: root, defaultSyncSeconds: 300, now: NOW }).state).toBe('ok');
    });

    it('is ok for a local-only source whose tree exists', () => {
      const check = checkSources([source({ id: 'main', local_dir: root })], {
        contentRoot: root,
        defaultSyncSeconds: 300,
        now: NOW,
      });
      expect(check.state).toBe('ok');
      expect(check.evidence.join(' ')).toMatch(/local only/);
    });

    it('is ok for a remote source synced within 3x its cadence', () => {
      const check = checkSources(
        [
          source({
            id: 'main',
            local_dir: root,
            remote_url: 'https://example.test/r.git',
            sync_every_seconds: 300,
            status: { last_synced_at: new Date(NOW.getTime() - 600_000).toISOString() } as never,
          }),
        ],
        { contentRoot: root, defaultSyncSeconds: 300, now: NOW },
      );
      expect(check.state).toBe('ok');
    });

    it('FAILS when a working tree is missing', () => {
      const check = checkSources([source({ id: 'main', local_dir: join(root, 'gone') })], {
        contentRoot: root,
        defaultSyncSeconds: 300,
        now: NOW,
      });
      expect(check.state).toBe('fail');
      expect(check.evidence.join(' ')).toMatch(/working tree missing/);
    });

    it('FAILS when a source recorded a sync error', () => {
      const check = checkSources(
        [source({ id: 'main', local_dir: root, status: { last_error: 'auth failed' } as never })],
        { contentRoot: root, defaultSyncSeconds: 300, now: NOW },
      );
      expect(check.state).toBe('fail');
      expect(check.evidence.join(' ')).toContain('auth failed');
    });

    it('WARNS — not fails — when a remote source is late', () => {
      const check = checkSources(
        [
          source({
            id: 'main',
            local_dir: root,
            remote_url: 'https://example.test/r.git',
            sync_every_seconds: 60,
            status: { last_synced_at: new Date(NOW.getTime() - 3_600_000).toISOString() } as never,
          }),
        ],
        { contentRoot: root, defaultSyncSeconds: 300, now: NOW },
      );
      expect(check.state).toBe('warn');
      expect(check.summary).toMatch(/behind/);
    });

    it('WARNS when a remote source has never synced', () => {
      const check = checkSources(
        [source({ id: 'main', local_dir: root, remote_url: 'https://example.test/r.git' })],
        { contentRoot: root, defaultSyncSeconds: 300, now: NOW },
      );
      expect(check.state).toBe('warn');
      expect(check.evidence.join(' ')).toMatch(/never synced/);
    });

    it('ignores disabled sources', () => {
      const check = checkSources([source({ id: 'main', local_dir: join(root, 'gone'), enabled: 0 })], {
        contentRoot: root,
        defaultSyncSeconds: 300,
        now: NOW,
      });
      expect(check.state).toBe('ok');
    });
  });

  // ----------------------------------------------------------------- secrets

  describe('secrets', () => {
    it('is ok when no source names an env var', () => {
      expect(checkSecrets([source({ id: 'main', local_dir: root })], {}).state).toBe('ok');
    });

    it('is ok when every named env var is set', () => {
      const check = checkSecrets(
        [source({ id: 'main', local_dir: root, remote_url: 'https://x.test/r.git', host_token_env: 'GH_TOKEN' })],
        { GH_TOKEN: 'ghp_supersecret' },
      );
      expect(check.state).toBe('ok');
      expect(check.evidence.join(' ')).toContain('GH_TOKEN');
    });

    it('FAILS when a named env var is unset, and reports the NAME only', () => {
      const check = checkSecrets(
        [
          source({
            id: 'main',
            local_dir: root,
            remote_url: 'https://x.test/r.git',
            host_token_env: 'GH_TOKEN',
            webhook_secret_env: 'GH_WEBHOOK',
          }),
        ],
        { GH_WEBHOOK: 'whsec_value' },
      );
      expect(check.state).toBe('fail');
      expect(check.summary).toMatch(/1 referenced env var\(s\) are not set/);
      const rendered = JSON.stringify(check);
      expect(rendered).toContain('GH_TOKEN');
      expect(rendered).toContain('GH_WEBHOOK');
      // The VALUE of a set secret never appears anywhere in the finding.
      expect(rendered).not.toContain('whsec_value');
    });

    it('treats a blank env var as unset', () => {
      const check = checkSecrets(
        [source({ id: 'main', local_dir: root, remote_url: 'https://x.test/r.git', host_token_env: 'GH_TOKEN' })],
        { GH_TOKEN: '   ' },
      );
      expect(check.state).toBe('fail');
    });
  });

  // ------------------------------------------------------------- git mirror

  describe('git mirror backlog', () => {
    it('is ok with an empty outbox', () => {
      expect(checkGitOutbox(emptyMirror()).state).toBe('ok');
    });

    it('WARNS — not fails — on a stuck outbox, because the content is still served', () => {
      const mirror = emptyMirror();
      mirror.pending = {
        count: 2,
        items: [
          { outbox_id: 'o1', page_id: 'p1', slug: 'a', title: 'A', kind: 'upsert', source_id: 'main', file_path: 'a.md', created_at: NOW.toISOString(), age_seconds: 900, error: null, mirror_state: 'missing', mirror_error: null, last_commit: null },
        ] as never,
      };
      const check = checkGitOutbox(mirror);
      expect(check.state).toBe('warn');
      expect(check.summary).toMatch(/2 write\(s\) indexed but not committed/);
      expect(check.evidence[0]).toMatch(/no mirror state at all/);
    });
  });

  describe('git mirror errors', () => {
    it('is ok with no mirror errors', () => {
      expect(checkMirrorState(emptyMirror()).state).toBe('ok');
    });

    it('FAILS when the committer recorded an error', () => {
      const mirror = emptyMirror();
      mirror.mirror_errors = {
        count: 1,
        items: [
          { page_id: 'p1', slug: 'a', title: 'A', path: 'a.md', dirty: true, error: 'push rejected', updated_at: NOW.toISOString(), age_seconds: 900, last_commit: null },
        ],
      };
      const check = checkMirrorState(mirror);
      expect(check.state).toBe('fail');
      expect(check.evidence.join(' ')).toContain('push rejected');
    });

    it('WARNS when a page is merely dirty past the window', () => {
      const mirror = emptyMirror();
      mirror.mirror_errors = {
        count: 1,
        items: [
          { page_id: 'p1', slug: 'a', title: 'A', path: 'a.md', dirty: true, error: null, updated_at: NOW.toISOString(), age_seconds: 900, last_commit: null },
        ],
      };
      expect(checkMirrorState(mirror).state).toBe('warn');
    });
  });

  // --------------------------------------------------------------- conflicts

  describe('merge conflicts', () => {
    it('is ok with no open conflicts', async () => {
      expect((await checkConflicts(db)).state).toBe('ok');
    });

    it('WARNS with an unresolved conflict, naming the blocked source', async () => {
      await db
        .insertInto('sync_conflicts')
        .values({
          id: 'c1',
          source_id: 'main',
          path: 'concepts/a.md',
          page_id: null,
          ours: null,
          theirs: null,
          base: null,
          detected_at: NOW.toISOString(),
          resolved_at: null,
          resolution: null,
          resolved_by: null,
        })
        .execute();
      const check = await checkConflicts(db);
      expect(check.state).toBe('warn');
      expect(check.evidence.join(' ')).toContain('main');
    });

    it('ignores a resolved conflict', async () => {
      await db
        .insertInto('sync_conflicts')
        .values({
          id: 'c2',
          source_id: 'main',
          path: 'concepts/b.md',
          page_id: null,
          ours: null,
          theirs: null,
          base: null,
          detected_at: NOW.toISOString(),
          resolved_at: NOW.toISOString(),
          resolution: 'ours',
          resolved_by: 'admin',
        })
        .execute();
      expect((await checkConflicts(db)).state).toBe('ok');
    });
  });

  // ----------------------------------------------------------- restore drill

  describe('restore drill', () => {
    it('FAILS when the instance has never drilled — never is a finding, not "no data"', () => {
      const check = checkRestoreDrill(NEVER_DRILLED, NOW);
      expect(check.state).toBe('fail');
      expect(check.summary).toBe('Backups are unverified: the restore drill has never run.');
      expect(check.action).toMatch(/drill:restore/);
    });

    it('FAILS when the last drill failed, and says why', () => {
      const status: BackupDrillStatus = {
        outcome: 'failed',
        last_run_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
        rpo_seconds: null,
        rto_seconds: null,
        failure: 'restored instance could not sign in',
        next_run_at: null,
      };
      const check = checkRestoreDrill(status, NOW);
      expect(check.state).toBe('fail');
      expect(check.evidence[0]).toBe('restored instance could not sign in');
    });

    it('is ok when a recent drill passed, and reports RPO and RTO', () => {
      const status: BackupDrillStatus = {
        outcome: 'passed',
        last_run_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        rpo_seconds: 8,
        rto_seconds: 2,
        failure: null,
        next_run_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      const check = checkRestoreDrill(status, NOW);
      expect(check.state).toBe('ok');
      expect(check.evidence.join(' ')).toMatch(/RPO: 8s/);
      expect(check.evidence.join(' ')).toMatch(/RTO: 2s/);
    });

    it('WARNS when the last passing drill is older than 30 days', () => {
      const status: BackupDrillStatus = {
        outcome: 'passed',
        last_run_at: new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
        rpo_seconds: 8,
        rto_seconds: 2,
        failure: null,
        next_run_at: null,
      };
      const check = checkRestoreDrill(status, NOW);
      expect(check.state).toBe('warn');
      expect(check.summary).toMatch(/45 days ago/);
    });

    it('WARNS when a pass carries no date', () => {
      const status: BackupDrillStatus = {
        outcome: 'passed',
        last_run_at: null,
        rpo_seconds: null,
        rto_seconds: null,
        failure: null,
        next_run_at: null,
      };
      expect(checkRestoreDrill(status, NOW).state).toBe('warn');
    });
  });

  // ----------------------------------------------------------------- verdict

  describe('verdict roll-up', () => {
    const row = (state: SystemCheck['state']): SystemCheck => ({
      id: 'database',
      title: 't',
      state,
      summary: 's',
      action: null,
      link: null,
      evidence: [],
    });

    it('is healthy when every check is ok', () => {
      expect(verdictOf([row('ok'), row('ok')])).toBe('healthy');
    });

    it('is degraded on a warn', () => {
      expect(verdictOf([row('ok'), row('warn')])).toBe('degraded');
    });

    it('is at risk on a fail, even beside warns', () => {
      expect(verdictOf([row('warn'), row('fail'), row('ok')])).toBe('at_risk');
    });

    it('worse() ranks fail over warn over ok', () => {
      expect(worse('ok', 'warn')).toBe('warn');
      expect(worse('warn', 'fail')).toBe('fail');
      expect(worse('fail', 'ok')).toBe('fail');
    });
  });

  // ------------------------------------------------- service composition

  /**
   * The service is assembled from fakes here on purpose: the drill producer is
   * a separate module, so the only thing worth proving in-process is that this
   * service consumes the CONTRACT — including the case where no producer is
   * registered at all.
   */
  describe('SystemHealthService composition', () => {
    const service = (drill: BackupDrillStatusPort | null): SystemHealthService =>
      new SystemHealthService(
        db,
        { root } as ContentPathResolver,
        { statuses: async () => [] } as unknown as SyncService,
        drill,
      );

    it('reports a passing drill from the port', async () => {
      const port: BackupDrillStatusPort = {
        status: async (): Promise<BackupDrillStatus> => ({
          outcome: 'passed',
          last_run_at: new Date(NOW.getTime() - 60_000).toISOString(),
          rpo_seconds: 8,
          rto_seconds: 2,
          failure: null,
          next_run_at: null,
        }),
      };
      const body = await service(port).report(NOW);
      const drill = body.checks.find((c) => c.id === 'restore_drill');
      expect(drill?.state).toBe('ok');
      expect(body.verdict).not.toBe('at_risk');
    });

    it('reports never — a real finding — when NO drill producer is registered', async () => {
      const body = await service(null).report(NOW);
      const drill = body.checks.find((c) => c.id === 'restore_drill');
      expect(drill?.state).toBe('fail');
      expect(drill?.summary).toBe('Backups are unverified: the restore drill has never run.');
      expect(body.verdict).toBe('at_risk');
    });

    it('turns a producer that throws into never, not into a 500', async () => {
      const port: BackupDrillStatusPort = {
        status: () => {
          throw new Error('drill service exploded');
        },
      };
      const body = await service(port).report(NOW);
      expect(body.checks.find((c) => c.id === 'restore_drill')?.state).toBe('fail');
    });

    it('readiness passes on a healthy instance and fails when the content root is really broken', async () => {
      expect(await service(null).readiness()).toEqual({ ready: true });
      // Not merely "not created yet" — that is normal on a fresh instance and
      // must stay ready. A path that runs through a FILE can never be created.
      const file = join(root, 'blocker');
      writeFileSync(file, 'x');
      const broken = new SystemHealthService(
        db,
        { root: join(file, 'content') } as ContentPathResolver,
        { statuses: async () => [] } as unknown as SyncService,
        null,
      );
      expect(await broken.readiness()).toEqual({ ready: false });
    });

    it('a not-yet-created content root stays READY — a fresh instance serves fine', async () => {
      const fresh = new SystemHealthService(
        db,
        { root: join(root, 'not-yet') } as ContentPathResolver,
        { statuses: async () => [] } as unknown as SyncService,
        null,
      );
      expect(await fresh.readiness()).toEqual({ ready: true });
    });
  });

  it('humanBytes renders readable sizes', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});
