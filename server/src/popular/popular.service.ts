/**
 * Popular items over the `KnowledgeQuery` seam (home plan R3). The ranking and
 * the visibility walk live in `KnowledgeQueryService.popular`, beside the feed
 * they share `toFeedEntry` and the topic lookup with; this service is the
 * module's entry point, as `FeedService` is for the feeds.
 */
import { Injectable } from '@nestjs/common';
import type { PopularView, Viewer } from '@echozedlabs/knowledge-types';
import { KnowledgeQueryService, type PopularQuery } from '../query/knowledge-query.service.js';

@Injectable()
export class PopularService {
  constructor(private readonly query: KnowledgeQueryService) {}

  list(q: PopularQuery, viewer: Viewer): Promise<PopularView> {
    return this.query.popular(q, viewer);
  }
}
