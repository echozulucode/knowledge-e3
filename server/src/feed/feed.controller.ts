import { BadRequestException, Controller, Get, Header, Param, Query } from '@nestjs/common';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { viewerFrom } from '../query/viewer.js';
import { FeedService } from './feed.service.js';

const MAX_LIMIT = 100;

/**
 * Blog feeds (plan §3.3). Every route is a public read: the viewer decides what
 * is visible (published only; private Topics hidden from anonymous visitors).
 *
 *   GET /feed?topic=&types=Blog%20Post,Release%20Note&all_types=1&tags=update,news&series=&author=&homepage=1&featured=1&limit=&cursor=
 *   GET /feed/series/:slug
 *   GET /feed/authors/:name
 *
 * `tags` is any-of, as on a Section. `all_types=1` lifts the default Blog Post /
 * Release Note restriction (an explicit `types` still wins): a topic page's
 * "Recently updated" list and its tag-driven Updates list mirror a Section,
 * which names no type unless its curator chose one, and a wiki topic of
 * Concepts would otherwise get an empty list.
 */
@Controller('feed')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @PublicRead()
  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('topic') topic?: string,
    @Query('types') types?: string,
    @Query('all_types') allTypes?: string,
    @Query('tags') tags?: string,
    @Query('series') series?: string,
    @Query('author') author?: string,
    @Query('homepage') homepage?: string,
    @Query('featured') featured?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.feed.feed(
      {
        topic: topic?.trim() || undefined,
        types: parseTypes(types),
        allTypes: parseFlag(allTypes),
        tags: parseTypes(tags),
        series: series?.trim() || undefined,
        author: author?.trim() || undefined,
        homepage: parseFlag(homepage),
        featured: parseFlag(featured),
        limit: parseLimit(limit),
        cursor: cursor?.trim() || undefined,
      },
      viewerFrom(user),
    );
  }

  @PublicRead()
  @Get('series/:slug')
  async series(@CurrentUser() user: AuthedUser, @Param('slug') slug: string) {
    return this.feed.series(slug, viewerFrom(user));
  }

  @PublicRead()
  @Get('authors/:name')
  async author(
    @CurrentUser() user: AuthedUser,
    @Param('name') name: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.feed.author(name, { limit: parseLimit(limit), cursor: cursor?.trim() || undefined }, viewerFrom(user));
  }
}

/**
 *   GET /feeds/latest.atom
 *   GET /feeds/topics/:slug.atom
 */
@Controller('feeds')
export class AtomFeedController {
  constructor(private readonly feed: FeedService) {}

  @PublicRead()
  @Get('latest.atom')
  @Header('Content-Type', 'application/atom+xml; charset=utf-8')
  latest(@CurrentUser() user: AuthedUser) {
    return this.feed.latestAtom(viewerFrom(user));
  }

  @PublicRead()
  @Get('topics/:slug.atom')
  @Header('Content-Type', 'application/atom+xml; charset=utf-8')
  topic(@CurrentUser() user: AuthedUser, @Param('slug') slug: string) {
    return this.feed.topicAtom(slug, viewerFrom(user));
  }
}

/** Comma-separated labels (content types, tags); empty ⇒ undefined (the service applies the default). */
function parseTypes(raw: string | undefined): string[] | undefined {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function parseFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(n, MAX_LIMIT);
}
