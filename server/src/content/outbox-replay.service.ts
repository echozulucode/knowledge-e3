/**
 * On start-up, re-emit the mirror event for every item whose outbox row is
 * still pending (plan §7.3): the file is on disk and indexed, but the process
 * stopped before the commit was confirmed. The adapter marks the rows once it
 * has committed (or found the file already at HEAD).
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { isTest } from '../config/server-config.js';
import { ItemsService } from '../items/items.service.js';
import { PagesService } from '../pages/pages.service.js';
import { ContentCommandsService } from './content-commands.service.js';
import { OutboxService } from './outbox.service.js';

@Injectable()
export class OutboxReplayService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxReplayService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly pages: PagesService,
    private readonly items: ItemsService,
    private readonly content: ContentCommandsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (isTest() && process.env['KNOWLEDGE_E3_OUTBOX_REPLAY'] !== '1') return;
    await this.replay().catch((err) => this.logger.warn(`outbox replay failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * Replay pending rows oldest first: one arrival event per page (its current
   * state), plus one removal per pending `move` or `delete` row — the file a
   * relocating write left behind, or the file a soft delete unlinked, whose
   * removal the repo has not committed yet. Either is keyed by path, not by
   * page: a departure commits in a different repo than the page's own, and a
   * deleted page has no arrival event at all. Returns the number of pages
   * re-emitted.
   */
  async replay(): Promise<{ replayed: number }> {
    const rows = await this.outbox.pending();
    const seen = new Set<string>();
    const removals = new Set<string>();
    // Pages whose arrival is still the target half of an uncommitted move, so
    // the re-emitted event keeps the `e3-move-in` trailer on its commit.
    const moving = new Set(rows.filter((r) => r.kind === 'move').map((r) => r.page_id));
    for (const row of rows) {
      if (row.kind === 'move' || row.kind === 'delete') {
        const { page_id: pageId, source_id: sourceId, file_path: path } = row;
        if (!sourceId || !path || removals.has(path)) continue;
        removals.add(path);
        const actorId = row.actor_id ?? 'system';
        if (row.kind === 'move') await this.content.replayMovedOut(pageId, sourceId, path, actorId);
        else await this.content.replayRemoved(pageId, sourceId, path, actorId);
        continue;
      }
      if (row.kind !== 'upsert' || seen.has(row.page_id)) continue;
      seen.add(row.page_id);
      const page = await this.pages.getById(row.page_id);
      if (!page) continue; // deleted since; nothing to commit for it here
      await this.items.emitMirror(row.actor_id ?? page.owner_id ?? 'system', page, { movedIn: moving.has(row.page_id) });
    }
    if (seen.size > 0 || removals.size > 0) {
      this.logger.log(`replayed ${seen.size} pending outbox item(s), ${removals.size} removal(s)`);
    }
    return { replayed: seen.size };
  }
}
