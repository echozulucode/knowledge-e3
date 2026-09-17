import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '@nestjs/common';
import { findContentType, listContentTypes, schemaFor, templateFor } from '@echozedlabs/content-model';
import { toolErrorResult, toolSuccessResult } from '@echozedlabs/mcp-tools';
import type { McpService } from './mcp.service.js';
import { mapMcpToolError } from './mcp-errors.js';
import type { McpToolContext } from './tools/schemas.js';
import type { PagesService } from '../pages/pages.service.js';
import type { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { viewerFrom } from '../query/viewer.js';
import type { SpacesService } from '../taxonomy/spaces.service.js';

export interface McpServerDeps {
  mcp: McpService;
  pages: PagesService;
  query: KnowledgeQueryService;
  spaces: SpacesService;
}

const SERVER_INFO = { name: 'knowledge-e3', version: '0.1.0' } as const;

const INSTRUCTIONS =
  'Knowledge E3 is a Markdown-first, OKF/Git-backed knowledge base. Use tools to ' +
  'search, read, and create source-backed knowledge; resources expose concept ' +
  'Markdown at okf://concept/<id> (alias knowledge://item/<id>); prompts scaffold typed content (troubleshooting, ' +
  'FAQ, runbook, review). To write: read knowledge://templates/<type> and knowledge://taxonomy, draft the ' +
  'document, run knowledge.validate_item (fix every error) and knowledge.suggest_metadata, then knowledge.create_item. ' +
  'Call knowledge.publish_item with reviewed: true only after the user has read the result; it records their verification.';

/** Static knowledge:// resources, listed alongside the concrete concept resources. */
const STATIC_RESOURCES = [
  {
    uri: 'knowledge://templates',
    name: 'Content-type templates',
    description: 'Index of content types with the URI of each template resource.',
    mimeType: 'application/json',
  },
  {
    uri: 'knowledge://taxonomy',
    name: 'Taxonomy',
    description: 'Topics, primary categories, tags, and groups visible to the caller.',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'knowledge://templates/{content-type-key}',
    name: 'Content-type template',
    description: 'Template body and frontmatter schema fields for one content type (keys from knowledge://templates).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'knowledge://item/{id}',
    name: 'Knowledge item',
    description: 'Raw Markdown of one item by stable id (alias of okf://concept/{id}).',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'knowledge://topic/{slug}',
    name: 'Topic',
    description: 'Topic metadata and counts as JSON.',
    mimeType: 'application/json',
  },
];

function jsonContents(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] };
}

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

const errorLogger = new Logger('McpServer');

/**
 * Render a tool failure as an MCP `isError` result. What the exception may say
 * is decided by `mapMcpToolError`, the same mapping the legacy JSON-RPC surface
 * uses (issue 45) — this function only chooses the envelope. The public message
 * is the first text block, so a model reading prose gets the refusal; the
 * structured fields (`duplicate_title`, `code`, `correlation_id`, …) ride in
 * `structuredContent.error` for a client that acts on them, and are repeated as
 * a JSON text block for clients that predate `structuredContent`.
 */
function errorResult(err: unknown) {
  return toolErrorResult(mapMcpToolError(err, errorLogger));
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
    // Context-aware: anonymous callers on a public instance see the read-only
    // subset. McpService.callToolByName still enforces it.
    tools: deps.mcp.listTools(ctx).map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await deps.mcp.callToolByName(req.params.name, req.params.arguments ?? {}, ctx);
      return toolSuccessResult(result);
    } catch (err) {
      return errorResult(err);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const items = await deps.pages.list({ limit: 200 }, actor);
    return {
      resources: [
        ...STATIC_RESOURCES,
        ...items.map((p) => ({
          uri: `okf://concept/${p.id}`,
          name: p.title,
          description: summaryOf(p.frontmatter),
          mimeType: 'text/markdown',
        })),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const concept = /^(?:okf:\/\/concept|knowledge:\/\/item)\/([^/]+)(?:\/raw)?$/.exec(uri);
    if (concept) {
      const page = await deps.pages.getById(concept[1]!, { actor });
      if (!page) throw new McpError(ErrorCode.InvalidParams, `No concept for ${uri}`);
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: page.raw_markdown || page.body_markdown || '' }],
      };
    }
    if (uri === 'knowledge://templates') {
      return jsonContents(
        uri,
        listContentTypes().map((t) => ({ key: t.key, label: t.label, description: t.description, uri: `knowledge://templates/${t.key}` })),
      );
    }
    const template = /^knowledge:\/\/templates\/([^/]+)$/.exec(uri);
    if (template) {
      const def = findContentType(decodeURIComponent(template[1]!));
      if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown content type for ${uri}`);
      return jsonContents(uri, {
        key: def.key,
        label: def.label,
        description: def.description,
        defaultFrontmatter: def.defaultFrontmatter,
        fields: schemaFor(def.label),
        template: templateFor(def.label),
      });
    }
    const viewer = viewerFrom(ctx.user);
    if (uri === 'knowledge://taxonomy') {
      const anonymousViewer = viewer.role === 'anonymous';
      const [topics, categories, tags, groups] = await Promise.all([
        deps.query.topics(viewer),
        deps.spaces.listCategories(undefined, { anonymousViewer }),
        deps.spaces.listTags(undefined, { anonymousViewer }),
        deps.spaces.listGroups(undefined, { anonymousViewer }),
      ]);
      return jsonContents(uri, {
        topics: topics.map((t) => ({ slug: t.slug, name: t.name, description: t.description })),
        categories,
        tags,
        groups,
      });
    }
    const topic = /^knowledge:\/\/topic\/([^/]+)$/.exec(uri);
    if (topic) {
      const view = await deps.query.topic(decodeURIComponent(topic[1]!), viewer);
      if (!view) throw new McpError(ErrorCode.InvalidParams, `No topic for ${uri}`);
      return jsonContents(uri, view);
    }
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
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
