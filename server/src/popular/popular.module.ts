import { Module } from '@nestjs/common';
import { PopularController } from './popular.controller.js';
import { PopularService } from './popular.service.js';

/**
 * "Popular" lists (home plan R3). Reads only through the global `KnowledgeQuery`
 * seam, like `FeedModule`, so it imports nothing else.
 */
@Module({
  controllers: [PopularController],
  providers: [PopularService],
})
export class PopularModule {}
