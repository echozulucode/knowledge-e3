import { Injectable } from '@nestjs/common';
import { buildBundle, validateBundle, type BuildOptions, type LinkStyle, type PageInput } from '@echozedlabs/okf';
import { ItemsService, type ItemView } from '../../items/items.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const LINK_STYLES: LinkStyle[] = ['dual', 'markdown', 'preserve'];

export interface McpExportOkfInput extends Record<string, unknown> {
  ids?: string[];
  status?: 'draft' | 'published';
  tag?: string;
  space?: string;
  type?: string;
  limit?: number;
  link_style?: LinkStyle;
}

/**
 * Serve knowledge content as an Open Knowledge Format (OKF v0.1) bundle to MCP
 * clients — the "serve OKF over MCP" step (Option D) from docs/okf-study and
 * docs/llm-wiki-study. The bundle is built with @echozedlabs/okf and is permission-aware:
 * only items the caller may see are included (delegated to ItemsService).
 */
@Injectable()
export class ExportOkfTool implements McpTool<McpExportOkfInput> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.export_okf',
    title: 'Export knowledge as an OKF bundle',
    description:
      'Export visible knowledge items as an Open Knowledge Format (OKF v0.1) bundle: Markdown concept files with YAML frontmatter plus a root index. Provide explicit ids, or filter by status/tag with a limit. Each concept embeds its stable e3_id for lossless re-import. Results respect the caller\'s permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit item ids to export. Overrides status/tag filters.',
        },
        status: stringProp('Lifecycle status filter when listing.', ['draft', 'published']),
        tag: stringProp('Tag slug/display name filter when listing.'),
        space: stringProp('Restrict to a single space (topic), by space id or slug.'),
        type: stringProp('Restrict to a single concept kind (OKF `type`) — export one section.'),
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum items to export (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
        link_style: stringProp('How cross-links render in exported bodies.', LINK_STYLES),
      },
      additionalProperties: false,
    },
  };

  constructor(private readonly items: ItemsService) {}

  async call(input: McpExportOkfInput, context: McpToolContext = {}) {
    const actor = mcpActor(context);
    const limit = clampLimit(input.limit);
    const linkStyle: LinkStyle = isLinkStyle(input.link_style) ? input.link_style : 'dual';

    let views: ItemView[];
    if (Array.isArray(input.ids) && input.ids.length > 0) {
      const ids = input.ids.filter((v): v is string => typeof v === 'string').slice(0, limit);
      const fetched = await Promise.all(ids.map((id) => this.items.getById(id, actor)));
      views = fetched.filter((v): v is ItemView => v !== null);
    } else {
      views = await this.items.list(
        {
          status: input.status === 'draft' || input.status === 'published' ? input.status : undefined,
          tag: typeof input.tag === 'string' ? input.tag : undefined,
          space: typeof input.space === 'string' ? input.space : undefined,
          type: typeof input.type === 'string' ? input.type : undefined,
          limit,
        },
        actor,
      );
    }

    const pages: PageInput[] = views.map(toPageInput);
    const opts: BuildOptions = {
      linkStyle,
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Exported from Knowledge E3 in Open Knowledge Format (OKF v0.1).',
    };
    const bundle = buildBundle(pages, opts);
    const conformance = validateBundle(bundle);
    return { item_count: pages.length, conformance, bundle };
  }
}

function toPageInput(item: ItemView): PageInput {
  const fm = item.frontmatter ?? {};
  const space =
    typeof fm['space'] === 'string'
      ? (fm['space'] as string)
      : typeof fm['topic'] === 'string'
        ? (fm['topic'] as string)
        : item.space_id;
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    status: item.status,
    space,
    tags: item.tags,
    categories: item.categories,
    groups: item.groups,
    rawMarkdown: item.raw_markdown,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function mcpActor(context?: McpToolContext): ReadActorLike | undefined {
  const user = context?.user;
  if (!user) return undefined;
  return { id: user.id, role: user.role === 'admin' ? 'admin' : 'user' };
}

type ReadActorLike = { id: string; role: 'user' | 'admin' };

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function isLinkStyle(value: unknown): value is LinkStyle {
  return typeof value === 'string' && (LINK_STYLES as string[]).includes(value);
}
