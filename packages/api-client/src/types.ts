/**
 * Response and request shapes the server returns today that have no exact
 * counterpart in `@echozedlabs/knowledge-types`. Field names mirror the server
 * (`server/src/**`) one-to-one; when the server adopts the shared DTOs these
 * collapse onto the knowledge-types re-exports.
 */
import type { PublicationStatus, SortMode, TrustTier } from '@echozedlabs/knowledge-types';

/** `GET /me` → `user`. */
export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
}

/** `GET /topics` → `topics[]` (server `SpaceWithCountsView`). */
export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  visibility: 'public' | 'private';
  color: string | null;
  icon: string | null;
  counts: { items: number; published: number; draft: number };
}

/** `GET /taxonomy/{tags,categories,groups}` entries (server `TaxonomyCountView`). */
export interface TaxonomyEntry {
  id: string;
  name: string;
  slug: string;
  count: number;
  color: string | null;
  icon: string | null;
  scope: { type: 'global' | 'space'; space_id: string | null; space_slug: string | null };
}

export interface ContentTypeField {
  key: string;
  label: string;
  type: 'text' | 'tags' | 'textarea';
  description?: string;
}

/** `GET /content-types` → `content_types[]`. */
export interface ContentType {
  key: string;
  label: string;
  description: string;
  icon: string;
  group: string;
  fields: ContentTypeField[];
  defaultFrontmatter: Record<string, unknown>;
  template: string;
}

/** `GET /items` query. */
export interface ListItemsParams {
  q?: string;
  status?: PublicationStatus;
  tag?: string;
  since?: string;
  limit?: number;
}

/** `POST /items` body (the server's `CreateItemDto`). */
export interface CreateItemInput {
  title?: string;
  body?: string;
  raw?: string;
  raw_markdown?: string;
  frontmatter?: Record<string, unknown>;
  status?: PublicationStatus;
  tags?: string[];
}

/** `PUT /items/:id` body (the server's `UpdateItemDto`). */
export type UpdateItemInput = CreateItemInput;

/** `GET /search` query. */
export interface SearchParams {
  q?: string;
  tag?: string;
  category?: string;
  group?: string;
  space?: string;
  status?: PublicationStatus;
  since?: string;
  sort?: SortMode;
  include_drafts?: boolean;
  limit?: number;
  offset?: number;
}

/** One `GET /search` result (server `SearchHit`). */
export interface SearchResult {
  id: string;
  slug: string;
  title: string;
  path?: string;
  url?: string;
  updated_at: string;
  status: PublicationStatus;
  type?: string | null;
  score: number;
  snippet?: string;
  topic?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  matched_fields?: string[];
  reasons?: string[];
  trust_tier?: TrustTier;
  stale?: boolean;
}

export interface SearchFacetValue {
  value: string;
  label: string;
  count: number;
  active?: boolean;
}

export interface SearchFacets {
  topics: SearchFacetValue[];
  statuses: SearchFacetValue[];
  tags: SearchFacetValue[];
  trust_tiers: SearchFacetValue[];
}

export interface SearchEmptyState {
  title: string;
  guidance: string[];
  can_create_from_search: boolean;
}

/** `GET /search` response (server `SearchResultSet`). */
export interface SearchResultSet {
  results: SearchResult[];
  total: number;
  facets: SearchFacets;
  warnings: string[];
  empty_state?: SearchEmptyState;
}
