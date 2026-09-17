import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { ConflictQueueService } from './conflict-queue.service.js';
import { InboundIndexService } from './inbound-index.service.js';
import { ReviewService } from './review.service.js';
import { SourceRegistryService } from './source-registry.service.js';
import { SyncController } from './sync.controller.js';
import { SYNC_PUSH } from './sync.port.js';
import { SyncService } from './sync.service.js';
import { WebhookController } from './webhook.controller.js';

/**
 * Source registry + sync engine host (plan §7.4, §8). Global so the registry
 * is reachable from the storage facade (`RepoConfigService`) and the write
 * path can ask for a push through `SYNC_PUSH` without importing this module.
 */
@Global()
@Module({
  imports: [AuthModule, ItemsModule, PagesModule],
  controllers: [SyncController, WebhookController],
  providers: [
    SourceRegistryService,
    InboundIndexService,
    ConflictQueueService,
    ReviewService,
    SyncService,
    { provide: SYNC_PUSH, useExisting: SyncService },
  ],
  exports: [SourceRegistryService, SyncService, ConflictQueueService, InboundIndexService, ReviewService, SYNC_PUSH],
})
export class SyncModule {}
