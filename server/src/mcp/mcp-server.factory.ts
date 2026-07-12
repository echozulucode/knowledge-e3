import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { HttpException } from '@nestjs/common';
import type { McpService } from './mcp.service.js';
import type { McpToolContext } from './tools/schemas.js';
import type { PagesService } from '../pages/pages.service.js';

export interface McpServerDeps {
  mcp: McpService;
  pages: PagesService;
}

const SERVER_INFO = { name: 'knowledge-e3', version: '0.1.0' } as const;

const INSTRUCTIONS =
  'Knowledge E3 is a Markdown-first, OKF/Git-backed knowledge base. Use tools to ' +
  'search, read, and create source-backed knowledge; resources expose concept ' +
  'Markdown at okf://concept/<id>; prompts scaffold typed content (troubleshooting, ' +
  'FAQ, runbook, review).';

/** Prompt templates (north-star §10). Kept small and content-type oriented. */
const PROMPTS: Array<{
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  build: (args: Record<string, string>) => string;
}> = [
  {
    name: 'troubleshoot',
    description: 'Draft a symptom-first Troubleshooting Guide.',
    arguments: [
      { name: 'symptom', description: 'The observed symptom or error', required: true },
      { name: 'product', description: 'Affected product/component' },
    ],
    build: (a) =>
      `Write an OKF "Troubleshooting Guide" concept for the symptom: "${a.symptom}"${a.product ? ` on ${a.product}` : ''}.\n` +
      'Use these sections: Symptom, Applies to, Quick checks, Likely causes, Diagnostic steps, Fix, Verification, Escalation, Related. ' +
      'Add frontmatter with type: Troubleshooting Guide and symptoms/severity where known.',
  },
  {
    name: 'create-faq',
    description: 'Draft a concise FAQ entry.',
    arguments: [{ name: 'question', description: 'The recurring question', required: true }],
    build: (a) =>
      `Write an OKF "FAQ" concept answering: "${a.question}". One-line question, a concise authoritative answer, and Related links. Frontmatter type: FAQ.`,
  },
  {
    name: 'create-runbook',
    description: 'Draft an operational Runbook.',
    arguments: [{ name: 'procedure', description: 'The procedure to document', required: true }],
    build: (a) =>
      `Write an OKF "Runbook" for: "${a.procedure}". Sections: Purpose, Preconditions, Steps, Verification, Rollback, Escalation. Frontmatter type: Runbook.`,
  },
  {
    name: 'review-okf-page',
    description: 'Review a concept for OKF quality (frontmatter, links, citations, structure).',
    arguments: [{ name: 'id', description: 'Concept id (see okf://concept/<id>)', required: true }],
    build: (a) =>
      `Read the resource okf://concept/${a.id} and review it: is the frontmatter valid (non-empty type, title, description)? Are links resolvable? Is the structure appropriate for its content type? List concrete fixes.`,
  },
];

function summaryOf(fm: Record<string, unknown> | undefined): string | undefined {
  const s = fm && typeof fm['summary'] === 'string' ? (fm['summary'] as string).trim() : '';
  return s || undefined;
}

function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  let text = 'Tool failed.';
  if (err instanceof HttpException) {
    const resp = err.getResponse();
    text = typeof resp === 'string' ? resp : ((resp as Record<string, unknown>)['message'] as string) ?? err.message;
  } else if (err instanceof Error) {
    text = err.message;
  }
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Build a fresh spec-compliant MCP Server for one request/session, bound to the
 * caller's context. The SDK handles the initialize lifecycle, capability
 * advertisement, and JSON-RPC framing; we register the handlers.
 */
export function createMcpServer(deps: McpServerDeps, ctx: McpToolContext): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: INSTRUCTIONS,
  });
  const actor = ctx.user ? { id: ctx.user.id, role: ctx.user.role as 'user' | 'admin' } : undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.mcp.listTools().map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await deps.mcp.callToolByName(req.params.name, req.params.arguments ?? {}, ctx);
      const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        ...(structured ? { structuredContent: structured } : {}),
      };
    } catch (err) {
      return errorResult(err);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const items = await deps.pages.list({ limit: 200 }, actor);
    return {
      resources: items.map((p) => ({
        uri: `okf://concept/${p.id}`,
        name: p.title,
        description: summaryOf(p.frontmatter),
        mimeType: 'text/markdown',
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const m = /^okf:\/\/concept\/([^/]+)(?:\/raw)?$/.exec(uri);
    if (!m) throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
    const page = await deps.pages.getById(m[1]!, { actor });
    if (!page) throw new McpError(ErrorCode.InvalidParams, `No concept for ${uri}`);
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: page.raw_markdown || page.body_markdown || '' }],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    return {
      description: prompt.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.build(args) } }],
    };
  });

  return server;
}
