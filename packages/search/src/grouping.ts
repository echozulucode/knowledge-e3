/**
 * Cross-type grouping of a ranked hit list (§3.5 item 1).
 *
 * Grouping is computed once, server-side, so REST and MCP hand out the same
 * groups. Hits keep their ranked order inside a group; groups are ordered by
 * the caller's preferred label order first, then by their best hit.
 */
import type { GroupedSearchResults, SearchGroup, SearchHit, SearchQuery } from '@echozedlabs/knowledge-types';

export interface GroupOptions {
  /** Grouping axis. Only content type is supported today. */
  by?: 'type';
  /** Maximum hits kept per group. Default 5. `total` still counts every hit. */
  capPerGroup?: number;
  /** Labels to list first, in this order; the remaining groups follow by best score. */
  order?: string[];
}

const UNTYPED_LABEL = 'Untyped';
const DEFAULT_CAP = 5;

export function groupHits(hits: SearchHit[], opts: GroupOptions = {}): SearchGroup[] {
  const cap = Math.max(0, opts.capPerGroup ?? DEFAULT_CAP);
  const buckets = new Map<string, SearchHit[]>();

  for (const hit of hits) {
    const label = hit.type ?? UNTYPED_LABEL;
    const bucket = buckets.get(label);
    if (bucket) {
      bucket.push(hit);
    } else {
      buckets.set(label, [hit]);
    }
  }

  const groups: SearchGroup[] = [];
  for (const [label, bucket] of buckets) {
    groups.push({ key: label, label, hits: bucket.slice(0, cap), total: bucket.length });
  }

  const order = opts.order ?? [];
  const preferredRank = (group: SearchGroup): number => {
    const index = order.indexOf(group.label);
    return index === -1 ? order.length : index;
  };
  const bestScore = (group: SearchGroup): number => group.hits[0]?.score ?? 0;

  return groups.sort((a, b) => preferredRank(a) - preferredRank(b) || bestScore(b) - bestScore(a));
}

export function toGroupedResults(query: SearchQuery, hits: SearchHit[], opts: GroupOptions = {}): GroupedSearchResults {
  return { query, groups: groupHits(hits, opts), total: hits.length };
}
