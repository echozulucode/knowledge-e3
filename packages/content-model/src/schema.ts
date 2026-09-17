/**
 * Per-type frontmatter schema and starter template. Plain data, no schema library:
 * the web composer, MCP tools, and lint all read the same declarative field list.
 */
import { CONTENT_TYPES, findContentType, type ContentTypeField } from './registry.js';

export interface SchemaField {
  key: string;
  label: string;
  type: ContentTypeField['type'] | 'date';
  required: boolean;
  description?: string;
}

/** Fields every item carries regardless of type. */
const BASE_FIELDS: SchemaField[] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'description', label: 'Description', type: 'textarea', required: false, description: 'One or two sentences; required to publish.' },
  { key: 'tags', label: 'Tags', type: 'tags', required: false },
  { key: 'status', label: 'Status', type: 'text', required: false, description: 'draft | published' },
  { key: 'stale_after', label: 'Review by', type: 'date', required: false, description: 'ISO date after which the item needs review.' },
  { key: 'authors', label: 'Authors', type: 'tags', required: false },
];

/** Base fields plus the registry type's domain fields. Unknown types get the base fields only. */
export function schemaFor(type: string): SchemaField[] {
  const extra = (findContentType(type)?.fields ?? []).map((f) => ({ ...f, required: false }));
  return [...BASE_FIELDS, ...extra];
}

/** The registry template body for the type, or the Concept template for unknown types. */
export function templateFor(type: string): string {
  return (findContentType(type) ?? CONTENT_TYPES.find((t) => t.key === 'concept')!).template;
}
