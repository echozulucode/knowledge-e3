import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { wholeNumber } from '../auth/list-params.js';
import { ContentHealthService, QUEUE_NAMES, QUEUE_PAGE_MAX, type QueueName } from './content-health.service.js';

/**
 * Admin → Health → Content (plan §6.3): audit tiers, signal roll-up, and the
 * fix-it queues. Admin-only — it lists drafts and whole-library findings.
 *
 *   GET /admin/health/content?topic=<slug|id>
 *   GET /admin/health/content/queues/<queue>?topic=&offset=&limit=
 */
@Controller('admin/health')
export class ContentHealthController {
  constructor(private readonly health: ContentHealthService) {}

  @AdminOnly()
  @Get('content')
  content(@CurrentUser() user: AuthedUser, @Query('topic') topic?: string) {
    return this.health.report(user, topic?.trim() || undefined);
  }

  /**
   * One page of one fix-it queue (review §4.9). The report carries each queue's
   * first 50 members; this is how a table reaches the rest. An unknown queue is
   * a 404 (there is no such resource); a malformed `offset`/`limit` is a 400,
   * since silently ignoring it would show the wrong page. An offset past the end
   * is not an error: the page is empty and `total` says why.
   */
  @AdminOnly()
  @Get('content/queues/:queue')
  queue(
    @CurrentUser() user: AuthedUser,
    @Param('queue') queue: string,
    @Query('topic') topic?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    if (!(QUEUE_NAMES as readonly string[]).includes(queue)) {
      throw new NotFoundException(`unknown queue "${queue}"; expected one of ${QUEUE_NAMES.join(', ')}`);
    }
    const pageLimit = wholeNumber(limit, 'limit', 1);
    if (pageLimit !== undefined && pageLimit > QUEUE_PAGE_MAX) {
      throw new BadRequestException(`limit must be at most ${QUEUE_PAGE_MAX}`);
    }
    return this.health.queuePage(user, queue as QueueName, {
      topic: topic?.trim() || undefined,
      offset: wholeNumber(offset, 'offset', 0),
      limit: pageLimit,
    });
  }
}
