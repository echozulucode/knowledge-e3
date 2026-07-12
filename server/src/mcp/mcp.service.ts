import { HttpException, Injectable, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { ItemsService, type ItemView } from '../items/items.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './tools/schemas.js';
import { CreateItemTool as McpCreateItemTool, type McpCreateItemInput } from './tools/create-item.tool.js';
import { ExportOkfTool } from './tools/export-okf.tool.js';
import { ImportOkfTool } from './tools/import-okf.tool.js';
import { ListContentTypesTool } from './tools/list-content-types.tool.js';
import { ListSpacesTool } from './tools/list-spaces.tool.js';
import { ListTaxonomyTool } from './tools/list-taxonomy.tool.js';
import { SearchTool } from './tools/search.tool.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

@Injectable()
export class McpService {
  private readonly tools: McpTool[];
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly auth: AuthService,
    private readonly items: ItemsService,
    private readonly createItem: McpCreateItemTool,
    listSpaces: ListSpacesTool,
    listTaxonomy: ListTaxonomyTool,
    listContentTypes: ListContentTypesTool,
    search: SearchTool,
    exportOkf: ExportOkfTool,
    importOkf: ImportOkfTool,
  ) {
    this.tools = [
      listSpaces,
      listTaxonomy,
      listContentTypes,
      search,
      exportOkf,
      importOkf,
      this.getItemTool(),
      this.createItemTool(),
    ];
  }

  async handle(request: JsonRpcRequest, context: McpToolContext = {}) {
    const id = request.id ?? null;
    try {
      if (request.jsonrpc !== '2.0') return this.error(id, -32600, 'Invalid JSON-RPC version');
      if (request.method === 'tools/list') return this.result(id, { tools: this.listTools() });
      if (request.method === 'tools/call') {
        const params = request.params ?? {};
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = isRecord(params['arguments']) ? params['arguments'] : {};
        const tool = this.tools.find((candidate) => candidate.descriptor.name === name);
        if (!tool) return this.error(id, -32602, `Unknown tool: ${name}`);
        return this.result(id, await tool.call(args, context));
      }
      return this.error(id, -32601, `Method not found: ${request.method ?? ''}`);
    } catch (err) {
      return this.errorFromException(id, err);
    }
  }

  /**
   * Map a thrown error to a JSON-RPC error object. Structured Nest
   * `HttpException`s (BadRequest/Conflict/Forbidden/NotFound) keep their shaped
   * response in `error.data` so MCP clients can read fields like
   * `duplicate_title`. Unknown errors are logged server-side and returned as a
   * generic internal error — we never leak raw messages/stack traces.
   */
  private errorFromException(id: JsonRpcRequest['id'], err: unknown) {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const response = err.getResponse();
      const data = typeof response === 'string' ? { detail: response } : (response as Record<string, unknown>);
      const message = typeof response === 'string'
        ? response
        : ((data['message'] as string | undefined) ?? err.message);
      return this.error(id, rpcCodeForStatus(status), message, data);
    }
    this.logger.error('MCP tool failed', err instanceof Error ? err.stack : String(err));
    return this.error(id, -32603, 'Internal error');
  }

  listTools(): McpToolDescriptor[] {
    return this.tools.map((tool) => tool.descriptor);
  }

  /**
   * Invoke a tool by name with validated args and a request context. Throws
   * (HttpException or Error) on failure so the caller can shape the transport's
   * error result. Used by both the legacy JSON-RPC handler and the spec-compliant
   * SDK transport.
   */
  async callToolByName(name: string, args: Record<string, unknown>, context: McpToolContext = {}): Promise<unknown> {
    const tool = this.tools.find((candidate) => candidate.descriptor.name === name);
    if (!tool) throw new HttpException({ message: `Unknown tool: ${name}` }, 404);
    return tool.call(args, context);
  }

  private getItemTool(): McpTool {
    return {
      descriptor: {
        name: 'knowledge.get_item',
        title: 'Get knowledge item',
        description: 'Get a Knowledge E3 item by stable id first, or by slug/title compatibility lookup, including body and taxonomy fields.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable item/page id.' },
            slug: { type: 'string', description: 'Human-readable item slug.' },
            title: { type: 'string', description: 'Exact item title.' },
          },
          additionalProperties: false,
        },
      },
      call: async (input, context) => {
        const page = await this.findPage(input, context);
        if (!page) throw new Error('knowledge.get_item could not find an item for the supplied id, slug, or title');
        return { item: toMcpItem(page) };
      },
    };
  }

  private createItemTool(): McpTool<McpCreateItemInput> {
    return {
      descriptor: this.createItem.descriptor,
      call: async (input, context) => {
        // Attribute the new item to the authenticated MCP caller so ownership,
        // draft visibility, and audit all reflect who actually created it. Only
        // fall back to the synthetic system actor when auth is disabled and no
        // user is present on the context.
        const actorId = mcpActor(context)?.id ?? (await this.auth.ensureLocalSystemActor()).id;
        return this.createItem.execute(actorId, input);
      },
    };
  }

  private async findPage(input: Record<string, unknown>, context?: McpToolContext): Promise<ItemView | null> {
    const actor = mcpActor(context);
    const id = stringValue(input['id']);
    if (id) return this.items.getById(id, actor);
    const slug = stringValue(input['slug']);
    if (slug) return this.items.getBySlug(slug, actor);
    const title = stringValue(input['title']);
    if (title) return this.items.getByTitle(title, actor);
    return null;
  }

  private result(id: JsonRpcRequest['id'], result: unknown) {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: JsonRpcRequest['id'], code: number, message: string, data?: Record<string, unknown>) {
    const error: { code: number; message: string; data?: Record<string, unknown> } = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
  }
}

/** Map an HTTP status to a JSON-RPC error code in the server-defined range. */
function rpcCodeForStatus(status: number): number {
  switch (status) {
    case 400: return -32602; // invalid params
    case 401: return -32001;
    case 403: return -32003;
    case 404: return -32004;
    case 409: return -32009;
    default: return -32000;
  }
}

function toMcpItem(item: ItemView) {
  const frontmatter = item.frontmatter ?? {};
  const spaceValue = typeof frontmatter['space'] === 'string' ? frontmatter['space'] : typeof frontmatter['topic'] === 'string' ? frontmatter['topic'] : item.space_id;
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    status: item.status,
    space: spaceValue,
    tags: item.tags,
    categories: item.categories,
    groups: item.groups,
    path: `/items/${item.id}`,
    url: `/p/${item.slug}`,
    updated_at: item.updated_at,
    version_token: item.version_token,
    body_markdown: item.body_markdown,
    raw_markdown: item.raw_markdown,
    frontmatter,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mcpActor(context?: McpToolContext): { id: string; role: 'user' | 'admin' } | undefined {
  const user = context?.user;
  if (!user) return undefined;
  const role = user.role === 'admin' ? 'admin' : 'user';
  return { id: user.id, role };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

