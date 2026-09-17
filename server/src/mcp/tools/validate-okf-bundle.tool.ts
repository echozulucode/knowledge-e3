import { Injectable } from '@nestjs/common';
import { callReadTool, VALIDATE_OKF_BUNDLE_TOOL, type ValidateOkfBundleResult } from '@echozedlabs/mcp-tools';
import { McpReadBackend } from '../mcp-read-backend.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

export interface McpValidateOkfBundleInput extends Record<string, unknown> {
  files?: { path: string; content: string }[];
  topic?: string;
}

export type McpValidateOkfBundleResponse = ValidateOkfBundleResult;

/**
 * `knowledge.validate_okf_bundle` (the product roadmap §7.1). The dry run for
 * `knowledge.import_okf`: same input, same three-tier report, no writes — so an
 * agent can find out whether a bundle it just generated would be taken before it
 * hands it over.
 *
 * Read-only, and declared so by the ABSENCE of `write: true` on the descriptor:
 * that flag is what hides a tool from, and refuses it for, anonymous and
 * read-scoped-token callers (see McpService.callToolByName). Validation touches
 * nothing but the taxonomy read it uses to answer the optional `topic`.
 */
@Injectable()
export class ValidateOkfBundleTool implements McpTool<McpValidateOkfBundleInput, McpValidateOkfBundleResponse> {
  readonly descriptor: McpToolDescriptor = VALIDATE_OKF_BUNDLE_TOOL;

  constructor(private readonly backend: McpReadBackend) {}

  async call(input: McpValidateOkfBundleInput, context: McpToolContext = {}): Promise<McpValidateOkfBundleResponse> {
    return callReadTool('knowledge.validate_okf_bundle', this.backend, input, context) as Promise<McpValidateOkfBundleResponse>;
  }
}
