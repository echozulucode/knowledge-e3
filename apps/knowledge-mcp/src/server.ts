/**
 * MCP wiring: the SDK's low-level `Server` over a stdio transport, answering
 * `tools/list` and `tools/call` from the app's tools. Results and failures use
 * the envelopes from `@echozedlabs/mcp-tools`, the same the Knowledge E3 server
 * renders, so a client handles both identically.
 */
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { internalToolError, KnowledgeToolError, mapKnownToolError, toolErrorResult, toolSuccessResult } from '@echozedlabs/mcp-tools';
import { MultiSourceBackend } from './backend.js';
import type { KnowledgeMcpConfig } from './config.js';
import type { Logger } from './log.js';
import { FolderSource } from './sources/folder.js';
import { GitSource } from './sources/git.js';
import { RemoteSource, type RemoteSourceOptions } from './sources/remote.js';
import type { KnowledgeSource } from './sources/types.js';
import { createAppTools, type AppTool } from './tools.js';
import { VERSION } from './version.js';

const INSTRUCTIONS =
  'Knowledge E3 local MCP server (read-only). It reads only the sources it was configured with — local folders, ' +
  'local git working trees, and optionally Knowledge E3 servers — and never writes, commits or publishes. ' +
  'Use knowledge.search (keyword search; results are grouped per source, never merged into one ranking), then ' +
  'knowledge.get_item with a hit\'s `ref` (`<source>:<id>`). knowledge.list_sources shows what is configured.';

export function createSources(config: KnowledgeMcpConfig, logger: Logger, remote: RemoteSourceOptions = {}): KnowledgeSource[] {
  return config.sources.map((source) => {
    switch (source.type) {
      case 'folder':
        return new FolderSource(source, logger);
      case 'git':
        return new GitSource(source, logger);
      case 'server':
        return new RemoteSource(source, logger, remote);
    }
  });
}

export interface KnowledgeMcp {
  server: Server;
  backend: MultiSourceBackend;
  tools: AppTool[];
  /** Call a tool the way `tools/call` does (for tests and embedding). */
  callTool(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof toolSuccessResult> | ReturnType<typeof toolErrorResult>>;
}

/** Load every source, then build the MCP server over them. */
export async function createKnowledgeMcp(config: KnowledgeMcpConfig, logger: Logger, remote: RemoteSourceOptions = {}): Promise<KnowledgeMcp> {
  const sources = createSources(config, logger, remote);
  for (const source of sources) await source.load({ startup: true });
  const backend = new MultiSourceBackend(sources, logger);
  const tools = createAppTools(backend);
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));

  const callTool: KnowledgeMcp['callTool'] = async (name, args) => {
    try {
      const tool = byName.get(name);
      if (!tool) throw new KnowledgeToolError(404, `Unknown tool: ${name}`);
      return toolSuccessResult(await tool.call(args));
    } catch (err) {
      const known = mapKnownToolError(err);
      if (known) return toolErrorResult(known);
      const correlationId = randomBytes(6).toString('hex');
      logger.error(`tool ${name} failed [correlation_id=${correlationId}]: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return toolErrorResult(internalToolError(correlationId));
    }
  };

  const server = new Server({ name: 'knowledge-mcp', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.descriptor.name, title: t.descriptor.title, description: t.descriptor.description, inputSchema: t.descriptor.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
  return { server, backend, tools, callTool };
}

export async function serveStdio(mcp: KnowledgeMcp, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.server.connect(transport);
  logger.info(`ready: ${mcp.backend.sourceIds().length} source(s), ${mcp.tools.length} read-only tool(s), MCP over stdio`);
}
