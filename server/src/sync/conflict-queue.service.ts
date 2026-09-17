/**
 * Conflict queue (plan §8.1): a merge that leaves paths conflicted parks both
 * sides here — the source stays in `conflict` (nothing else syncs for it) until
 * an admin picks "Keep mine", "Keep theirs", or supplies merged content.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SyncStatus } from '@echozedlabs/knowledge-types';
import type { ConflictChoice, LocalGitRepo } from '@echozedlabs/repo-sync';
import { newId, nowIso } from '../common/ids.js';
import { KYSELY } from '../db/db.module.js';
import type { Database, SyncConflictsTable } from '../db/schema.js';
import { InboundIndexService } from './inbound-index.service.js';
import { SourceRegistryService } from './source-registry.service.js';

export type ConflictRow = SyncConflictsTable;

/**
 * A resolved row as the history list wants it: the queue row plus the username
 * of whoever resolved it (`resolved_by` only records the actor id, and users
 * can be deleted, so the join is left and the label may be null).
 */
export interface ResolvedConflictRow extends ConflictRow {
  resolved_by_username: string | null;
}

/** How many resolved rows the history returns when the caller names no limit. */
export const DEFAULT_RESOLVED_LIMIT = 20;
/** Ceiling on the resolved history so the route can never return it unbounded. */
export const MAX_RESOLVED_LIMIT = 100;

/** Resolves one path of a source's conflicted merge — `SyncService` binds its engine here. */
export type ConflictResolver = (sourceId: string, path: string, choice: ConflictChoice) => Promise<SyncStatus>;

@Injectable()
export class ConflictQueueService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly registry: SourceRegistryService,
    private readonly inbound: InboundIndexService,
  ) {}

  private resolver: ConflictResolver | null = null;

  /** Called by `SyncService` at construction; keeps this service free of a dependency on it. */
  bindResolver(resolver: ConflictResolver): void {
    this.resolver = resolver;
  }

  /** Queue every conflicted path with its three sides (from the index stages). */
  async record(sourceId: string, repo: LocalGitRepo, paths: string[]): Promise<void> {
    const now = nowIso();
    for (const path of paths) {
      const sides = await repo.conflictSides(path);
      const page = await this.db
        .selectFrom('pages')
        .select('id')
        .where('source_id', '=', sourceId)
        .where('file_path', '=', path)
        .executeTakeFirst();
      await this.db
        .insertInto('sync_conflicts')
        .values({
          id: newId(),
          source_id: sourceId,
          path,
          page_id: page?.id ?? null,
          ours: sides.ours,
          theirs: sides.theirs,
          base: sides.base,
          detected_at: now,
          resolved_at: null,
          resolution: null,
          resolved_by: null,
        })
        .execute();
    }
  }

  /** Open conflicts (all sources, or one), oldest first. */
  list(sourceId?: string, opts: { includeResolved?: boolean } = {}): Promise<ConflictRow[]> {
    let q = this.db.selectFrom('sync_conflicts').selectAll().orderBy('detected_at', 'asc');
    if (sourceId) q = q.where('source_id', '=', sourceId);
    if (!opts.includeResolved) q = q.where('resolved_at', 'is', null);
    return q.execute();
  }

  /**
   * Resolved conflicts (all sources, or one), newest first and bounded — the
   * history behind the Sources panel's collapsed "Resolved" list. `limit` is
   * clamped to [1, {@link MAX_RESOLVED_LIMIT}] so a caller cannot ask for the
   * whole archive.
   */
  listResolved(sourceId?: string, limit = DEFAULT_RESOLVED_LIMIT): Promise<ResolvedConflictRow[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_RESOLVED_LIMIT, 1), MAX_RESOLVED_LIMIT);
    let q = this.db
      .selectFrom('sync_conflicts')
      .leftJoin('users', 'users.id', 'sync_conflicts.resolved_by')
      .selectAll('sync_conflicts')
      .select('users.username as resolved_by_username')
      .where('sync_conflicts.resolved_at', 'is not', null)
      // `id` breaks ties so two resolutions in the same millisecond stay stable.
      .orderBy('sync_conflicts.resolved_at', 'desc')
      .orderBy('sync_conflicts.id', 'desc')
      .limit(bounded);
    if (sourceId) q = q.where('sync_conflicts.source_id', '=', sourceId);
    return q.execute();
  }

  async get(id: string): Promise<ConflictRow | null> {
    return (await this.db.selectFrom('sync_conflicts').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
  }

  /** Open conflicts per source. */
  async counts(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('sync_conflicts')
      .select(['source_id', (eb) => eb.fn.countAll<number>().as('n')])
      .where('resolved_at', 'is', null)
      .groupBy('source_id')
      .execute();
    return new Map(rows.map((r) => [r.source_id, Number(r.n)]));
  }

  /**
   * Resolve one queued conflict: the engine writes the chosen side (or the
   * supplied content), and once every path of that merge is resolved commits
   * it. `theirs`/manual content is then re-indexed; `ours` leaves the index as
   * it is (the row already reflects our file).
   */
  async resolve(
    id: string,
    choice: 'ours' | 'theirs' | { content: string },
    actorId: string,
  ): Promise<{ conflict: ConflictRow; status: SyncStatus }> {
    const row = await this.get(id);
    if (!row) throw new NotFoundException('Conflict not found');
    if (row.resolved_at) throw new BadRequestException('Conflict is already resolved');
    const source = await this.registry.get(row.source_id);
    if (!source) throw new NotFoundException(`Source ${row.source_id} is no longer registered`);

    if (!this.resolver) throw new BadRequestException('The sync engine is not running');
    const status = await this.resolver(row.source_id, row.path, choice);
    if (choice !== 'ours') {
      await this.inbound.indexPath(source, { path: row.path, change: 'modified' });
    }
    const resolution: ConflictRow['resolution'] = typeof choice === 'object' ? 'manual' : choice;
    const now = nowIso();
    await this.db
      .updateTable('sync_conflicts')
      .set({ resolved_at: now, resolution, resolved_by: actorId })
      .where('id', '=', id)
      .execute();
    return { conflict: { ...row, resolved_at: now, resolution, resolved_by: actorId }, status };
  }
}
