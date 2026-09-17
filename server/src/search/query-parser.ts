// Implementation moved to packages/search (@echozedlabs/search).
// This shim keeps the existing server import paths working.
export {
  parseSearchQuery,
  freeTextOf,
  hasTextSignal,
  SUPPORTED_SEARCH_FILTERS,
  type ParsedSearchQuery,
  type SearchFilterSpec,
} from '@echozedlabs/search';
