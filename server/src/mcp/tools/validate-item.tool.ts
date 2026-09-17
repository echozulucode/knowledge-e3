import { Injectable } from '@nestjs/common';
import { callReadTool, VALIDATE_ITEM_TOOL, type ValidateItemResult } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

export interface McpValidateItemInput extends Record<string, unknown> {
  raw_markdown?: string;
  topic?: string;
  published?: boolean;
}

export type McpValidateItemResponse = ValidateItemResult;

/** Dry run of the content-model lint (plan §5.2, §6.2) with the live vocabularies; nothing is written. */
@Injectable()
export class ValidateItemTool implements McpTool<McpValidateItemInput, McpValidateItemResponse> {
  readonly descriptor: McpToolDescriptor = VALIDATE_ITEM_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: McpValidateItemInput, context: McpToolContext = {}): Promise<McpValidateItemResponse> {
    return callReadTool('knowledge.validate_item', this.backend, input, context) as Promise<McpValidateItemResponse>;
  }
}
