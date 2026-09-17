/**
 * Compose-feature hooks. Item lifecycle signals (trust tier, display state) are
 * only derived on `GET /items/:id` (KnowledgeQueryService), not on `/pages/*`,
 * so the read page fetches them here for its badges.
 */
import { useQuery } from '@tanstack/react-query';
import type { LifecycleSignals } from '@echozedlabs/knowledge-types';
import { apiClient } from '../../api.js';
import type { TaxonomyCategory } from '../../queries.js';

export function useItemSignals(id: string | undefined) {
  return useQuery({
    queryKey: ['item-signals', id ?? ''],
    queryFn: async () => {
      const res = await apiClient.get<{ item: (LifecycleSignals & { id: string }) | null }>(`/items/${encodeURIComponent(id!)}`);
      return res.item;
    },
    enabled: !!id,
    staleTime: 30_000,
  });
}

/**
 * The CURATED primary-category catalog — "what may I publish into".
 *
 * Distinct from `usePrimaryCategories`, which returns the catalog UNIONed with
 * the categories existing items happen to carry ("what exists") and is what
 * browse and the facets want. Primary categories are curated, not emergent
 * (Eric, 2026-09-11), so the Publish drawer offers only this list: an author
 * cannot invent a category, and the publish gate lints against exactly these
 * terms. Offering the union here would show terms the gate then refuses.
 */
export function useCuratedCategories() {
  return useQuery({
    queryKey: ['taxonomy', 'categories', 'curated'],
    queryFn: async () => {
      const res = await apiClient.get<{ categories: TaxonomyCategory[]; total: number }>('/taxonomy/categories?curated=1');
      return res.categories;
    },
    staleTime: 30_000,
  });
}
