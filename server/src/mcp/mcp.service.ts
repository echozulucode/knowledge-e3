import { HttpException, Injectable, Logger } from '@nestjs/common';
import { mapMcpToolError } from './mcp-errors.js';
import { AuthService } from '../auth/auth.service.js';
import { isAnonymousContext, isReadTokenContext, type McpTool, type McpToolContext, type McpToolDescriptor } from './tools/schemas.js';
import { CreateItemTool as McpCreateItemTool, type McpCreateItemInput } from './tools/create-item.tool.js';
import { ExportOkfTool } from './tools/export-okf.tool.js';
import { GetItemTool } from './tools/get-item.tool.js';
import { ImportOkfTool } from './tools/import-okf.tool.js';
import { ListContentTypesTool } from './tools/list-content-types.tool.js';
import { ListSpacesTool } from './tools/list-spaces.tool.js';
import { ListTaxonomyTool } from './tools/list-taxonomy.tool.js';
import { PublishItemTool } from './tools/publish-item.tool.js';
import { SearchTool } from './tools/search.tool.js';
import { SuggestMetadataTool } from './tools/suggest-metadata.tool.js';
import { UpdateItemTool } from './tools/update-item.tool.js';
import { ValidateItemTool } from './tools/validate-item.tool.js';
import { ValidateOkfBundleTool } from './tools/validate-okf-bundle.tool.js';

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
    private readonly createItem: McpCreateItemTool,
    listSpaces: ListSpacesTool,
    listTaxonomy: ListTaxonomyTool,
    listContentTypes: ListContentTypesTool,
    search: SearchTool,
    exportOkf: ExportOkfTool,
    importOkf: ImportOkfTool,
    validateOkfBundle: ValidateOkfBundleTool,
    suggestMetadata: SuggestMetadataTool,
    validateItem: ValidateItemTool,
    updateItem: UpdateItemTool,
    publishItem: PublishItemTool,
    getItem: GetItemTool,
  ) {
    this.tools = [
      listSpaces,
      listTaxonomy,
      listContentTypes,
      search,
      exportOkf,
      importOkf,
      validateOkfBundle,
      suggestMetadata,
      validateItem,
      getItem,
      this.createItemTool(),
      updateItem,
      publishItem,
    ];
  }

  async handle(request: JsonRpcRequest, context: McpToolContext = {}) {
    const id = request.id ?? null;
    try {
      if (request.jsonrpc !== '2.0') return this.error(id, -32600, 'Invalid JSON-RPC version');
      if (request.method === 'tools/list') return this.result(id, { tools: this.listTools(context) });
      if (request.method === 'tools/call') {
        const params = request.params ?? {};
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = isRecord(params['arguments']) ? params['arguments'] : {};
        // Resolve here only to keep this surface's established -32602 for an
        // unknown name; the call itself goes through callToolByName so the
        // anonymous write gate applies to this legacy path too.
        const tool = this.tools.find((candidate) => candidate.descriptor.name === name);
        if (!tool) return this.error(id, -32602, `Unknown tool: ${name}`);
        return this.result(id, await this.callToolByName(name, args, context));
      }
      return this.error(id, -32601, `Method not found: ${request.method ?? ''}`);
    } catch (err) {
      return this.errorFromException(id, err);
    }
  }

  /**
   * Map a thrown error to a JSON-RPC error object. The decision about what an
   * exception may reveal lives in `mapMcpToolError`, shared with the
   * spec-compliant `/mcp` endpoint so the two transports cannot drift again
   * (issue 45): structured `HttpException` fields land in `error.data`; unknown
   * errors become a generic internal error carrying a correlation id.
   */
  private errorFromException(id: JsonRpcRequest['id'], err: unknown) {
    const mapped = mapMcpToolError(err, this.logger);
    return this.error(id, mapped.code, mapped.message, mapped.data);
  }

  /**
   * Tools visible to this caller. Anonymous visitors on a public instance and
   * read-scoped token callers get the read-only subset — but hiding a tool is
   * presentation, not enforcement; `callToolByName` is the actual gate.
   */
  listTools(context: McpToolContext = {}): McpToolDescriptor[] {
    const readOnly = isAnonymousContext(context) || isReadTokenContext(context);
    return this.tools
      .map((tool) => tool.descriptor)
      .filter((descriptor) => !(readOnly && descriptor.write));
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
    // Enforce read-only for anonymous callers HERE, not just by filtering
    // listTools: a client can call any name it likes without ever listing.
    if (tool.descriptor.write && isAnonymousContext(context)) {
      throw new HttpException(
        { message: `${name} requires sign-in: this instance is public for reading only.` },
        403,
      );
    }
    if (tool.descriptor.write && isReadTokenContext(context)) {
      throw new HttpException({ message: `${name} requires a write-scoped token: this token is read-only.` }, 403);
    }
    return tool.call(args, context);
  }

  private createItemTool(): McpTool<McpCreateItemInput> {
    return {
      descriptor: this.createItem.descriptor,
      call: async (input, context) => {
        // Attribute the new item to the authenticated MCP caller so ownership,
        // draft visibility, and audit all reflect who actually created it. Over
        // HTTP there is always a user (the guard attaches one); the system actor
        // is only for an in-process call with no user on the context.
        const actorId = mcpActor(context)?.id ?? (await this.auth.ensureLocalSystemActor()).id;
        return this.createItem.execute(actorId, input);
      },
    };
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

function mcpActor(context?: McpToolContext): { id: string; role: 'user' | 'admin' } | undefined {
  const user = context?.user;
  if (!user) return undefined;
  const role = user.role === 'admin' ? 'admin' : 'user';
  return { id: user.id, role };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

