import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { PopularView } from '@echozedlabs/knowledge-types';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { viewerFrom } from '../query/viewer.js';
import { PopularService } from './popular.service.js';

export const POPULAR_DEFAULT_LIMIT = 5;
/** A "top N" list, not a second feed: past twenty the tail is ranked by one or two readers. */
export const POPULAR_MAX_LIMIT = 20;
export const POPULAR_DEFAULT_DAYS = 30;
/** A year: longer than that and "popular" describes the library's history, not what people read now. */
export const POPULAR_MAX_DAYS = 365;

/**
 * "Popular" (home plan R3): the most-read published items, site-wide or in one
 * topic. A public read like `/feed` — the viewer decides what is visible, so a
 * private topic's items never rank for an anonymous visitor.
 *
 *   GET /popular?topic=&limit=5&days=30
 *
 * `limit` and `days` above their maximum are capped rather than refused, as
 * `/feed` caps `limit`; anything that is not a positive whole number is a 400.
 */
@Controller('popular')
export class PopularController {
  constructor(private readonly popular: PopularService) {}

  @PublicRead()
  @Get()
  list(
    @CurrentUser() user: AuthedUser,
    @Query('topic') topic?: string,
    @Query('limit') limit?: string,
    @Query('days') days?: string,
  ): Promise<PopularView> {
    return this.popular.list(
      {
        topic: typeof topic === 'string' ? topic.trim() || undefined : undefined,
        limit: parseBounded('limit', limit, POPULAR_DEFAULT_LIMIT, POPULAR_MAX_LIMIT),
        days: parseBounded('days', days, POPULAR_DEFAULT_DAYS, POPULAR_MAX_DAYS),
      },
      viewerFrom(user),
    );
  }
}

/**
 * A positive whole number, defaulted when absent and capped at `max`. Strict on
 * shape (`5x`, `2.5`, `-1`, a repeated key all 400) because `parseInt` would
 * quietly read `5x` as 5 and hide a caller's bug.
 */
function parseBounded(name: string, raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (n < 1) throw new BadRequestException(`${name} must be a positive integer`);
  return Math.min(n, max);
}
