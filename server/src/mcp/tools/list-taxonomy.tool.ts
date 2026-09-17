import { Injectable } from '@nestjs/common';
import { callReadTool, LIST_TAXONOMY_TOOL } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

@Injectable()
export class ListTaxonomyTool implements McpTool {
  readonly descriptor: McpToolDescriptor = LIST_TAXONOMY_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: Record<string, unknown> = {}, context: McpToolContext = {}) {
    return callReadTool('knowledge.list_taxonomy', this.backend, input, context);
  }
}
