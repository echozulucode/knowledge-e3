export interface McpToolDescriptor {
  name: string;
  title?: string;
  description: string;
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

export interface McpTool<TInput extends Record<string, unknown> = Record<string, unknown>, TOutput = unknown> {
  descriptor: McpToolDescriptor;
  call(input: TInput, context?: McpToolContext): Promise<TOutput>;
}

export function stringProp(description: string, enumValues?: string[]) {
  return enumValues ? { type: 'string', description, enum: enumValues } : { type: 'string', description };
}
