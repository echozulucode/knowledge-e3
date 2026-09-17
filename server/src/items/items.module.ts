import { Module } from '@nestjs/common';
import { Kysely } from 'kysely';
import { PagesModule } from '../pages/pages.module.js';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { GitRevisionMirrorAdapter, type MirroredFile } from '../storage/git-revision-mirror.adapter.js';
import { RoutingRevisionMirror } from '../storage/routing-revision-mirror.adapter.js';
import { NoopRevisionMirrorAdapter } from '../storage/noop-revision-mirror.adapter.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';
import { commitWindow, loadServerConfig } from '../config/server-config.js';
import { OutboxService } from '../content/outbox.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';

@Module({
  imports: [PagesModule],
  controllers: [ItemsController],
  providers: [
    ItemsService,
    {
      // Git mirror (ADR-0001), config-file driven with live env overrides:
      //  - GIT_MIRROR_DIR  → a single flat git-of-record repo (legacy override), else
      //  - GIT_MIRROR_ROOT or config `git.root` (when enabled) → topic-first hybrid
      //    routing (main repo + dedicated per-topic), else
      //  - the no-op adapter (DB is the sole store). On by default at ./data/wiki
      //    for normal runs; off under test (see server-config defaults).
      provide: REVISION_MIRROR,
      useFactory: (db: Kysely<Database>, outbox: OutboxService): RevisionMirrorPort => {
        // The write-first outbox (plan §7.3) is drained here: rows flip to
        // processed once the item's file is committed (or at once when there is
        // no repo to commit to).
        const onCommitted = (committed: MirroredFile[], at: string) =>
          outbox.markProcessed(
            committed.map((c) => ({ pageId: c.itemId, path: c.path })),
            at,
          );
        // The commit-debounce window is per-instance (§7.1): an ephemeral-disk
        // cloud demo wants a tighter cap than a laptop self-host, and undefined
        // halves fall through to the adapter's own defaults.
        const opts = { onCommitted, ...commitWindow() };
        const dir = process.env['GIT_MIRROR_DIR'];
        if (dir) return new GitRevisionMirrorAdapter(dir, db, opts);
        const cfg = loadServerConfig();
        const envRoot = process.env['GIT_MIRROR_ROOT'];
        const root = envRoot ?? cfg.git.root;
        const enabled = envRoot ? true : cfg.git.enabled;
        return enabled && root
          ? new RoutingRevisionMirror(root, db, opts)
          : new NoopRevisionMirrorAdapter(onCommitted);
      },
      inject: [KYSELY, OutboxService],
    },
  ],
  // REVISION_MIRROR is exported so other modules (e.g. images) can signal
  // asset changes to the same mirror instance for git durability.
  exports: [ItemsService, REVISION_MIRROR],
})
export class ItemsModule {}
