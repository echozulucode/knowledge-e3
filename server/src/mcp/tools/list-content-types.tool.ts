import { Injectable } from '@nestjs/common';
import { listContentTypes } from '../../content-types/content-types.registry.js';
import type { McpTool, McpToolDescriptor } from './schemas.js';

/**
 * Expose the first-class content-type vocabulary to agents. Each entry's `label`
 * is what to write into a new concept's frontmatter `type`; `template` is a
 * starter body scaffold; `defaultFrontmatter` seeds domain fields. Agents should
 * call this before `knowledge.create_item` to pick the right kind and scaffold.
 */
@Injectable()
export class ListContentTypesTool implements McpTool {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.list_content_types',
    title: 'List content types',
    description:
      'List the first-class content types (OKF concept kinds) this knowledge base recognizes. Each has a `label` (write it to frontmatter `type`), a `description`, `defaultFrontmatter` (domain fields to seed), and a `template` (starter Markdown body). Use before create_item to choose the right kind and scaffold. Unknown types remain accepted, but prefer these.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };

  async call() {
    return { content_types: listContentTypes() };
  }
}
