/**
 * TanStack-style query keys as plain arrays. No dependency on
 * `@tanstack/react-query`, so web can adopt them one hook at a time. Where web
 * already has a key for the same data, the shape here matches it so both
 * paths share one cache entry during the migration.
 */
import type { ListItemsParams, SearchParams } from './types.js';

export const meKeys = {
  all: ['me'] as const,
};

export const itemKeys = {
  all: ['items'] as const,
  lists: () => [...itemKeys.all, 'list'] as const,
  list: (params: ListItemsParams = {}) => [...itemKeys.lists(), params] as const,
  details: () => [...itemKeys.all, 'detail'] as const,
  detail: (id: string) => [...itemKeys.details(), id] as const,
};

export const pageKeys = {
  bySlug: (slug: string) => ['pages-by-slug', slug] as const,
};

export const searchKeys = {
  all: ['search'] as const,
  query: (params: SearchParams = {}) => [...searchKeys.all, params] as const,
};

export const topicKeys = {
  all: ['topics'] as const,
};

export const sectionKeys = {
  all: ['sections'] as const,
};

export const contentTypeKeys = {
  all: ['content-types'] as const,
};

export const taxonomyKeys = {
  all: ['taxonomy'] as const,
  tags: (q = '') => [...taxonomyKeys.all, 'tags', q] as const,
  categories: (q = '') => [...taxonomyKeys.all, 'categories', q] as const,
  groups: (q = '') => [...taxonomyKeys.all, 'groups', q] as const,
};
