/**
 * Input normalization for the read tools. JSON-RPC arguments are untrusted:
 * a value of the wrong type is dropped (never coerced into something the caller
 * did not say), exactly as the server's tools always treated them.
 */
import type { SortMode } from '@echozedlabs/knowledge-types';

export interface SearchToolInput {
  q?: string;
  space?: string;
  tag?: string;
  category?: string;
  group?: string;
  type?: string;
  status?: 'draft' | 'published';
  limit?: number;
  sort: SortMode;
  include_drafts: boolean;
}

export function normalizeSearchInput(input: Record<string, unknown>): SearchToolInput {
  const sort = input['sort'];
  const status = input['status'];
  return {
    q: stringOrUndefined(input['q']),
    space: stringOrUndefined(input['space']),
    tag: stringOrUndefined(input['tag']),
    category: stringOrUndefined(input['category']),
    group: stringOrUndefined(input['group']),
    type: stringOrUndefined(input['type']),
    status: status === 'draft' || status === 'published' ? status : undefined,
    include_drafts: input['include_drafts'] === true,
    sort: sort === 'newest' || sort === 'oldest' || sort === 'az' || sort === 'verified' ? sort : 'relevance',
    limit: typeof input['limit'] === 'number' ? input['limit'] : undefined,
  };
}

/** How `knowledge.get_item` names an item: stable id first, then slug, then exact title. */
export interface ItemRefInput {
  id?: string;
  slug?: string;
  title?: string;
}

export function normalizeItemRef(input: Record<string, unknown>): ItemRefInput {
  const out: ItemRefInput = {};
  const id = trimmed(input['id']);
  const slug = trimmed(input['slug']);
  const title = trimmed(input['title']);
  if (id) out.id = id;
  if (slug) out.slug = slug;
  if (title) out.title = title;
  return out;
}

export interface ValidateItemInput {
  raw_markdown: string;
  topic?: string;
  published?: boolean;
}

export function normalizeValidateItemInput(input: Record<string, unknown>): ValidateItemInput {
  const out: ValidateItemInput = { raw_markdown: typeof input['raw_markdown'] === 'string' ? input['raw_markdown'] : '' };
  const topic = trimmed(input['topic']);
  if (topic) out.topic = topic;
  if (typeof input['published'] === 'boolean') out.published = input['published'];
  return out;
}

/** One file of an OKF bundle as the MCP surface accepts it. */
export interface BundleFileInput {
  path: string;
  content: string;
}

export interface ValidateOkfBundleInput {
  files: BundleFileInput[];
  topic?: string;
}

export function normalizeValidateOkfBundleInput(input: Record<string, unknown>): ValidateOkfBundleInput {
  const out: ValidateOkfBundleInput = { files: normalizeBundleFiles(input['files']) };
  const topic = trimmed(input['topic']);
  if (topic) out.topic = topic;
  return out;
}

/** Drop anything that is not a `{ path, content }` pair; JSON-RPC input is untrusted. */
export function normalizeBundleFiles(value: unknown): BundleFileInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (f): f is BundleFileInput =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Record<string, unknown>)['path'] === 'string' &&
      typeof (f as Record<string, unknown>)['content'] === 'string',
  );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
