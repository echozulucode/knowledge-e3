/**
 * @echozedlabs/search — parser, ranker, grouping, SearchProvider.
 * See the knowledge hub plan §3.5 and §9.
 */
export {
  parseSearchQuery,
  parseUpdatedFilter,
  canonicalIsValue,
  freeTextOf,
  hasTextSignal,
  SUPPORTED_SEARCH_FILTERS,
  IS_FILTER_VALUES,
  MIN_PREFIX_TERM_LENGTH,
  type ParsedSearchQuery,
  type ParsedFilters,
  type ParseSearchQueryOptions,
  type SearchFilterSpec,
  type SupportedFilterKey,
  type IsFilterValue,
  type UpdatedRange,
} from './query-parser.js';
export {
  excerpt,
  highlightRanges,
  plainTextForExcerpt,
  DEFAULT_EXCERPT_CHARS,
  type ExcerptMatch,
  type ExcerptOptions,
  type ExcerptResult,
} from './excerpt.js';
export {
  resolveItemFilters,
  passesItemFilters,
  matchesAuthor,
  matchesIs,
  withinUpdated,
  authorsOf,
  normalizeAuthor,
  type AuthoredSearchDoc,
  type ResolvedItemFilters,
} from './filter-semantics.js';
export { FtsRecencyRanker, type Ranker, type RankedResult, type PageCandidate } from './ranker.js';
export { groupHits, toGroupedResults, type GroupOptions } from './grouping.js';
export { applyLifecyclePolicy, type LifecyclePolicyOptions } from './lifecycle-policy.js';
export { InMemorySearchProvider, resolveFilters, tokenize, type ResolvedFilters } from './in-memory-provider.js';
export { evaluate, loadEvalCases, EVAL_QUERIES_PATH, type EvalCase, type EvalCaseResult, type EvalReport } from './eval.js';
export { EVAL_CORPUS } from './eval-corpus.js';
