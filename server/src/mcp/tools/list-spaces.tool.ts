import { Injectable } from '@nestjs/common';
import { callReadTool, LIST_SPACES_TOOL } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

@Injectable()
export class ListSpacesTool implements McpTool {
  readonly descriptor: McpToolDescriptor = LIST_SPACES_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: Record<string, unknown> = {}, context: McpToolContext = {}) {
    return callReadTool('knowledge.list_spaces', this.backend, input, context);
  }
}
