import { randomBytes } from 'node:crypto';
import { HttpException, type LoggerService } from '@nestjs/common';
import {
  internalToolError,
  mapKnownToolError,
  rpcCodeForStatus,
  RPC_INTERNAL_ERROR,
  sanitizeErrorData,
  type MappedToolError,
} from '@echozedlabs/mcp-tools';

/**
 * A tool failure as it may be shown to an MCP client — the ONE place that
 * decides what an exception is allowed to say about itself. Both MCP transports
 * render this shape: the legacy `/mcp/jsonrpc` surface as a JSON-RPC `error`
 * object, the spec-compliant `/mcp` endpoint as an `isError` tool result. They
 * used to decide separately, and the second copy returned raw `err.message` for
 * everything that was not an `HttpException` (issue 45).
 */
export type McpToolError = MappedToolError;

/** JSON-RPC's reserved "internal error" code, and the status table — shared with the stdio app. */
export { RPC_INTERNAL_ERROR, rpcCodeForStatus };

/**
 * Map a thrown value to what an MCP client may see.
 *
 * - `HttpException` (BadRequest/Conflict/Forbidden/NotFound/…, including the
 *   deliberately-structured 5xx refusals like `review_host_unconfigured`): the
 *   status-derived JSON-RPC code, the exception's public message, and its
 *   structured response fields (`duplicate_title`, `code`, `reason`, …) in
 *   `data` so a client can act on them instead of parsing prose.
 * - Anything else (TypeError, SQLite, git, fs…): a generic "Internal error"
 *   plus a short correlation id. The real error — message and stack — goes to
 *   the server log under that id and nowhere else. A SQLite message names
 *   tables and columns; a git one names filesystem paths; neither is the
 *   client's business, but an operator handed the id can find the line.
 */
export function mapMcpToolError(err: unknown, logger: Pick<LoggerService, 'error'>): McpToolError {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    const data = typeof response === 'string' ? { detail: response } : sanitizeErrorData(response);
    return { code: rpcCodeForStatus(status), message: publicMessage(response, err), data };
  }
  // A refusal built with the shared contract's error type is public the same way.
  const known = mapKnownToolError(err);
  if (known) return known;
  // Short on purpose: it is read aloud and pasted into bug reports. 48 bits is
  // plenty to find one log line among a day's failures.
  const correlationId = randomBytes(6).toString('hex');
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  logger.error(`MCP tool failed [correlation_id=${correlationId}]`, detail);
  return internalToolError(correlationId);
}

function publicMessage(response: string | object, err: HttpException): string {
  if (typeof response === 'string') return response;
  const message = (response as Record<string, unknown>)['message'];
  if (typeof message === 'string') return message;
  // ValidationPipe-style bodies carry a list of messages.
  if (Array.isArray(message) && message.every((m) => typeof m === 'string')) return message.join('; ');
  return err.message;
}
