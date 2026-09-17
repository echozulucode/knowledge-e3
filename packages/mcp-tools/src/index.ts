/**
 * @echozedlabs/mcp-tools — the one MCP read-tool contract.
 *
 * The server's HTTP MCP (`server/src/mcp`) and the stdio `@echozedlabs/knowledge-mcp`
 * app both advertise these descriptors, normalize arguments with these
 * functions, route calls through `callReadTool`, and render results and
 * failures with the same envelopes. See the project plan, "stdio MCP server".
 *
 * Read tools only. Search is keyword search only — lexical token matching and
 * key:value filters, on both hosts.
 */
export {
  stringProp,
  bundleFilesSchema,
  SEARCH_SORTS,
  SEARCH_TOOL,
  GET_ITEM_TOOL,
  LIST_SPACES_TOOL,
  LIST_TAXONOMY_TOOL,
  LIST_CONTENT_TYPES_TOOL,
  VALIDATE_ITEM_TOOL,
  VALIDATE_OKF_BUNDLE_TOOL,
  READ_TOOL_DESCRIPTORS,
  type ToolDescriptor,
  type ToolInputSchema,
  type ReadToolName,
} from './descriptors.js';
export {
  normalizeSearchInput,
  normalizeItemRef,
  normalizeValidateItemInput,
  normalizeValidateOkfBundleInput,
  normalizeBundleFiles,
  type SearchToolInput,
  type ItemRefInput,
  type ValidateItemInput,
  type ValidateOkfBundleInput,
  type BundleFileInput,
} from './normalize.js';
export {
  validationResult,
  toMcpItem,
  ITEM_NOT_FOUND_MESSAGE,
  type ValidateItemResult,
  type ValidateOkfBundleResult,
  type McpItem,
  type McpItemSource,
  type GetItemResult,
} from './results.js';
export {
  KnowledgeToolError,
  RPC_INTERNAL_ERROR,
  rpcCodeForStatus,
  mapKnownToolError,
  internalToolError,
  sanitizeErrorData,
  toolErrorResult,
  toolSuccessResult,
  type MappedToolError,
  type ToolTextContent,
} from './errors.js';
export {
  callReadTool,
  createReadTools,
  isReadToolName,
  READ_TOOLS_BY_NAME,
  type KnowledgeReadBackend,
  type ReadTool,
  type CreateReadToolsOptions,
} from './backend.js';
