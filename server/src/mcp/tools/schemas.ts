import type { ToolDescriptor } from '@echozedlabs/mcp-tools';
import { ANONYMOUS_ACTOR } from '../../auth/auth-mode.js';

/**
 * A tool's descriptor. The type — and every READ tool's descriptor — comes from
 * `@echozedlabs/mcp-tools`, the contract this server and the stdio knowledge-mcp
 * app share. `write: true` is what hides a tool from, and refuses it for,
 * anonymous and read-scoped-token callers (see isAnonymousContext).
 */
export type McpToolDescriptor = ToolDescriptor;

export interface McpToolContext {
  /** The authenticated caller; `username` (present on real sessions) names the OKF actor for writes.
   * `token` is set when the caller authenticated with a personal access token. */
  user?: { id: string; role: string; username?: string; token?: { id: string; scope: 'read' | 'write' } };
}

/**
 * Whether this call is an unauthenticated visitor on a public instance. The
 * guard binds ANONYMOUS_ACTOR for those; its id can never own content, so reads
 * are already filtered to published items by the normal non-admin rules. This
 * check exists to deny WRITES, which those filters say nothing about.
 */
export function isAnonymousContext(context: McpToolContext = {}): boolean {
  return context.user?.id === ANONYMOUS_ACTOR.id;
}

/** Whether the caller authenticated with a read-scoped personal access token. */
export function isReadTokenContext(context: McpToolContext = {}): boolean {
  return context.user?.token?.scope === 'read';
}

export interface McpTool<TInput extends Record<string, unknown> = Record<string, unknown>, TOutput = unknown> {
  descriptor: McpToolDescriptor;
  call(input: TInput, context?: McpToolContext): Promise<TOutput>;
}

// Shared with the stdio app: one declaration of these helpers for both hosts.
export { stringProp, bundleFilesSchema, normalizeBundleFiles, type BundleFileInput } from '@echozedlabs/mcp-tools';
