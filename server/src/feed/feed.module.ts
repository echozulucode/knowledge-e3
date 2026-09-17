import { Module } from '@nestjs/common';
import { AtomFeedController, FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';

/**
 * Blog surfaces (plan §3.3): JSON feed, series, authors, and Atom. Reads only
 * through the global `KnowledgeQuery` seam, so it imports nothing else.
 */
@Module({
  controllers: [FeedController, AtomFeedController],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
