/**
 * Durable outbox for the write-first path (plan §7.3): one row per indexed file
 * change, written in the SAME transaction as the index, drained by the git
 * mirror (which marks rows processed once the file is committed). A pending
 * row therefore means "canonical file on disk, index updated, commit not yet
 * confirmed" — exactly what a restart must replay.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { ContentOutboxTable, Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';

export interface OutboxRowInput {
  kind: ContentOutboxTable['kind'];
  page_id: string;
  source_id: string | null;
  file_path: string | null;
  file_digest: string | null;
  actor_id: string | null;
}

/**
 * One file a commit pass confirmed, as the git mirror reports it. `path` is the
 * repo-relative path that was committed; `null` when the confirmer has no repo
 * (the no-op mirror), which settles every pending row for the page.
 */
export interface CommittedFile {
  pageId: string;
  path: string | null;
}

/** Insert an outbox row inside the caller's transaction (plain function so PagesService needs no DI on this). */
export async function enqueueOutboxInTx(tx: Transaction<Database> | Kysely<Database>, row: OutboxRowInput): Promise<void> {
  await tx
    .insertInto('content_outbox')
    .values({ id: newId(), ...row, created_at: nowIso(), processed_at: null, error: null })
    .execute();
}

@Injectable()
export class OutboxService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  enqueueInTx(tx: Transaction<Database> | Kysely<Database>, row: OutboxRowInput): Promise<void> {
    return enqueueOutboxInTx(tx, row);
  }

  /**
   * Enqueue a row on its own connection, for a change that has no transaction of
   * its own to ride: the `move` row recording that a file left a source. It is
   * written AFTER the index transaction that landed the item at its new path,
   * so a pending row still means "index updated, commit not yet confirmed".
   */
  enqueue(row: OutboxRowInput): Promise<void> {
    return enqueueOutboxInTx(this.db, row);
  }

  /**
   * Mark the pending rows a commit pass confirmed as processed: for each page,
   * the rows whose `file_path` the pass actually committed (a row with no path
   * always settles). The `created_at <= at` bound keeps a row enqueued after the
   * committer took its snapshot pending until the next commit picks it up.
   *
   * The path scope is what makes a **move** honest: the two ends of a move live
   * in different repositories and commit on their own timers, so the target
   * repo's commit must not settle the source repo's `move` row (and vice versa).
   * A confirmation with `path: null` — the no-op mirror, which has no repo and
   * therefore nothing to wait for — settles every pending row for the page, the
   * behaviour this method had before paths were tracked.
   */
  async markProcessed(committed: CommittedFile[], at: string): Promise<void> {
    if (committed.length === 0) return;
    // null wins over any set of paths: it means "everything for this page".
    const byPage = new Map<string, Set<string> | null>();
    for (const { pageId, path } of committed) {
      const known = byPage.get(pageId);
      if (known === null) continue;
      if (path === null || path === undefined) {
        byPage.set(pageId, null);
        continue;
      }
      if (known) known.add(path);
      else byPage.set(pageId, new Set([path]));
    }
    for (const [pageId, paths] of byPage) {
      let q = this.db
        .updateTable('content_outbox')
        .set({ processed_at: at })
        .where('page_id', '=', pageId)
        .where('processed_at', 'is', null)
        .where('created_at', '<=', at);
      if (paths) {
        const list = [...paths];
        q = q.where((eb) => eb.or([eb('file_path', 'in', list), eb('file_path', 'is', null)]));
      }
      await q.execute();
    }
  }

  /** Pending rows, oldest first. */
  async pending(limit = 1000): Promise<ContentOutboxTable[]> {
    return this.db
      .selectFrom('content_outbox')
      .selectAll()
      .where('processed_at', 'is', null)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
  }
}
