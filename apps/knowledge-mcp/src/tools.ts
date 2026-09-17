/**
 * The stdio app's tool list: the shared read tools from `@echozedlabs/mcp-tools`
 * (same names, same arguments, plus an optional `source`), and two app-only
 * read tools, `knowledge.list_sources` and `knowledge.refresh`.
 *
 * There are no write tools. Nothing here creates, updates, publishes, imports
 * or exports content, and nothing runs a mutating request against a server.
 */
import {
  createReadTools,
  GET_ITEM_TOOL,
  KnowledgeToolError,
  LIST_SPACES_TOOL,
  LIST_TAXONOMY_TOOL,
  SEARCH_TOOL,
  VALIDATE_ITEM_TOOL,
  VALIDATE_OKF_BUNDLE_TOOL,
  type ToolDescriptor,
} from '@echozedlabs/mcp-tools';
import type { AppCallContext, MultiSourceBackend } from './backend.js';

export interface AppTool {
  descriptor: ToolDescriptor;
  call(input: Record<string, unknown>): Promise<unknown>;
}

const KEYWORD_ONLY = 'Keyword search only: whole words, quoted phrases, a trailing-word prefix, and key:value filters.';

function withSource(base: ToolDescriptor, sourceIds: string[], sourceText: string, extra: string, props: Record<string, unknown> = {}): ToolDescriptor {
  return {
    ...base,
    description: `${base.description} ${extra}`.trim(),
    inputSchema: {
      ...base.inputSchema,
      properties: {
        ...base.inputSchema.properties,
        ...props,
        source: { type: 'string', description: sourceText, enum: sourceIds },
      },
    },
  };
}

export function createAppTools(backend: MultiSourceBackend): AppTool[] {
  const ids = backend.sourceIds();
  const descriptors = {
    'knowledge.search': withSource(
      SEARCH_TOOL,
      ids,
      'Search only this configured source. Omit to search every source.',
      `Results are grouped PER SOURCE in \`sources[]\` (configuration order): each group carries \`source\`, its own \`results\` in that source's own rank order, and its own \`total\`. Scores from different sources are never compared or merged into one ranking, so read each group on its own. Every hit carries \`source\` and \`ref\` (\`<source>:<id>\`) — pass \`ref\` as \`id\` to knowledge.get_item. A source that fails appears as a group with \`error\` while the others still answer. Query syntax: tag:, category:, group:, type:, topic:, author:, updated:, is:, status:, -term, -key:value, "exact phrase". ${KEYWORD_ONLY}`,
    ),
    'knowledge.get_item': withSource(
      GET_ITEM_TOOL,
      ids,
      'Look only in this configured source.',
      'Refs from knowledge.search are source-qualified (`<source>:<id-or-slug>`) and name exactly one item; an unqualified id, slug or title that matches items in several sources is refused as ambiguous with the candidate refs.',
      { id: { type: 'string', description: 'Stable item id, or a source-qualified ref `<source>:<id-or-slug>` from knowledge.search.' } },
    ),
    'knowledge.list_spaces': withSource(LIST_SPACES_TOOL, ids, 'List only this source\'s topics.', 'Each entry carries `source`; topics with the same slug in two sources are different topics.'),
    'knowledge.list_taxonomy': withSource(LIST_TAXONOMY_TOOL, ids, 'List only this source\'s taxonomy.', 'Each entry carries `source`.'),
    'knowledge.validate_item': withSource(
      VALIDATE_ITEM_TOOL,
      ids,
      'Lint against this source\'s known tags, categories and groups. Omit to use the local sources\' combined vocabulary.',
      'This local server never writes or publishes; the publish rules are reported so the draft is ready for the server.',
    ),
    'knowledge.validate_okf_bundle': withSource(
      VALIDATE_OKF_BUNDLE_TOOL,
      ids,
      'With `topic`, lint against this source\'s vocabulary. Omit to use the local sources\' combined vocabulary.',
      'This local server has no import; the verdict predicts what a Knowledge E3 server import would do.',
    ),
  };
  const shared = createReadTools<AppCallContext>(backend, { descriptors });
  const tools: AppTool[] = shared.map((tool) => ({
    descriptor: tool.descriptor,
    call: (input) => tool.call(input, contextFrom(input, ids)),
  }));

  tools.push(
    {
      descriptor: {
        name: 'knowledge.list_sources',
        title: 'List configured sources',
        description:
          'List the sources this local server was configured with: id, type (folder, git, server), path or URL, item count, pull policy, and for a server source the NAME of its token environment variable and whether it is set. Only these sources are ever read.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      call: async () => backend.listSources(),
    },
    {
      descriptor: {
        name: 'knowledge.refresh',
        title: 'Re-read local sources',
        description:
          'Re-read the working trees of the local folder and git sources from disk and rebuild their in-memory keyword index (for example after editing files). Read-only: nothing is written and no git command runs.',
        inputSchema: {
          type: 'object',
          properties: { source: { type: 'string', description: 'Refresh only this source.', enum: ids } },
          additionalProperties: false,
        },
      },
      call: async (input) => backend.refresh(contextFrom(input, ids)),
    },
  );
  return tools;
}

function contextFrom(input: Record<string, unknown>, ids: string[]): AppCallContext {
  const source = input['source'];
  if (source === undefined) return {};
  if (typeof source !== 'string' || !ids.includes(source)) {
    throw new KnowledgeToolError(400, `Unknown source "${String(source)}". Configured sources: ${ids.join(', ')}.`, { sources: ids });
  }
  return { source };
}
