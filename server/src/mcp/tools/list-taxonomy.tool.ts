import { Injectable } from '@nestjs/common';
import { SpacesService } from '../../taxonomy/spaces.service.js';
import type { McpTool, McpToolDescriptor } from './schemas.js';

@Injectable()
export class ListTaxonomyTool implements McpTool {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.list_taxonomy',
    title: 'List tags, categories, and groups',
    description:
      'List taxonomy values agents can use to filter knowledge.search: tags and categories are global; groups include their stable id, display name, count, and space scope metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };

  constructor(private readonly spaces: SpacesService) {}

  async call() {
    const [tags, categories, groups] = await Promise.all([
      this.spaces.listTags(),
      this.spaces.listCategories(),
      this.spaces.listGroups(),
    ]);
    return { tags, categories, groups };
  }
}
