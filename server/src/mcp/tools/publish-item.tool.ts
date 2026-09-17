import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service.js';
import { ContentCommandsService } from '../../content/content-commands.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';
import { mcpWriteActor, writeItemResponse, type McpWriteItemResponse } from './update-item.tool.js';

export interface McpPublishItemInput extends Record<string, unknown> {
  id?: string;
  reviewed?: boolean;
  allow_lint_errors?: boolean;
}

@Injectable()
export class PublishItemTool implements McpTool<McpPublishItemInput, McpWriteItemResponse> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.publish_item',
    title: 'Publish a knowledge item',
    write: true,
    description:
      'Set an item to published. Pass `reviewed: true` ONLY after the user has read the result: it also appends a human verification (OKF `verified[]`) in their name, which is what clears the AI-generated indicator. Without it the item publishes unverified. Publishing is gated: any error-severity content-model diagnostic (missing `type`, missing or unknown primary category, missing `description`, a Blog Post without `published_at`/authors) refuses the call with 422 `lint_failed` and returns the diagnostics. Run validate_item with `published: true` first and fix every error. `allow_lint_errors: true` overrides the refusal but is admin-only and recorded in the audit log.',
    inputSchema: {
      type: 'object',
      properties: {
        id: stringProp('Stable item id.'),
        reviewed: { type: 'boolean', description: 'The user has reviewed this item; record their verification.' },
        allow_lint_errors: {
          type: 'boolean',
          description: 'Publish despite error-severity lint diagnostics. Admin-only and recorded in the audit log; not for routine use.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly auth: AuthService,
    private readonly content: ContentCommandsService,
  ) {}

  async call(input: McpPublishItemInput, context: McpToolContext = {}): Promise<McpWriteItemResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) throw new BadRequestException('id is required');
    const actor = await mcpWriteActor(this.auth, context);
    const { item, diagnostics } = await this.content.publish(actor, id, {
      reviewed: input.reviewed === true,
      allowLintErrors: input.allow_lint_errors === true,
    });
    return writeItemResponse(item, diagnostics);
  }
}
