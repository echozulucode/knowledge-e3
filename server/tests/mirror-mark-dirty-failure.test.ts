/**
 * A mirror BOOKKEEPING failure must degrade bookkeeping, not the commit
 * (issue 101).
 *
 * `enqueue` writes the concept file, then records `revision_mirror_state`
 * (`markDirty`), then schedules the debounced commit. `markDirty` has a foreign
 * key to `pages`; when it threw, the best-effort catch swallowed the error AND
 * skipped `scheduleCommit()`, so the file sat on disk and never reached git
 * until something else in that repo happened to schedule a commit.
 *
 * The event below names an item with no `pages` row, which is exactly the FK
 * violation that surfaced it. No explicit `flush()` — that would commit the
 * pending batch regardless and hide the bug; the debounce timer has to fire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';

describe('git mirror: a markDirty failure', () => {
  let app: INestApplication;
  let dir: string;
  let adapter: GitRevisionMirrorAdapter | undefined;

  afterEach(async () => {
    // Stop the adapter first: its debounce timer and git child processes hold
    // the temp repo open, and Windows refuses to delete a directory in use
    // (EPERM here, 2026-09-13 — the same class as lesson 77's sync-engine flake).
    await adapter?.onModuleDestroy();
    adapter = undefined;
    await app?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('still schedules the commit for that write', async () => {
    app = await makeApp();
    const db = app.get<Kysely<Database>>(KYSELY);
    dir = mkdtempSync(join(tmpdir(), 'e3-mark-dirty-'));
    adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });

    const now = new Date().toISOString();
    await adapter.enqueue(
      {
        itemId: 'item_with_no_pages_row',
        versionId: 'ver_orphan_1',
        versionToken: 1,
        actorId: 'system',
        title: 'orphan',
        slug: 'orphan',
        rawMarkdown: 'body of orphan',
        status: 'published' as const,
        spaceId: null,
        ownerId: null,
        tags: [],
        categories: [],
        groups: [],
        createdAt: now,
        updatedAt: now,
      },
      'concepts',
    );

    // Precondition: the file landed and the bookkeeping write really failed.
    expect(existsSync(join(dir, 'concepts', 'orphan.md'))).toBe(true);
    const state = await db
      .selectFrom('revision_mirror_state')
      .selectAll()
      .where('page_id', '=', 'item_with_no_pages_row')
      .executeTakeFirst();
    expect(state).toBeUndefined();

    const tracked = (): string => {
      try {
        return execFileSync('git', ['-C', dir, 'ls-files', 'concepts/orphan.md'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return '';
      }
    };
    const deadline = Date.now() + 10_000;
    let committed = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      committed = tracked();
      if (committed) break;
    }
    expect(committed.trim()).toBe('concepts/orphan.md');
  });
});
