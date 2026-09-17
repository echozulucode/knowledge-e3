import type { ItemRefInput, McpItem, SearchToolInput } from '@echozedlabs/mcp-tools';

export type SourceType = 'folder' | 'git' | 'server';

/** What a source says about itself in `knowledge.list_sources`. Never a token, its length or prefix. */
export interface SourceInfo {
  id: string;
  type: SourceType;
  status: 'ready' | 'error';
  /** Local sources: the configured directory. */
  path?: string;
  /** Server sources: the API root. */
  url?: string;
  items?: number;
  topics?: string[];
  pull?: string;
  last_pull?: string;
  /** Server sources: the NAME of the token variable, and whether it is set. */
  token_env?: string;
  token_present?: boolean;
  error?: string;
}

export type SourceItem = Omit<McpItem, 'url'> & { url?: string; source: string; ref: string };

export interface SourceVocabulary {
  tags: string[];
  categories: string[];
  groups: string[];
  slugs?: string[];
}

/** One configured source. Every method is read-only. */
export interface KnowledgeSource {
  readonly id: string;
  readonly type: SourceType;
  /** Build the index (local) or check configuration (server). Called at startup and by knowledge.refresh. */
  load(opts?: { startup?: boolean }): Promise<void>;
  /** This source's result set, in its own rank order. */
  search(input: SearchToolInput): Promise<Record<string, unknown>>;
  /** `null` when the source has no such item visible to this caller. */
  getItem(ref: ItemRefInput): Promise<SourceItem | null>;
  listSpaces(): Promise<object[]>;
  listTaxonomy(): Promise<{ tags: object[]; categories: object[]; groups: object[] }>;
  vocabulary(): Promise<SourceVocabulary>;
  info(): SourceInfo;
}
