import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { SearchModule } from '../search/search.module.js';
import { TaxonomyModule } from '../taxonomy/taxonomy.module.js';
import { WikiModule } from '../wiki/wiki.module.js';
import { KnowledgeQueryService } from './knowledge-query.service.js';

/**
 * The read seam (`KnowledgeQuery`). Global so the modules whose controllers
 * read through it (pages, items, search, mcp) need not import it back — they
 * also provide the services it delegates to, and a module-level cycle would
 * run through storage/taxonomy modules this seam must stay independent of.
 */
@Global()
@Module({
  imports: [PagesModule, ItemsModule, SearchModule, TaxonomyModule, ConfigModule, WikiModule],
  providers: [KnowledgeQueryService],
  exports: [KnowledgeQueryService],
})
export class QueryModule {}
