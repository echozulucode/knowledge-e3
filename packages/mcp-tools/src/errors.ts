/**
 * What a failing tool may tell an MCP client, shared by every host.
 *
 * Hosts differ in what they throw (the server throws Nest `HttpException`s, the
 * stdio app throws {@link KnowledgeToolError}) and in how they log an unexpected
 * failure (the server's logger with a correlation id; the app's stderr). They
 * must not differ in what reaches the client, so the JSON-RPC code table, the
 * sanitizer for structured fields and the `isError` envelope live here once.
 */

/** A tool failure as it may be shown to an MCP client. */
export interface MappedToolError {
  /** JSON-RPC error code (server-defined range for mapped HTTP statuses). */
  code: number;
  /** Public, human-readable message. Never an internal exception's text. */
  message: string;
  /** Structured, client-actionable fields, already sanitized. */
  data?: Record<string, unknown>;
  /** Set only for unknown failures: the id the host's log line carries. */
  correlationId?: string;
}

/** JSON-RPC's reserved "internal error" code. */
export const RPC_INTERNAL_ERROR = -32603;

/**
 * A refusal whose message is public by construction: a not-found, a bad
 * argument, a source that answered 401. Hosts without Nest throw this; its
 * `status` picks the JSON-RPC code the same way an `HttpException`'s does.
 */
export class KnowledgeToolError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'KnowledgeToolError';
    this.status = status;
    this.data = data;
  }
}

/** Map an HTTP status to a JSON-RPC error code in the server-defined range. */
export function rpcCodeForStatus(status: number): number {
  switch (status) {
    case 400: return -32602; // invalid params
    case 401: return -32001;
    case 403: return -32003;
    case 404: return -32004;
    case 409: return -32009;
    default: return -32000;
  }
}

/**
 * Map a public refusal. Returns `null` for anything that is not a
 * {@link KnowledgeToolError}, so the host decides how to hide and log it.
 */
export function mapKnownToolError(err: unknown): MappedToolError | null {
  if (!(err instanceof KnowledgeToolError)) return null;
  const data = sanitizeErrorData({ message: err.message, ...(err.data ?? {}) });
  return { code: rpcCodeForStatus(err.status), message: err.message, data };
}

/** The generic failure a client sees for anything unexpected: no internal text, just the id to quote. */
export function internalToolError(correlationId: string): MappedToolError {
  return {
    code: RPC_INTERNAL_ERROR,
    message: 'Internal error',
    data: { correlation_id: correlationId },
    correlationId,
  };
}

/** Keys that describe an exception's internals rather than the refusal itself. */
const INTERNAL_KEYS = new Set(['stack', 'cause']);

/**
 * A JSON-safe copy of an error body. Bodies are built by our own code and are
 * public by construction — but one that happens to embed an `Error`
 * (`{ message, cause: err }`) would otherwise serialize its message into the
 * client's view. Errors, functions and internals-named keys are dropped.
 */
export function sanitizeErrorData(value: object): Record<string, unknown> {
  const out = sanitize(value, 0);
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

function sanitize(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  // Depth cap: response bodies are shallow; anything deeper is not a payload a
  // client was ever meant to read.
  if (depth > 8 || value instanceof Error || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1)).filter((v) => v !== undefined);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_KEYS.has(key)) continue;
    const clean = sanitize(v, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

/**
 * A tool failure as an MCP `isError` result. The public message is the first
 * text block, so a model reading prose gets the refusal; the structured fields
 * (`code`, `correlation_id`, …) ride in `structuredContent.error` for a client
 * that acts on them, and are repeated as a JSON text block for clients that
 * predate `structuredContent`.
 */
export function toolErrorResult(mapped: MappedToolError): {
  content: ToolTextContent[];
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const text = mapped.correlationId ? `${mapped.message} (correlation id: ${mapped.correlationId})` : mapped.message;
  // `rpc_code`, not `code`: an error body's own `code` (`lint_failed`,
  // `changed_on_disk`, …) is one of the fields a client acts on and must survive.
  const error = { ...(mapped.data ?? {}), message: mapped.message, rpc_code: mapped.code };
  const content: ToolTextContent[] = [{ type: 'text', text }];
  if (mapped.data && Object.keys(mapped.data).length > 0) {
    content.push({ type: 'text', text: JSON.stringify({ error }, null, 2) });
  }
  return { content, structuredContent: { error }, isError: true };
}

/** A successful tool result: pretty JSON text plus `structuredContent` when the value is an object. */
export function toolSuccessResult(result: unknown): { content: ToolTextContent[]; structuredContent?: Record<string, unknown> } {
  const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}
