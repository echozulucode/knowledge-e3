import { readFileSync } from 'node:fs';

/** Replaced at bundle time by esbuild's `define`; absent when running from source (tests). */
declare const __KNOWLEDGE_MCP_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __KNOWLEDGE_MCP_VERSION__ === 'string') return __KNOWLEDGE_MCP_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
export const PACKAGE_NAME = '@echozedlabs/knowledge-mcp';
