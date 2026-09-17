import { Injectable } from '@nestjs/common';
import { callReadTool, LIST_CONTENT_TYPES_TOOL } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

/**
 * Expose the first-class content-type vocabulary to agents. Each entry's `label`
 * is what to write into a new concept's frontmatter `type`; `template` is a
 * starter body scaffold; `defaultFrontmatter` seeds domain fields. Agents should
 * call this before `knowledge.create_item` to pick the right kind and scaffold.
 */
@Injectable()
export class ListContentTypesTool implements McpTool {
  readonly descriptor: McpToolDescriptor = LIST_CONTENT_TYPES_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: Record<string, unknown> = {}, context: McpToolContext = {}) {
    return callReadTool('knowledge.list_content_types', this.backend, input, context);
  }
}
