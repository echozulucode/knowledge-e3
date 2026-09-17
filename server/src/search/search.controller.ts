import { Controller, Get, Query } from '@nestjs/common';
import { SortMode, SearchStatus, type FilterInput } from './search.service.js';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { viewerFrom } from '../query/viewer.js';

@Controller('search')
export class SearchController {
  constructor(private readonly query: KnowledgeQueryService) {}

  /**
   * What `/search` shows before a query (reader plan R3.6). Public-read like
   * `GET /search`, and scoped the same way: an anonymous reader's counts and
   * lists exclude private Topics.
   */
  @PublicRead()
  @Get('overview')
  async overview(@CurrentUser() user: AuthedUser) {
    return this.query.searchOverview(viewerFrom(user));
  }

  @PublicRead()
  @Get()
  async run(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    // Express parses a repeated parameter (`?tag=a&tag=b`) as an array; the
    // service ORs the values, so a filtered search is expressible as a URL and
    // therefore shareable — which is how a knowledgebase actually gets used.
    @Query('tag') tag?: FilterInput,
    @Query('category') category?: FilterInput,
    @Query('group') group?: FilterInput,
    @Query('space') space?: FilterInput,
    @Query('topic') topic?: FilterInput,
    @Query('type') type?: FilterInput,
    // `author` and `is` repeat like `tag`; `updated` takes one value, as `updated:` does.
    @Query('author') author?: FilterInput,
    @Query('is') is?: FilterInput,
    @Query('updated') updated?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('sort') sort?: string,
    @Query('include_drafts') includeDrafts?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // The draft-visibility rule (asked-for AND admin) lives in the seam, shared with MCP.
    return this.query.search(
      {
        q,
        tag,
        category,
        group,
        // `topic` and `space` are the same axis under two names; either may be
        // repeated, and both are honoured together.
        space: mergeFilters(space, topic),
        type,
        author,
        is,
        updated: typeof updated === 'string' ? updated : undefined,
        status: parseStatus(status),
        since,
        sort: parseSort(sort),
        include_drafts: includeDrafts === 'true' || includeDrafts === '1',
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
      viewerFrom(user),
    );
  }
}

function mergeFilters(...values: (FilterInput | undefined)[]): FilterInput | undefined {
  const merged = values.flatMap((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]));
  return merged.length ? merged : undefined;
}

function parseSort(s: string | undefined): SortMode {
  if (s === 'newest' || s === 'oldest' || s === 'az' || s === 'verified') return s;
  return 'relevance';
}

function parseStatus(s: string | undefined): SearchStatus | undefined {
  if (s === 'draft' || s === 'published') return s;
  return undefined;
}
