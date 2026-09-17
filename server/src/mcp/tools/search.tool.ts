import { Injectable } from '@nestjs/common';
import { callReadTool, SEARCH_TOOL } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

/** `knowledge.search` — descriptor and argument normalization from `@echozedlabs/mcp-tools`; data from McpReadBackend. */
@Injectable()
export class SearchTool implements McpTool {
  readonly descriptor: McpToolDescriptor = SEARCH_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: Record<string, unknown>, context: McpToolContext = {}) {
    return callReadTool('knowledge.search', this.backend, input, context);
  }
}
