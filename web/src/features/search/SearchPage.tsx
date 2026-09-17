/**
 * SearchPage — `/search?q=…`, the one full search surface. The header's quick
 * search (⌘K) is the fast door to it; this is where a search is read, refined,
 * shared as a URL, and walked back to with the Back button.
 *
 * It is also where Browse and the tag view now live (§3.4): they left the
 * sidebar, so every path to them runs through here.
 *
 * Reader UX plan §5.5 — everything the server computes reaches this page:
 * facets with honest counts, the parser's warnings, the context-aware empty
 * state, a real total, and every filter round-tripped through the URL so a
 * search can be pasted into a ticket. §5.6 — scope is a narrowing the reader
 * chooses: the default is every topic, never the one they came from.
 *
 * LAYOUT (Eric, 2026-09-12: "work properly on multiple screens"). The page is
 * a size container, so the layout follows the room the page actually has —
 * the app sidebar and drawer change that independently of the viewport:
 *
 *  - wide (≥ 64rem): a sticky filters sidebar beside results held to a
 *    readable measure (52rem); extra width becomes margin, not longer lines.
 *  - medium: the same facets as horizontally scrolling chip rows above results.
 *  - narrow (< 40rem): full-width results, a "Filters (n)" button that opens
 *    the facets in a modal dialog, and the active filters as removable chips.
 *
 * The facets render ONCE inline (restyled per width in CSS) and once more
 * inside the dialog only while it is open, so a selector never meets two live
 * copies of the same option. Every group shows its top six options by count
 * and folds the rest behind "Show N more" at all three widths (`facets.ts`);
 * a chosen option is never folded away.
 *
 * With nothing typed and nothing filtered the page is an index of the library
 * (`SearchOverviewIndex`, reader plan R12) rather than a blank box. A filter
 * with no query is a search: `/search?topic=architecture` lists that topic's
 * items newest first — there is nothing to rank by relevance, so the Sort
 * select says Newest and offers no Relevance until a query exists.
 *
 * A topic filter is a SCOPE (§5.6): it is named at the top of the results as
 * "In Architecture ×", it survives typing a new query, and removing it widens
 * the same query to every topic.
 *
 * "Other ways into the library" sit below the results at every width, not in
 * the sidebar: results come first; the doors are what a reader wants when
 * search was the wrong tool, and on a phone the sidebar does not exist — one
 * position keeps one landmark rather than a copy per layout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ItemSlugLink } from '../../components/itemLink.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { Icon, appIcons } from '../../icons.js';
import { useTopics } from '../../queries.js';
import { NO_MATCHES_HINT } from './copy.js';
import { visibleFacetValues, type FacetOption } from './facets.js';
import { displayStateForHit, groupByType, reviewUrlForHit } from './grouping.js';
import { useSearchResults, type SearchFacets, type SearchFacetValue } from './queries.js';
import { SEARCH_TIPS, SUPPORTED_FILTER_HELP } from './searchSyntax.js';
import {
  activeFilterCount,
  clearAllFilters,
  clearAxis,
  effectiveSort,
  FILTER_AXES,
  filtersForNewQuery,
  filtersFromParams,
  hasActiveFilters,
  isFilterActive,
  isValueLabel,
  paramsFromFilters,
  resultCountLabel,
  sortOptionsFor,
  toggleFilterValue,
  toggleStatus,
  topicScopeLabel,
  type FilterAxis,
  type SearchFilters,
  type SearchPageParams,
  type SearchSortMode,
} from './searchParams.js';
import { ReadingPaneLayout } from '../reading-pane/ReadingPaneLayout.js';
import { SearchOverviewIndex } from './SearchOverviewIndex.js';
import { SearchResultRow } from './SearchResultRow.js';
import { useRecentSearches } from './useRecentSearches.js';
import './SearchPage.css';

/**
 * Hits requested per page. Larger than the palette's 25 because this is where a
 * search is read rather than jumped from; "Load more" walks the rest by offset,
 * and the count beside it is the server's real total.
 */
const SEARCH_PAGE_LIMIT = 100;

/**
 * One facet group: where its options come from, which of them the URL has on,
 * and how a chip changes the URL. Most groups are a repeatable axis written by
 * label; Trust writes `is` keys (`human-reviewed`), and Status is single-valued.
 */
