import { Injectable } from '@nestjs/common';
import { SearchService, type SearchOptions } from '../../search/search.service.js';
import { parseSearchQuery } from '../../search/query-parser.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';

export interface McpSearchInput extends Record<string, unknown> {
  q?: string;
  space?: string;
  tag?: string;
  category?: string;
  group?: string;
  status?: 'draft' | 'published';
  limit?: number;
  sort?: 'relevance' | 'newest' | 'oldest' | 'az';
  include_drafts?: boolean;
}

@Injectable()
export class SearchTool implements McpTool<McpSearchInput> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.search',
    title: 'Search knowledge items',
    description:
      'Search knowledge items with REST-parity filters. Use space/topic, tag, category, group, status, limit, and sort to narrow results; returned hits include stable item ids plus display names and taxonomy context.',
    inputSchema: {
      type: 'object',
      properties: {
        q: stringProp('Full-text query. Omit with sort=newest/oldest/az to browse filtered items.'),
        space: stringProp('Space/topic id, slug, or display name to filter results.'),
        tag: stringProp('Tag slug/display name to filter results.'),
        category: stringProp('Category slug/display name to filter results.'),
        group: stringProp('Group id, slug, or display name to filter results.'),
        status: stringProp('Lifecycle status filter.', ['draft', 'published']),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum number of results to return.' },
        sort: stringProp('Sort mode.', ['relevance', 'newest', 'oldest', 'az']),
        include_drafts: { type: 'boolean', description: 'Include draft items when authorized; status=draft also implies draft visibility.' },
      },
      additionalProperties: false,
    },
  };

  constructor(private readonly search: SearchService) {}

  async call(input: McpSearchInput, context: McpToolContext = {}) {
    const canSeeDrafts = context.user?.role === 'admin';
    const query = typeof input.q === 'string' ? input.q : undefined;
    const structuredStatus = parseSearchQuery(query ?? '').filters.status?.[0];
    const opts: SearchOptions = {
      q: query,
      space: typeof input.space === 'string' ? input.space : undefined,
      tag: typeof input.tag === 'string' ? input.tag : undefined,
      category: typeof input.category === 'string' ? input.category : undefined,
      group: typeof input.group === 'string' ? input.group : undefined,
      status: input.status === 'draft' || input.status === 'published' ? input.status : undefined,
      include_drafts: canSeeDrafts && (input.include_drafts === true || input.status === 'draft' || structuredStatus === 'draft'),
      viewer_id: context.user?.id,
      sort: input.sort === 'newest' || input.sort === 'oldest' || input.sort === 'az' ? input.sort : 'relevance',
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    };
    return this.search.searchWithContext(opts);
  }
}
