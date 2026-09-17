import { BadRequestException, Injectable } from '@nestjs/common';
import type { Diagnostic, ItemView } from '@echozedlabs/knowledge-types';
import { AuthService } from '../../auth/auth.service.js';
import { actorFrom } from '../../content/actor.js';
import { ContentCommandsService } from '../../content/content-commands.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';

export interface McpUpdateItemInput extends Record<string, unknown> {
  id?: string;
  raw_markdown?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  title?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  status?: 'draft' | 'published';
  version_token?: number;
  allow_lint_errors?: boolean;
}

/** Shared by update_item and publish_item: the write result, id first, like create_item. */
export interface McpWriteItemResponse {
  id: string;
  title: string;
  slug: string;
  path: string;
  url: string;
  version_token: number;
  /**
   * Content-model lint findings for the stored document. Warn-only, except on
   * the draft→published transition, which an `error` refuses with 422
   * `lint_failed`; a save of an already-published item is never refused.
   */
  diagnostics: Diagnostic[];
  item: ItemView;
}

export function writeItemResponse(item: ItemView, diagnostics: Diagnostic[]): McpWriteItemResponse {
  return {
    id: item.id,
    title: item.title,
    slug: item.slug,
    path: `/items/${item.id}`,
    url: `/p/${item.slug}`,
    version_token: item.version_token,
    diagnostics,
    item,
  };
}

/**
 * The write actor for an MCP call: the authenticated user (decision 4 — agents
 * write as the user they are signed in as), falling back to the local system
 * account only for an in-process call with no user on the context (never over
 * HTTP, where the guard always attaches one).
 */
export async function mcpWriteActor(auth: AuthService, context: McpToolContext) {
  const user = context.user ?? (await auth.ensureLocalSystemActor());
  return actorFrom(user, 'mcp');
}

@Injectable()
export class UpdateItemTool implements McpTool<McpUpdateItemInput, McpWriteItemResponse> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.update_item',
    title: 'Update a knowledge item',
    write: true,
    description:
      'Update an existing item by stable id with optimistic concurrency: pass the `version_token` you last read (get_item); a stale token is refused with a conflict. Supply either `raw_markdown` (full document) or individual fields. Returns the item and lint diagnostics. Diagnostics are warn-only for an ordinary save — including a save of an already-published item — but an update that takes a draft to `status: "published"` is a publish: any error-severity diagnostic refuses it with 422 `lint_failed` and returns the diagnostics to fix. `allow_lint_errors: true` overrides that refusal but is admin-only and audited.',
    inputSchema: {
      type: 'object',
      properties: {
        id: stringProp('Stable item id.'),
        version_token: { type: 'integer', description: 'The version_token last read for this item.' },
        raw_markdown: stringProp('Full raw Markdown document with optional frontmatter.'),
        body: stringProp('Markdown body text.'),
        title: stringProp('New display title.'),
        status: stringProp('Lifecycle status.', ['draft', 'published']),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to set.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Categories to set.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Groups to set.' },
        frontmatter: { type: 'object', description: 'Frontmatter keys to merge.' },
        allow_lint_errors: {
          type: 'boolean',
          description: 'Publish despite error-severity lint diagnostics. Admin-only and recorded in the audit log; not for routine use.',
        },
      },
      required: ['id', 'version_token'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly auth: AuthService,
    private readonly content: ContentCommandsService,
  ) {}

  async call(input: McpUpdateItemInput, context: McpToolContext = {}): Promise<McpWriteItemResponse> {
    const { id, version_token, ...fields } = input;
    if (typeof id !== 'string' || !id.trim()) throw new BadRequestException('id is required');
    if (typeof version_token !== 'number' || !Number.isInteger(version_token)) {
      throw new BadRequestException('version_token must be an integer');
    }
    const actor = await mcpWriteActor(this.auth, context);
    const { item, diagnostics } = await this.content.update(actor, id.trim(), fields, version_token, 'mcp');
    return writeItemResponse(item, diagnostics);
  }
}
