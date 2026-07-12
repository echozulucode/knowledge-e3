/**
 * Representative search queries for the benchmark.
 * Each query stresses a different aspect of the search path.
 */

export interface BenchQuery {
  name: string;
  /** The search query string */
  q: string;
  /** Optional tag filter */
  tag?: string;
  /** Optional sort mode */
  sort?: 'relevance' | 'newest' | 'oldest' | 'az';
  /** Description of what this query stresses */
  description: string;
}

export const BENCH_QUERIES: BenchQuery[] = [
  {
    name: 'single-word',
    q: 'retry',
    description: 'Single-word FTS query — tests BM25 scoring over basic token match.',
  },
  {
    name: 'two-word',
    q: 'database index',
    description: 'Multi-word FTS query — tests phrase/proximity handling.',
  },
  {
    name: 'common-term',
    q: 'the',
    description: 'Very common word — high recall, tests ranking with many matches.',
  },
  {
    name: 'rare-term',
    q: 'kubernetes',
    description: 'Rare/specialty term — low recall, tests index selectivity.',
  },
  {
    name: 'with-tag-filter',
    q: 'retry',
    tag: 'runbook',
    description: 'FTS + tag filter — tests combined WHERE clauses.',
  },
  {
    name: 'sort-newest',
    q: 'architecture',
    sort: 'newest',
    description: 'Override relevance sort with recency — tests sort mode dispatch.',
  },
  {
    name: 'sort-oldest',
    q: 'strategy',
    sort: 'oldest',
    description: 'Oldest-first sort — tests ASC order.',
  },
  {
    name: 'sort-az',
    q: 'guide',
    sort: 'az',
    description: 'Alphabetical sort — tests title collation.',
  },
  {
    name: 'empty-query-list-all',
    q: '',
    description: 'Empty query with no sort → list all; tests directList path.',
  },
  {
    name: 'single-word-many-results',
    q: 'page',
    description: 'High-volume match — tests ranking performance on large result sets.',
  },
  {
    name: 'phrase-like',
    q: 'error handling best practices',
    description: 'Long multi-word query — tests FTS with many tokens.',
  },
  {
    name: 'tag-only-filter',
    tag: 'infra',
    description: 'Filter by tag without full-text — tests tag index.',
  },
];