interface FacetGroupSpec {
  key: string;
  heading: string;
  allLabel: string;
  ariaLabel: string;
  values: (f: SearchFacets) => SearchFacetValue[];
  selected: (filters: SearchFilters) => string[];
  toggle: (filters: SearchFilters, option: FacetOption) => SearchFilters;
  clear: (filters: SearchFilters) => SearchFilters;
  /** Whether the group is worth offering given its options (default: any option). */
  offered?: (values: SearchFacetValue[]) => boolean;
}

function axisGroup(axis: FilterAxis, heading: string, allLabel: string, ariaLabel: string, values: (f: SearchFacets) => SearchFacetValue[]): FacetGroupSpec {
  return {
    key: axis,
    heading,
    allLabel,
    ariaLabel,
    values,
    selected: (filters) => filters[axis],
    toggle: (filters, option) => toggleFilterValue(filters, axis, option.active ? matchedValue(filters, axis, option) : option.label),
    clear: (filters) => clearAxis(filters, axis),
  };
}

/** The facet groups, in the order a reader narrows: what kind, where, how filed, how trusted, whether live. */
const FACET_GROUPS: FacetGroupSpec[] = [
  axisGroup('type', 'Type', 'All types', 'Content type facets', (f) => f.types),
  axisGroup('topic', 'Topic', 'All topics', 'Topic facets', (f) => f.topics),
  axisGroup('category', 'Category', 'All categories', 'Primary category facets', (f) => f.categories),
  axisGroup('tag', 'Tag', 'All tags', 'Tag facets', (f) => f.tags),
  {
    // `is=` in the URL, as `is:` in a query: the tier KEY, never its label.
    key: 'is',
    heading: 'Trust',
    allLabel: 'Any trust',
    ariaLabel: 'Trust tier facets',
    values: (f) => f.trust_tiers,
    selected: (filters) => filters.is,
    toggle: (filters, option) => toggleFilterValue(filters, 'is', option.value),
    clear: (filters) => clearAxis(filters, 'is'),
  },
  {
    // Only a reader who can see drafts gets anything but "published" back, so a
    // group with one option would be a control that does nothing: hidden.
    key: 'status',
    heading: 'Status',
    allLabel: 'Any status',
    ariaLabel: 'Status facets',
    values: (f) => f.statuses,
    selected: (filters) => (filters.status ? [filters.status] : []),
    toggle: (filters, option) => toggleStatus(filters, option.value),
    clear: (filters) => ({ ...filters, status: undefined }),
    offered: (values) => values.some((value) => value.value !== 'published'),
  },
];

const AXIS_LABELS: Record<FilterAxis, string> = { type: 'Type', topic: 'Topic', category: 'Category', tag: 'Tag', group: 'Group', is: 'Trust' };

function groupOffered(group: FacetGroupSpec, facets: SearchFacets | undefined): boolean {
  const values = facets ? group.values(facets) : [];
  return values.length > 0 && (group.offered ? group.offered(values) : true);
}

