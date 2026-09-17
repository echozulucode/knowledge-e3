import { Global, Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { TaxonomyModule } from '../taxonomy/taxonomy.module.js';
import { ContentCommandsService } from './content-commands.service.js';
import { OutboxReplayService } from './outbox-replay.service.js';

/**
 * The write seam (`ContentCommands`). Global for the same reason as QueryModule:
 * pages/items/mcp write through it and also provide what it delegates to.
 */
@Global()
@Module({
  imports: [ItemsModule, PagesModule, TaxonomyModule],
  providers: [ContentCommandsService, OutboxReplayService],
  exports: [ContentCommandsService],
})
export class ContentModule {}
