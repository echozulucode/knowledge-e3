/**
 * Per-edit authorship (§7.1): every commit the git mirror makes must name the
 * person who caused it, so a rebuild-from-git can replay `created_by` and a
 * human reading `git log` sees an editor, not the server.
 *
 * The identity map existed before this file, but nothing pinned it — no test
 * had ever asserted a commit's author — and the asset path dropped the actor
 * outright: an upload committed as `Knowledge E3 <knowledge-e3@localhost>` even
 * though `ImagesService.upload` was handed the uploader's id. These cases cover
 * all four commit sites the adapter has: a page edit, a departure, a deletion,
 * and an asset-only change.
 *
 * The system identity is still the RIGHT answer where no single human owns the
 * commit — a window mixing two uploaders, or a signal with no actor at all
 * (rebuild healing missing bytes) — and the last two cases pin that too, so a
 * later "complete the attribution" change cannot quietly start fabricating one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp } from './helpers.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';

const SYSTEM_AUTHOR = 'Knowledge E3 <knowledge-e3@localhost>';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** `Name <email>` of every commit, newest first. */
function authors(dir: string): string[] {
  return git(dir, 'log', '--format=%an <%ae>').split('\n').filter(Boolean);
}

describe('git mirror: per-edit authorship', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let dir: string;
  let adapter: GitRevisionMirrorAdapter;
  let ada: string;
  let grace: string;

  beforeEach(async () => {
    app = await makeApp();
    db = app.get<Kysely<Database>>(KYSELY);
    const auth = app.get(AuthService);
    ada = (await auth.createUser({ email: 'ada@example.com', username: 'ada', password: 'ada-password-123', role: 'admin' })).id;
    grace = (await auth.createUser({ email: 'grace@example.com', username: 'grace', password: 'grace-password-1', role: 'user' })).id;
    dir = mkdtempSync(join(tmpdir(), 'e3-authorship-'));
    adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function event(actorId: string, slug: string, token = 1) {
    const now = new Date().toISOString();
    return {
      itemId: `item_${slug}`,
      versionId: `ver_${slug}_${token}`,
      versionToken: token,
      actorId,
      title: slug.replace(/-/g, ' '),
      slug,
      rawMarkdown: `body of ${slug} v${token}`,
      status: 'published' as const,
      spaceId: null,
      ownerId: null,
      tags: [],
      categories: [],
      groups: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Simulate AssetsService writing bytes + sidecar into the working tree. */
  function putAsset(file: string, bytes: string): void {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', file), bytes, 'utf8');
    writeFileSync(join(dir, 'assets', `${file}.meta.json`), JSON.stringify({ file }), 'utf8');
  }

  it('a page edit commits under its editor, and two editors in one window get one commit each', async () => {
    await adapter.enqueue(event(ada, 'ada-concept'), 'concepts');
    await adapter.enqueue(event(grace, 'grace-concept'), 'concepts');
    await adapter.flush();

    // One commit per actor in the batch — not one commit under the server.
    expect(authors(dir).sort()).toEqual(['ada <ada@example.com>', 'grace <grace@example.com>']);
  });

  it('a departure and a deletion commit under the actor who caused them', async () => {
    await adapter.enqueue(event(ada, 'leaving'), 'concepts');
    await adapter.enqueue(event(ada, 'doomed'), 'concepts');
    await adapter.flush();

    await adapter.enqueueRemoval(
      { itemId: 'item_leaving', path: 'concepts/leaving.md', actorId: grace, versionToken: 2 },
      'move',
    );
    await adapter.flush();
    await adapter.enqueueRemoval(
      { itemId: 'item_doomed', path: 'concepts/doomed.md', actorId: grace, versionToken: 2 },
      'delete',
    );
    await adapter.flush();

    const log = git(dir, 'log', '--format=%s|%an <%ae>').split('\n').filter(Boolean);
    expect(log[0]).toBe(`knowledge-e3: remove 1 item|grace <grace@example.com>`);
    expect(log[1]).toBe(`knowledge-e3: move 1 item out|grace <grace@example.com>`);
  });

  it('an asset-only change commits under the uploader, not the server', async () => {
    putAsset('aaa111.png', 'PNGDATA');
    await adapter.notifyAssetsChanged(ada);
    await adapter.flush();

    expect(git(dir, 'log', '--oneline')).toContain('update assets');
    expect(authors(dir)).toEqual(['ada <ada@example.com>']);
  });

  it('an asset window shared by two uploaders, or with no actor, stays the system identity', async () => {
    putAsset('bbb222.png', 'FIRST');
    await adapter.notifyAssetsChanged(ada);
    putAsset('ccc333.png', 'SECOND');
    await adapter.notifyAssetsChanged(grace);
    await adapter.flush();
    // A commit has one author; neither of them wrote all of it.
    expect(authors(dir)[0]).toBe(SYSTEM_AUTHOR);

    // An unattributed signal (a rebuild healing missing bytes) poisons the
    // window even when a named uploader shares it — better the honest server
    // identity than crediting bytes to someone who did not write them.
    putAsset('ddd444.png', 'THIRD');
    await adapter.notifyAssetsChanged(ada);
    await adapter.notifyAssetsChanged();
    await adapter.flush();
    expect(authors(dir)[0]).toBe(SYSTEM_AUTHOR);
  });
});