export function SearchPage() {
  const navigate = useNavigate();
  const routeSearch = useRouterState({ select: (s) => s.location.search as SearchPageParams });
  const filters = useMemo(() => filtersFromParams(routeSearch), [routeSearch]);
  const routeQuery = filters.q;
  const { record: recordSearch } = useRecentSearches();
  const { data: topicDirectory = [] } = useTopics();
  const inputRef = useRef<HTMLInputElement>(null);
  // The route root, measured by the reading pane (features/reading-pane).
  const rootRef = useRef<HTMLElement>(null);

  const [input, setInput] = useState(routeQuery);
  useEffect(() => setInput(routeQuery), [routeQuery]);
  const [tipsOpen, setTipsOpen] = useState(false);

  // Refining a query REPLACES, so a search costs one history entry rather than
  // one per keystroke; `typing` keeps the effect from re-navigating when the URL
  // changed under us (Back, a link, the sidebar box).
  const debounced = useDebouncedValue(input, 250);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) return;
    typing.current = false;
    if (routeQuery === debounced) return;
    // A new query drops the facets: a filter chosen for the old results usually
    // matches nothing in the new ones, which reads as "no results". The topic
    // scope is kept — it was chosen, and it is on screen (searchParams.ts).
    go(filtersForNewQuery(filters, debounced), { replace: true });
  }, [debounced]);

  const { data, isFetching, isError, isPlaceholderData, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useSearchResults(filters, {
    pageSize: SEARCH_PAGE_LIMIT,
  });

  const pages = useMemo(() => data?.pages ?? [], [data]);
  const hits = useMemo(() => pages.flatMap((page) => page.results), [pages]);
  const groups = useMemo(() => groupByType(hits), [hits]);
  const facets = pages[0]?.facets;
  const warnings = pages[0]?.warnings ?? [];
  const emptyState = pages[0]?.empty_state;
  const total = pages[0]?.total ?? 0;
  const searching = isFetching && hits.length === 0;
  const hasSearch = routeQuery.trim() !== '' || hasActiveFilters(filters);
  const filterCount = activeFilterCount(filters);
  const hasFacetValues = FACET_GROUPS.some((group) => groupOffered(group, facets));
  // Filters are offered once there is something to narrow — or something
  // already narrowed, which must stay removable even when it matched nothing.
  const showFilters = hasSearch && !isError && (hasFacetValues || filterCount > 0);

  // Names for the topic scope: the facet's names, and the directory's slug/id →
  // name, because a topic page's link puts a slug in the URL.
  const scopeCandidates = useMemo(
    () => [
      ...(facets?.topics ?? []),
      ...topicDirectory.flatMap((topic) => [
        { value: topic.slug, label: topic.name },
        { value: topic.id, label: topic.name },
      ]),
    ],
    [facets, topicDirectory],
  );
  const scopeLabel = filters.topic.map((value) => topicScopeLabel(value, scopeCandidates)).join(' or ');

  function go(next: SearchFilters, opts: { replace?: boolean } = {}) {
    // `routeSearch` carries an open reading pane through the change (searchParams.ts).
    navigate({ to: '/search', search: paramsFromFilters(next, routeSearch) as never, replace: opts.replace ?? true });
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    typing.current = false;
    const q = input.trim();
    // Submitting is a search performed, so it is remembered for the quick
    // search's recents — even when the debounce already put it in the URL.
    if (q) recordSearch(q);
    if (q === routeQuery) return;
    navigate({ to: '/search', search: paramsFromFilters(filtersForNewQuery(filters, q), routeSearch) as never });
  };

  // ── Filters dialog (narrow layout) ────────────────────────────────────────
  // A native modal <dialog>: focus moves in on open, Escape closes, and the
  // rest of the page is inert meanwhile. Selections apply live through the URL
  // like everywhere else, so there is no "Apply" step to forget.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const filtersButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (filtersOpen && !dialog.open) dialog.showModal();
    else if (!filtersOpen && dialog.open) dialog.close();
  }, [filtersOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `close` fires for Escape, the Done button and a backdrop click alike.
    const onClose = () => {
      setFiltersOpen(false);
      filtersButtonRef.current?.focus();
    };
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, []);

  // Which facet groups are showing every option rather than the top six. One
  // state for the inline filters and the dialog alike: they are the same
  // filters, and a group expanded in one should not snap shut in the other.
  const [expandedAxes, setExpandedAxes] = useState<Record<string, boolean>>({});

  /** Every facet group, as toggle buttons. `idPrefix` keeps the dialog's copy's ids unique. */
  const facetGroups = (idPrefix: string) =>
    FACET_GROUPS.map((group) => {
      const { key, heading, allLabel, ariaLabel } = group;
      const values = facets ? group.values(facets) : [];
      const selected = group.selected(filters);
      const narrowed = selected.length > 0;
      if (!groupOffered(group, facets) && !narrowed) return null;
      const expanded = !!expandedAxes[key];
      // Top six by count, plus anything already chosen wherever it ranks — a
      // filter that is on is never folded out of sight (facets.ts).
      const { shown, hiddenCount, collapsible } = visibleFacetValues(values, selected, { expanded });
      const headingId = `${idPrefix}-${key}`;
      const listId = `${idPrefix}-${key}-options`;
      return (
        <div key={key} className="Search__facetGroup" role="group" aria-labelledby={headingId}>
          <h3 id={headingId} className="Search__facetHeading">{heading}</h3>
          <div className="Search__facets" id={listId} aria-label={ariaLabel}>
            <button
              type="button"
              className={`Search__facet ${narrowed ? '' : 'active'}`}
              aria-pressed={!narrowed}
              onClick={() => go(group.clear(filters))}
            >
              <span className="Search__facetLabel">{allLabel}</span>
              {/* The count is the whole match only while nothing on this axis is
                  applied; claiming it under a narrowing would be a wrong number. */}
              {narrowed ? null : <span className="Search__facetCount">{total}</span>}
            </button>
            {shown.map((option) => (
              <button
                key={`${key}:${option.value}`}
                type="button"
                className={`Search__facet ${option.active ? 'active' : ''}`}
                aria-pressed={option.active}
                onClick={() => go(group.toggle(filters, option))}
              >
                <span className="Search__facetLabel">{key === 'is' && option.count === null ? isValueLabel(option.label) : option.label}</span>
                {option.count === null ? null : <span className="Search__facetCount">{option.count}</span>}
              </button>
            ))}
            {/* Last in the list, so it stays put under the pointer as options
                appear above it, and sits at the end of a medium-width chip row. */}
            {collapsible ? (
              <button
                type="button"
                className="Search__facetMore"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpandedAxes((current) => ({ ...current, [key]: !expanded }))}
              >
                {expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
              </button>
            ) : null}
          </div>
        </div>
      );
    });

  const clearFiltersButton =
    filterCount > 0 ? (
      <button type="button" className="Search__clear" onClick={() => go(clearAllFilters(filters))}>
        Clear filters
      </button>
    ) : null;

  const page = (
    <main ref={rootRef} className="Search" aria-labelledby="search-title">
      <div className="Search__inner">
        <header className="Search__header">
          <h1 id="search-title">Search</h1>
          <form className="Search__form" onSubmit={onSubmit} role="search">
            <span className="Search__formIcon" aria-hidden="true">
              <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
            </span>
            <input
              ref={inputRef}
              className="Search__input"
              data-search-input="true"
              type="text"
              enterKeyHint="search"
              value={input}
              onChange={(e) => {
                typing.current = true;
                setInput(e.target.value);
              }}
              placeholder="Search concepts, guides, FAQs, decisions…"
              aria-label="Search knowledge"
              autoFocus
            />
            <button type="submit" className="Search__go">Search</button>
          </form>

          <div className="Search__tips">
            <button type="button" className="Search__tipsToggle" aria-expanded={tipsOpen} onClick={() => setTipsOpen((open) => !open)}>
              <Icon icon={appIcons.circleQuestion} fixedWidth={false} /> Search tips
            </button>
            {tipsOpen ? (
              <div className="Search__tipsPanel">
                <dl className="Search__tipsList">
                  {SUPPORTED_FILTER_HELP.map((filter) => (
                    <div key={filter.example} className="Search__tip">
                      <dt><code>{filter.example}</code></dt>
                      <dd>{filter.description}</dd>
                    </div>
                  ))}
                </dl>
                <ul className="Search__tipsNotes">
                  {SEARCH_TIPS.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </header>

        <div className={`Search__layout ${showFilters ? 'Search__layout--filtered' : ''} ${hasSearch ? '' : 'Search__layout--index'}`}>
          {/* Wide: the sticky sidebar. Medium: chip rows above the results.
              Narrow: hidden — the Filters button opens the dialog below. */}
          {showFilters ? (
            <aside className="Search__filters" aria-labelledby="search-filters-title">
              <div className="Search__filtersHead">
                <h2 id="search-filters-title" className="Search__filtersTitle">Filters</h2>
                {clearFiltersButton}
              </div>
              {/* Facets straight off the server, counted over every match rather
                  than over this page, so an option's number means what it says. */}
              {facetGroups('search-facet')}
            </aside>
          ) : null}

          <div className="Search__main" aria-busy={isPlaceholderData || undefined}>
            {/* The scope, named where the results start (§5.6). Separate from the
                facet state on purpose: a scope is where the reader chose to
                look, and taking it off is "search everywhere", not "untick". */}
            {hasSearch && filters.topic.length > 0 ? (
              <div className="Search__scope" data-testid="search-scope">
                <button
                  type="button"
                  className="Search__scopeChip"
                  aria-label={`Remove scope: in ${scopeLabel}. Search all topics`}
                  onClick={() => {
                    go(clearAxis(filters, 'topic'));
                    // The chip is gone once removed; the box is the next thing to use.
                    inputRef.current?.focus();
                  }}
                >
                  <span>In {scopeLabel}</span>
                  <Icon icon={appIcons.xmark} fixedWidth={false} />
                </button>
              </div>
            ) : null}

            {showFilters ? (
              <div className="Search__filterBar">
                <button
                  ref={filtersButtonRef}
                  type="button"
                  className="Search__filtersButton"
                  aria-haspopup="dialog"
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen(true)}
                >
                  <Icon icon={appIcons.sliders} fixedWidth={false} />
                  <span>Filters{filterCount > 0 ? ` (${filterCount})` : ''}</span>
                </button>
                {filterCount > 0 ? (
                  <ul className="Search__activeFilters" aria-label="Active filters" role="list">
                    {FILTER_AXES.flatMap((axis) =>
                      filters[axis].map((value) => (
                        <li key={`${axis}:${value}`}>
                          <button
                            type="button"
                            className="Search__activeChip"
                            aria-label={`Remove ${AXIS_LABELS[axis]} filter ${axis === 'is' ? isValueLabel(value) : value}`}
                            onClick={() => {
                              go(toggleFilterValue(filters, axis, value));
                              // The chip is gone once removed; keep focus nearby.
                              filtersButtonRef.current?.focus();
                            }}
                          >
                            <span>{axis === 'is' ? isValueLabel(value) : axis === 'topic' ? topicScopeLabel(value, scopeCandidates) : value}</span>
                            <Icon icon={appIcons.xmark} fixedWidth={false} />
                          </button>
                        </li>
                      )),
                    )}
                    {filters.status ? (
                      <li>
                        <button
                          type="button"
                          className="Search__activeChip"
                          aria-label={`Remove Status filter ${filters.status}`}
                          onClick={() => {
                            go({ ...filters, status: undefined });
                            filtersButtonRef.current?.focus();
                          }}
                        >
                          <span>{filters.status === 'published' ? 'Published' : 'Draft'}</span>
                          <Icon icon={appIcons.xmark} fixedWidth={false} />
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {/* A dropped or unhonoured operator is never silent again (§5.5). */}
            {warnings.length && hasSearch ? (
              <div className="Search__warnings" role="status">
                <Icon icon={appIcons.triangleExclamation} fixedWidth={false} />
                <ul>
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {!hasSearch ? (
              <SearchOverviewIndex />
            ) : isError ? (
              <div className="Search__empty">
                <h2>Search is unavailable</h2>
                <p>The index did not answer. Try again, or browse by topic.</p>
                <div className="Search__ways">
                  <button type="button" className="Search__way" onClick={() => void refetch()}>
                    <Icon icon={appIcons.clockRotateLeft} fixedWidth={false} /> Try again
                  </button>
                  <Link to="/topics" className="Search__way">
                    <Icon icon={appIcons.bookOpen} fixedWidth={false} /> Browse by topic
                  </Link>
                </div>
              </div>
            ) : searching ? (
              <p className="Search__muted" aria-busy="true">Searching…</p>
            ) : hits.length === 0 ? (
              <div className="Search__empty">
                <h2>
                  {routeQuery.trim() ? <>No matches for &lsquo;{routeQuery}&rsquo;</> : (emptyState?.title ?? 'No items match the current filters')}
                </h2>
                {/* The server's guidance names the filters to relax; the constant is
                    the fallback for a response that carried none. */}
                {(emptyState?.guidance ?? [NO_MATCHES_HINT]).map((line) => (
                  <p key={line}>{line}</p>
                ))}
                <div className="Search__ways">
                  {hasActiveFilters(filters) ? (
                    <button type="button" className="Search__way" onClick={() => go(clearAllFilters(filters))}>
                      <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} /> Search everything
                    </button>
                  ) : null}
                  <Link to="/browse" search={{ view: 'grouped' } as never} className="Search__way">
                    <Icon icon={appIcons.list} fixedWidth={false} /> Browse the whole library
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="Search__toolbar">
                  <div className="Search__summary" role="status">
                    <span>{resultCountLabel(hits.length, total, routeQuery)}</span>
                  </div>
                  <label className="Search__sort">
                    <span>Sort</span>
                    <select
                      value={effectiveSort(filters)}
                      onChange={(e) => go({ ...filters, sort: e.target.value as SearchSortMode })}
                      aria-label="Sort results"
                    >
                      {sortOptionsFor(filters).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                {groups.map((group) => (
                  <section key={group.key} className="Search__group" aria-label={`${group.label} results`}>
                    <div className="Search__groupHead">
                      <h2>{group.label}</h2>
                      {/* Narrows THIS page to the type rather than handing off to
                          Browse: one index, one results destination (home plan R2.3). */}
                      <Link
                        to="/search"
                        search={paramsFromFilters({ ...filters, type: [group.label] }, routeSearch) as never}
                        className="Search__seeAll"
                      >
                        See all {group.total} <Icon icon={appIcons.chevronRight} fixedWidth={false} />
                      </Link>
                    </div>
                    <ul className="Search__rows" role="list">
                      {group.hits.map((hit) => (
                        <li key={hit.id}>
                          {/* Opens in the reading pane on an extra-wide route (itemLink.tsx). */}
                          <ItemSlugLink slug={hit.slug} className="Search__row">
                            <SearchResultRow
                              title={hit.title}
                              type={hit.type}
                              displayState={displayStateForHit(hit)}
                              reviewUrl={reviewUrlForHit(hit)}
                              trustTier={hit.trust_tier}
                              topic={hit.topic}
                              snippet={hit.snippet}
                              highlights={hit.highlights}
                              snippetTruncated={hit.snippet_truncated}
                              updatedAt={hit.updated_at}
                              matchedFields={hit.matched_fields}
                            />
                          </ItemSlugLink>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {hasNextPage ? (
                  <button type="button" className="Search__more" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? 'Loading…' : `Load more (${total - hits.length} left)`}
                  </button>
                ) : null}
              </>
            )}

            {/* Browse and the tag view left the sidebar (§3.4); these are their doors. */}
            <nav className="Search__waysNav" aria-labelledby="search-ways-title">
              <h2 id="search-ways-title" className="Search__waysTitle">Other ways into the library</h2>
              <div className="Search__ways">
                <Link to="/browse" search={{ view: 'grouped' } as never} className="Search__way">
                  <Icon icon={appIcons.list} fixedWidth={false} /> Browse all items
                </Link>
                <Link to="/browse" search={{ view: 'tags' } as never} className="Search__way">
                  <Icon icon={appIcons.tag} fixedWidth={false} /> Browse by tag
                </Link>
                <Link to="/topics" className="Search__way">
                  <Icon icon={appIcons.bookOpen} fixedWidth={false} /> Topics
                </Link>
                <Link to="/sections" className="Search__way">
                  <Icon icon={appIcons.layerGroup} fixedWidth={false} /> Sections
                </Link>
              </div>
            </nav>
          </div>
        </div>
      </div>

      {/* Narrow layout's filters. Its content exists only while open, so the
          inline facets stay the only copy on the page the rest of the time. */}
      <dialog
        ref={dialogRef}
        className="Search__dialog"
        aria-labelledby="search-filters-dialog-title"
        onClick={(e) => {
          // A click on the ::backdrop lands on the <dialog> itself.
          if (e.target === e.currentTarget) setFiltersOpen(false);
        }}
      >
        {filtersOpen ? (
          <div className="Search__dialogBody">
            <div className="Search__dialogHead">
              <h2 id="search-filters-dialog-title" className="Search__filtersTitle">Filters</h2>
              <button type="button" className="Search__dialogDone" onClick={() => setFiltersOpen(false)}>
                Done
              </button>
            </div>
            <div className="Search__dialogFacets">
              {hasFacetValues ? facetGroups('search-dialog-facet') : <p className="Search__muted">Nothing to narrow in these results.</p>}
            </div>
            <div className="Search__dialogFoot">
              {clearFiltersButton}
              <button type="button" className="Search__go" onClick={() => setFiltersOpen(false)}>
                {isFetching ? 'Updating…' : `Show ${total} ${total === 1 ? 'result' : 'results'}`}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </main>
  );

  // On an extra-wide route a result opens beside the list; otherwise this is the page, unwrapped.
  return <ReadingPaneLayout rootRef={rootRef}>{page}</ReadingPaneLayout>;
}

/**
 * Which spelling of a facet value is in the URL, so toggling it off removes the
 * one that is actually there (a chip may be applied by label or by key).
 */
function matchedValue(filters: SearchFilters, axis: FilterAxis, value: Pick<SearchFacetValue, 'label' | 'value'>): string {
  return isFilterActive(filters, axis, value.label) ? value.label : value.value;
}
