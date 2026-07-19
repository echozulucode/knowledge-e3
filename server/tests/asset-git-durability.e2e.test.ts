/**
 * Asset durability: an upload or delete must reach git even with NO concurrent
 * page edit (ADR-0003, phase 2 / the §5.2 bug).
 *
 * Before the fix, the git mirror only committed when a page edit was pending, and
 * `git add -- assets` rode along inside that commit. An asset-only change was
 * written to disk but never committed — so on the cloud demo (where the git push
 * is the only backup path for bytes) an uploaded file would not survive a
 * revision restart, and a deletion never stuck across a rebuild.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

describe('asset git durability', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let dir: string;
  let adapter: GitRevisionMirrorAdapter;

  beforeEach(async () => {
    app = await makeApp();
    await seedAdminAndLogin(app);
    db = app.get<Kysely<Database>>(KYSELY);
    dir = mkdtempSync(join(tmpdir(), 'e3-asset-git-'));
    adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Simulate AssetsService writing bytes + sidecar into the working tree. */
  function putAsset(file: string, bytes: Buffer): void {
    const assetsDir = join(dir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, file), bytes);
    writeFileSync(join(assetsDir, `${file}.meta.json`), JSON.stringify({ file }), 'utf8');
  }

  it('commits an asset-only upload (no page edit)', async () => {
    putAsset('abc123.png', Buffer.from('PNGDATA'));

    await adapter.notifyAssetsChanged();
    await adapter.flush();

    // The bytes AND the sidecar are tracked in git — durable, not just on disk.
    const tracked = git(dir, 'ls-files', '--', 'assets').trim().split('\n').filter(Boolean);
    expect(tracked).toContain('assets/abc123.png');
    expect(tracked).toContain('assets/abc123.png.meta.json');

    const log = git(dir, 'log', '--oneline');
    expect(log).toContain('update assets');
  });

  it('commits an asset deletion so it sticks across a rebuild', async () => {
    putAsset('todelete.png', Buffer.from('BYTES'));
    await adapter.notifyAssetsChanged();
    await adapter.flush();
    expect(git(dir, 'ls-files', '--', 'assets')).toContain('assets/todelete.png');

    // Remove the bytes + sidecar (as AssetsService.remove does) and signal again.
    rmSync(join(dir, 'assets', 'todelete.png'));
    rmSync(join(dir, 'assets', 'todelete.png.meta.json'));
    await adapter.notifyAssetsChanged();
    await adapter.flush();

    // The working tree is clean (the deletion was committed, not left pending).
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
    expect(git(dir, 'ls-files', '--', 'assets').trim()).toBe('');
    expect(existsSync(join(dir, 'assets', 'todelete.png'))).toBe(false);
  });

  it('is a no-op when nothing actually changed', async () => {
    // A signal with no on-disk change must not create an empty commit.
    await adapter.notifyAssetsChanged();
    await adapter.flush();
    // A brand-new repo with nothing committed has no HEAD — that's the "no commit" state.
    let hasCommit = true;
    try {
      git(dir, 'rev-parse', 'HEAD');
    } catch {
      hasCommit = false;
    }
    expect(hasCommit).toBe(false);
  });
});
