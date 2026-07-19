import { ANONYMOUS_ACTOR } from '../../auth/auth-mode.js';

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  /**
   * True when the tool mutates content. Write tools are hidden from, and
   * refused for, anonymous callers on a public instance (see isAnonymousContext).
   * Declared per-tool rather than as a name list elsewhere, so a new tool has to
   * state its own intent and cannot be silently omitted from the check.
   */
  write?: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface McpToolContext {
  user?: { id: string; role: string };
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

export interface McpTool<TInput extends Record<string, unknown> = Record<string, unknown>, TOutput = unknown> {
  descriptor: McpToolDescriptor;
  call(input: TInput, context?: McpToolContext): Promise<TOutput>;
}

export function stringProp(description: string, enumValues?: string[]) {
  return enumValues ? { type: 'string', description, enum: enumValues } : { type: 'string', description };
}
