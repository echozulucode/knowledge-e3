import { Injectable } from '@nestjs/common';
import { SpacesService } from '../../taxonomy/spaces.service.js';
import type { McpTool, McpToolDescriptor } from './schemas.js';

@Injectable()
export class ListSpacesTool implements McpTool {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.list_spaces',
    title: 'List knowledge spaces/topics',
    description:
      'List active knowledge spaces/topics with stable ids, slugs, display names, optional visual metadata, and item counts. Use this before filtering search or creating items by space/topic.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };

  constructor(private readonly spaces: SpacesService) {}

  async call() {
    const spaces = await this.spaces.listWithCounts();
    return { spaces, total: spaces.length };
  }
}
