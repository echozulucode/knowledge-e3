import { Controller, Get, Query } from '@nestjs/common';
import { SearchService, SortMode, SearchStatus } from './search.service.js';
import { parseSearchQuery } from './query-parser.js';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @PublicRead()
  @Get()
  async run(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('tag') tag?: string,
    @Query('category') category?: string,
    @Query('group') group?: string,
    @Query('space') space?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('sort') sort?: string,
    @Query('include_drafts') includeDrafts?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const structuredStatus = parseSearchQuery(q ?? '').filters.status?.[0];
    const wantDrafts = includeDrafts === 'true' || includeDrafts === '1' || status === 'draft' || structuredStatus === 'draft';
    const canSeeDrafts = user.role === 'admin';
    return this.search.searchWithContext({
      q,
      tag,
      category,
      group,
      space,
      status: parseStatus(status),
      since,
      sort: parseSort(sort),
      include_drafts: wantDrafts && canSeeDrafts,
      viewer_id: user.id,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}

function parseSort(s: string | undefined): SortMode {
  if (s === 'newest' || s === 'oldest' || s === 'az') return s;
  return 'relevance';
}

function parseStatus(s: string | undefined): SearchStatus | undefined {
  if (s === 'draft' || s === 'published') return s;
  return undefined;
}
