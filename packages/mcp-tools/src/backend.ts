/**
 * The read backend a host implements, and the tools built over it.
 *
 * A host (the NestJS server, the stdio app) supplies the data; this module
 * owns the tool names, the argument normalization and the call routing, so the
 * same `tools/call` arguments mean the same query on either host. `Ctx` is the
 * host's own caller context (the server's authenticated user; nothing for the
 * stdio app, whose visibility comes from its configured sources).
 */
import {
  GET_ITEM_TOOL,
  LIST_CONTENT_TYPES_TOOL,
  LIST_SPACES_TOOL,
  LIST_TAXONOMY_TOOL,
  READ_TOOL_DESCRIPTORS,
  SEARCH_TOOL,
  VALIDATE_ITEM_TOOL,
  VALIDATE_OKF_BUNDLE_TOOL,
  type ReadToolName,
  type ToolDescriptor,
} from './descriptors.js';
import {
  normalizeItemRef,
  normalizeSearchInput,
  normalizeValidateItemInput,
  normalizeValidateOkfBundleInput,
  type ItemRefInput,
  type SearchToolInput,
  type ValidateItemInput,
  type ValidateOkfBundleInput,
} from './normalize.js';
import type { ValidateItemResult, ValidateOkfBundleResult } from './results.js';

export interface KnowledgeReadBackend<Ctx = void> {
  /** `knowledge.search` → the host's result set (the server's: `results`, `total`, `facets`, `groups`, …). */
  search(input: SearchToolInput, ctx: Ctx): Promise<unknown>;
  /** `knowledge.get_item` → `{ item }`; a miss throws a public not-found. */
  getItem(ref: ItemRefInput, ctx: Ctx): Promise<unknown>;
  /** `knowledge.list_spaces` → `{ spaces, total }`. */
  listSpaces(ctx: Ctx): Promise<unknown>;
  /** `knowledge.list_taxonomy` → `{ tags, categories, groups }`. */
  listTaxonomy(ctx: Ctx): Promise<unknown>;
  /** `knowledge.list_content_types` → `{ content_types }`. */
  listContentTypes(ctx: Ctx): Promise<unknown>;
  /** `knowledge.validate_item` — lint only, nothing written. */
  validateItem(input: ValidateItemInput, ctx: Ctx): Promise<ValidateItemResult>;
  /** `knowledge.validate_okf_bundle` — three-tier report, nothing written. */
  validateOkfBundle(input: ValidateOkfBundleInput, ctx: Ctx): Promise<ValidateOkfBundleResult>;
}

export interface ReadTool<Ctx = void> {
  descriptor: ToolDescriptor;
  call(input: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}

type Dispatch = <Ctx>(backend: KnowledgeReadBackend<Ctx>, input: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

const DISPATCH: Record<ReadToolName, Dispatch> = {
  'knowledge.search': (backend, input, ctx) => backend.search(normalizeSearchInput(input), ctx),
  'knowledge.get_item': (backend, input, ctx) => backend.getItem(normalizeItemRef(input), ctx),
  'knowledge.list_spaces': (backend, _input, ctx) => backend.listSpaces(ctx),
  'knowledge.list_taxonomy': (backend, _input, ctx) => backend.listTaxonomy(ctx),
  'knowledge.list_content_types': (backend, _input, ctx) => backend.listContentTypes(ctx),
  'knowledge.validate_item': (backend, input, ctx) => backend.validateItem(normalizeValidateItemInput(input), ctx),
  'knowledge.validate_okf_bundle': (backend, input, ctx) =>
    backend.validateOkfBundle(normalizeValidateOkfBundleInput(input), ctx),
};

export function isReadToolName(name: string): name is ReadToolName {
  return Object.prototype.hasOwnProperty.call(DISPATCH, name);
}

/**
 * Call one read tool: normalize the untrusted arguments and route them to the
 * backend. The single path every host's `tools/call` goes through for reads.
 */
export function callReadTool<Ctx>(
  name: ReadToolName,
  backend: KnowledgeReadBackend<Ctx>,
  input: Record<string, unknown>,
  ctx: Ctx,
): Promise<unknown> {
  return DISPATCH[name](backend, input, ctx);
}

export interface CreateReadToolsOptions {
  /**
   * Replace a descriptor for this host — e.g. the stdio app adds a `source`
   * argument and states its per-source result rule. The name must not change.
   */
  descriptors?: Partial<Record<ReadToolName, ToolDescriptor>>;
}

/** The read tools over one backend, in the canonical listing order. */
export function createReadTools<Ctx>(backend: KnowledgeReadBackend<Ctx>, opts: CreateReadToolsOptions = {}): ReadTool<Ctx>[] {
  return READ_TOOL_DESCRIPTORS.map((base) => {
    const name = base.name as ReadToolName;
    const descriptor = opts.descriptors?.[name] ?? base;
    if (descriptor.name !== name) throw new Error(`descriptor override for ${name} renames it to ${descriptor.name}`);
    return { descriptor, call: (input: Record<string, unknown>, ctx: Ctx) => callReadTool(name, backend, input, ctx) };
  });
}

export const READ_TOOLS_BY_NAME: Readonly<Record<ReadToolName, ToolDescriptor>> = {
  'knowledge.search': SEARCH_TOOL,
  'knowledge.get_item': GET_ITEM_TOOL,
  'knowledge.list_spaces': LIST_SPACES_TOOL,
  'knowledge.list_taxonomy': LIST_TAXONOMY_TOOL,
  'knowledge.list_content_types': LIST_CONTENT_TYPES_TOOL,
  'knowledge.validate_item': VALIDATE_ITEM_TOOL,
  'knowledge.validate_okf_bundle': VALIDATE_OKF_BUNDLE_TOOL,
};
