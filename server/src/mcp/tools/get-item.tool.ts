import { Injectable } from '@nestjs/common';
import { callReadTool, GET_ITEM_TOOL } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

/**
 * `knowledge.get_item` — stable id first, then slug, then exact title, as the
 * viewer may see it (drafts and private topics follow the same read gates as
 * search). A miss is a public 404.
 */
@Injectable()
export class GetItemTool implements McpTool {
  readonly descriptor: McpToolDescriptor = GET_ITEM_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: Record<string, unknown>, context: McpToolContext = {}) {
    return callReadTool('knowledge.get_item', this.backend, input, context);
  }
}
