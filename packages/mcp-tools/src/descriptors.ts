/**
 * The READ tool descriptors every Knowledge E3 MCP host advertises.
 *
 * One declaration per tool, consumed by the server's HTTP MCP (`server/src/mcp`)
 * and by the stdio `@echozedlabs/knowledge-mcp` app, so an agent sees the same
 * names, titles and input schemas against a local folder as against the
 * intranet server. The server's MCP tests are the contract for the text here:
 * change a description and `tools/list` changes on both surfaces.
 *
 * Write tools (create/update/publish/import/export/suggest) are deliberately
 * NOT here: they stay server-only until the stdio app grows write support.
 */

/** A JSON Schema object for a tool's arguments, as MCP's `tools/list` carries it. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  /**
   * True when the tool mutates content. Write tools are hidden from, and
   * refused for, anonymous callers on a public instance. Every descriptor in
   * this module is a read tool, so none sets it.
   */
  write?: boolean;
  inputSchema: ToolInputSchema;
}

export function stringProp(description: string, enumValues?: string[]) {
  return enumValues ? { type: 'string', description, enum: enumValues } : { type: 'string', description };
}

/**
 * The single declaration of "a set of OKF bundle files", shared by `import_okf`
 * and `validate_okf_bundle`. One definition rather than two copies, so an agent
 * that can form an input for the validator can hand the identical object to the
 * importer — the point of exposing the validator at all.
 */
export const bundleFilesSchema = {
  type: 'array',
  description: 'OKF bundle files: each an object with `path` and `content` (Markdown).',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Bundle-relative path, e.g. concepts/orders.md.' },
      content: { type: 'string', description: 'Full concept document (frontmatter + body).' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export const SEARCH_SORTS = ['relevance', 'newest', 'oldest', 'az', 'verified'] as const;

export const SEARCH_TOOL: ToolDescriptor = {
  name: 'knowledge.search',
  title: 'Search knowledge items',
  description:
    'Search knowledge items with REST-parity filters. Use space/topic, tag, category, group, status, limit, and sort to narrow results; returned hits include stable item ids plus display names and taxonomy context.',
  inputSchema: {
    type: 'object',
    properties: {
      q: stringProp('Full-text query. Omit with sort=newest/oldest/az to browse filtered items.'),
      space: stringProp('Space/topic id, slug, or display name to filter results.'),
      tag: stringProp('Tag slug/display name to filter results.'),
      category: stringProp('Category slug/display name to filter results.'),
      group: stringProp('Group id, slug, or display name to filter results.'),
      type: stringProp('Content type label (e.g. Runbook, FAQ), matched case-insensitively.'),
      status: stringProp('Lifecycle status filter.', ['draft', 'published']),
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum number of results to return.' },
      sort: stringProp('Sort mode. `verified` = most recently verified first, unverified last.', [...SEARCH_SORTS]),
      include_drafts: { type: 'boolean', description: 'Include draft items when authorized; status=draft also implies draft visibility.' },
    },
    additionalProperties: false,
  },
};

export const GET_ITEM_TOOL: ToolDescriptor = {
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
};

export const LIST_SPACES_TOOL: ToolDescriptor = {
  name: 'knowledge.list_spaces',
  title: 'List knowledge spaces/topics',
  description:
    'List active knowledge spaces/topics with stable ids, slugs, display names, optional visual metadata, and item counts. Use this before filtering search or creating items by space/topic.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const LIST_TAXONOMY_TOOL: ToolDescriptor = {
  name: 'knowledge.list_taxonomy',
  title: 'List tags, categories, and groups',
  description:
    'List taxonomy values agents can use to filter knowledge.search: tags and categories are global; groups include their stable id, display name, count, and space scope metadata.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const LIST_CONTENT_TYPES_TOOL: ToolDescriptor = {
  name: 'knowledge.list_content_types',
  title: 'List content types',
  description:
    'List the first-class content types (OKF concept kinds) this knowledge base recognizes. Each has a `label` (write it to frontmatter `type`), a `description`, `defaultFrontmatter` (domain fields to seed), and a `template` (starter Markdown body). Use before create_item to choose the right kind and scaffold. Unknown types remain accepted, but prefer these.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const VALIDATE_ITEM_TOOL: ToolDescriptor = {
  name: 'knowledge.validate_item',
  title: 'Validate a draft',
  description:
    'Run the content-model lint on a raw Markdown document without saving it: required `type` and exactly one known primary category (errors), unknown tags and unresolved wiki-links (warnings), default `stale_after` (info), and the publish-time rules (`description`; `published_at`/authors for Blog Posts) when `published` is true. Fix every error before publishing: an error-severity diagnostic refuses every publication (publish_item, update_item taking a draft to `status: "published"`, and create_item with `status: "published"`) with 422 `lint_failed`. Draft creates, ordinary draft saves and saves of an already-published item are never refused.',
  inputSchema: {
    type: 'object',
    properties: {
      raw_markdown: stringProp('Full raw Markdown document with optional frontmatter.'),
      topic: stringProp('Topic slug/id the item targets.'),
      published: { type: 'boolean', description: 'Apply the publish-time rules regardless of the frontmatter status.' },
    },
    required: ['raw_markdown'],
    additionalProperties: false,
  },
};

export const VALIDATE_OKF_BUNDLE_TOOL: ToolDescriptor = {
  name: 'knowledge.validate_okf_bundle',
  title: 'Validate an OKF bundle',
  description:
    'Check an Open Knowledge Format (OKF v0.2) bundle — the same { path, content } files knowledge.import_okf takes — and return three separate tiers plus a summary. NOTHING IS WRITTEN. Read `summary.conformant`: false means the input is not an OKF bundle and an import WOULD BE REFUSED WHOLE (no partial write). Read `summary.meetsPolicy`: false means the content breaks this instance\'s editorial rules; the import still SUCCEEDS and the failures are recorded as content diagnostics, so this is never a reason to withhold a bundle. The `advisory` tier (unresolved cross-references, trust/provenance/freshness notes) blocks nothing at all — a link into another bundle is legitimate OKF. Pass `topic` to additionally lint tags and categories against that topic\'s known vocabulary; the import itself does not, so those findings are advice, not a prediction.',
  inputSchema: {
    type: 'object',
    properties: {
      files: bundleFilesSchema,
      topic: stringProp(
        'Topic slug/id whose known tags and categories the policy tier should lint against. Omit to check structure only — which is exactly what an import checks.',
      ),
    },
    required: ['files'],
    additionalProperties: false,
  },
};

/** Every shared read tool, in the order the server has always listed them. */
export const READ_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  LIST_SPACES_TOOL,
  LIST_TAXONOMY_TOOL,
  LIST_CONTENT_TYPES_TOOL,
  SEARCH_TOOL,
  VALIDATE_OKF_BUNDLE_TOOL,
  VALIDATE_ITEM_TOOL,
  GET_ITEM_TOOL,
];

export type ReadToolName =
  | 'knowledge.search'
  | 'knowledge.get_item'
  | 'knowledge.list_spaces'
  | 'knowledge.list_taxonomy'
  | 'knowledge.list_content_types'
  | 'knowledge.validate_item'
  | 'knowledge.validate_okf_bundle';
