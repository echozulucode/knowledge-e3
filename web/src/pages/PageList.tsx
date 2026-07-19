/**
 * Page list view: Linear-style dense list redesign (J-β).
 * 56px rows, pill-based status/tags, keyboard navigation (j/k/arrows).
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, RefObject } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { usePages, useSearch, useCreatePage, useTopics, usePrimaryCategories, useContentTypes, useMe, type Page, type SearchResult, type TaxonomyCategory, type Topic } from '../queries.js';
import { extractCopyableEntries } from '../features/items/copyableContent.js';
import { buildItemDraftMarkdown } from '../features/items/titleHeadingSync.js';
import { TopicSwitcher } from '../features/topics/TopicSwitcher.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { ContentTypeBadge } from '../components/ContentTypeBadge.js';
import {
  buildTopicDirectory,
  buildTopicLookup,
  buildTopicOptions,
  describeActiveTopicFilter,
  displayFromSlug,
  matchesFilter,
  normalizedFilterCandidates,
  slugifyFilterValue,
  topicForPage,
  topicMatchesFilter,
  type TopicLookup,
} from '../features/topics/topicFilters.js';
import { Icon, appIcons } from '../icons.js';
import './PageList.css';

type SortKey = 'updated_desc' | 'created_desc' | 'title_asc';
type StatusFilter = 'draft' | 'published';
type BrowseView = 'tags' | 'grouped' | 'cards' | 'list';
type MetadataFilterKey = 'topic' | 'category' | 'tag' | 'group';

interface BrowseSearchParams {
  view?: string;
  q?: string;
  status?: string;
  sort?: string;
  /** OKF concept kind facet (content type). */
  type?: string;
  /** Legacy alias retained so old shared URLs keep working while the UI says Topic. */
  space?: string;
  topic?: string;
  category?: string;
  tag?: string;
  group?: string;
}

interface ComposerState {
  title: string;
  type: string;
  space: string;
  status: 'draft' | 'published';
  category: string;
  tags: string;
  tagEntry: string;
  groups: string;
  summary: string;
  body: string;
}

function createInitialComposer(seedTag = ''): ComposerState {
  return {
    title: '',
    type: 'concept',
    space: '',
    status: 'draft',
    category: '',
    tags: seedTag,
    tagEntry: '',
    groups: '',
    summary: '',
    body: '',
  };
}

function searchParamString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asBrowseView(value: string | undefined): BrowseView {
  if (value === 'tags' || value === 'grouped' || value === 'list') return value;
  return 'cards';
}

function asSortKey(value: string | undefined): SortKey {
  return value === 'created_desc' || value === 'title_asc' || value === 'updated_desc' ? value : 'updated_desc';
}

function asStatusFilters(value: string | undefined): Set<StatusFilter> {
  const filters = new Set<StatusFilter>();
  for (const part of value?.split(',') ?? []) {
    const status = part.trim();
    if (status === 'draft' || status === 'published') filters.add(status);
  }
  return filters;
}

type CategoryLookup = Map<string, TaxonomyCategory>;

function buildCategoryLookup(categories: TaxonomyCategory[]): CategoryLookup {
  const lookup = new Map<string, TaxonomyCategory>();
  for (const category of categories) {
    lookup.set(category.slug, category);
  }
  return lookup;
}

function displayCategorySlug(slug: string, categoryLookup?: CategoryLookup): string {
  const category = categoryLookup?.get(slug);
  const name = category?.name.trim();
  return name && name !== slug ? name : displayFromSlug(slug);
}

function fieldMatches(value: string | undefined | null, query: string): boolean {
  return Boolean(value?.toLowerCase().includes(query));
}

function searchReasonsForPage(page: Page, query: string, topicLookup?: TopicLookup, categoryLookup?: CategoryLookup): string[] {
  if (!query) return [];
  const reasons: string[] = [];
  if (fieldMatches(page.title, query)) reasons.push('Title match');
  if (fieldMatches(page.body_markdown, query) || fieldMatches(page.raw_markdown, query)) reasons.push('Body match');
  for (const tag of page.tags ?? []) {
    if (fieldMatches(tag, query)) reasons.push(`Tag: ${tag}`);
  }
  for (const category of page.categories ?? []) {
    const displayCategory = displayCategorySlug(category, categoryLookup);
    if (fieldMatches(category, query) || fieldMatches(displayCategory, query)) reasons.push(`Category: ${displayCategory}`);
  }
  for (const group of page.groups ?? []) {
    if (fieldMatches(group, query)) reasons.push(`Group: ${group}`);
  }
  const topic = topicForPage(page, topicLookup);
  if (fieldMatches(topic, query)) reasons.push(`Space: ${topic}`);
  return [...new Set(reasons)].slice(0, 5);
}

// NOTE: the former client-side ranker (scorePageForQuery) and matcher
// (pageMatchesSearch) were removed when browse moved to the server search
// pipeline — a query's membership and order now come from GET /search, so browse
// and the palette can no longer diverge. searchReasonsForPage remains, purely to
// annotate result cards with best-effort "why it matched" chips.

/**
 * Build a render-ready Page from a server SearchResult, for the rare case a hit
 * isn't in the loaded page set (results beyond the loaded window). The server's
 * snippet stands in for the body so previews still render. Normally a hit is
 * hydrated from the full page set instead — see queryPages.
 */
function pageFromSearchHit(hit: SearchResult): Page {
  return {
    id: hit.id,
    slug: hit.slug,
    title: hit.title,
    body_markdown: hit.snippet ?? '',
    status: hit.status ?? 'published',
    type: hit.type ?? null,
    version_token: 0,
    created_at: hit.updated_at,
    updated_at: hit.updated_at,
    tags: hit.tags ?? [],
    categories: hit.categories ?? [],
    groups: hit.groups ?? [],
    frontmatter: hit.topic ? { topic: hit.topic } : {},
  };
}

function searchWith(next: BrowseSearchParams): BrowseSearchParams {
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  ) as BrowseSearchParams;
}

function uniqueChipKey(kind: MetadataFilterKey, value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

function splitComposerList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function slugifyComposerValue(value: string): string {
  return slugifyFilterValue(value);
}

function normalizeComposerList(value: string): string[] {
  return splitComposerList(value)
    .map((part) => slugifyComposerValue(part))
    .filter(Boolean);
}

const CATEGORY_USAGE_GUIDANCE = 'Use one primary purpose category such as Research notes, Decision record, How-to, Reference, Runbook, Experiment, or Meeting notes. Extra categories are useful only when an item genuinely serves two durable purposes; prefer tags or groups for looser cross-cutting labels.';

type HelpKey = 'type' | 'topic' | 'status' | 'primary-category' | 'tags' | 'groups' | 'summary' | 'body';

const HELP_TEXT: Record<HelpKey, string> = {
  type: 'The kind of content (an OKF concept type). It picks a starter template and domain fields — e.g. a Troubleshooting Guide scaffolds symptom → checks → fix → verify.',
  topic: 'The space this item belongs to. Pick the space where you would expect to browse for it later.',
  status: 'Draft is work-in-progress. Published means it is ready to rely on in search, links, and reviews.',
  'primary-category': CATEGORY_USAGE_GUIDANCE,
  tags: 'Short searchable labels. Use tags for technologies, people, concepts, or recurring details that may span many spaces.',
  groups: 'Temporary or cross-cutting workstreams such as roadmap, onboarding, or ops-review. Groups are useful for projects that cut across spaces.',
  summary: 'A concise card preview. Put the most useful takeaway here, especially when the body has longer context and references.',
  body: 'Starter notes for the editor. Add enough context that the draft is useful when it opens.',
};

function HelpIcon({ id, activeHelp, onToggle }: { id: HelpKey; activeHelp: HelpKey | null; onToggle: (id: HelpKey) => void }) {
  const active = activeHelp === id;
  return (
    <span className="PageList__HelpWrap">
      <button
        type="button"
        className="PageList__HelpIcon"
        aria-label="Help info"
        data-help-key={id}
        aria-expanded={active}
        title={HELP_TEXT[id]}
        onMouseEnter={() => {
          if (!active) onToggle(id);
        }}
        onFocus={() => {
          if (!active) onToggle(id);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!active) onToggle(id);
        }}
      >
        i
      </button>
      {active ? <span role="tooltip" className="PageList__HelpTooltip">{HELP_TEXT[id]}</span> : null}
    </span>
  );
}

function FieldLabel({ children, help, activeHelp, onToggle }: { children: string; help: HelpKey; activeHelp: HelpKey | null; onToggle: (id: HelpKey) => void }) {
  return (
    <span className="PageList__FieldLabelText">
      <span>{children}</span>
      <HelpIcon id={help} activeHelp={activeHelp} onToggle={onToggle} />
    </span>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return 'Failed to create the draft. Please check the title and try again.';
}

/**
 * How many rows were rendered for a given result window, remembered per
 * filter-set for the life of the tab.
 *
 * The browse list grows by infinite scroll, but navigating to an item unmounts
 * it — so returning via Back rebuilt the list at its initial size and threw away
 * everything the user had scrolled through. Scroll restoration alone cannot fix
 * that: the rows have to exist before there is anywhere to scroll to.
 *
 * sessionStorage (not localStorage): a stale window from days ago is noise, and
 * this should not outlive the tab. Failures are ignored — a lost scroll window
 * must never break browsing (Safari private mode throws on write).
 */
const SCROLL_WINDOW_PREFIX = 'e3:browse:window:';
const SCROLL_WINDOW_DEFAULT = 24;

function readScrollWindow(key: string): number {
  try {
    const raw = sessionStorage.getItem(SCROLL_WINDOW_PREFIX + key);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= SCROLL_WINDOW_DEFAULT ? parsed : SCROLL_WINDOW_DEFAULT;
  } catch {
    return SCROLL_WINDOW_DEFAULT;
  }
}

function writeScrollWindow(key: string, count: number): void {
  try {
    sessionStorage.setItem(SCROLL_WINDOW_PREFIX + key, String(count));
  } catch {
    /* storage unavailable or full — the window is a convenience, not state we own */
  }
}

export function PageList() {
  const navigate = useNavigate();
  const createPage = useCreatePage();
  const { data: currentUser } = useMe();
  const canWrite = !!currentUser; // anonymous visitors (public read mode) get a read-only browse
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(() => createInitialComposer());
  const [composerError, setComposerError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [activeHelp, setActiveHelp] = useState<HelpKey | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  // Browse filter URL shape (for MCP/deep-link handoff):
  // /?view=all|recent|tags|settings&q=text&status=draft,published&topic=name&category=slug&tag=slug&group=slug&sort=updated_desc|created_desc|title_asc
  // `topic` is preferred; `space` remains accepted as a legacy alias for shared URLs and route handoffs.
  // Unknown enum values are ignored/fallbacked so malformed shared URLs never blank the app.
  const routeSearch = useRouterState({
    select: (s) => s.location.search as BrowseSearchParams,
  });
  const routeView = searchParamString(routeSearch.view);
  const routeQuery = searchParamString(routeSearch.q);
  const routeStatus = searchParamString(routeSearch.status);
  const routeSort = searchParamString(routeSearch.sort);
  const routeTopic = searchParamString(routeSearch.topic);
  const routeSpace = searchParamString(routeSearch.space);
  const routeCategory = searchParamString(routeSearch.category);
  const routeTag = searchParamString(routeSearch.tag);
  const routeGroup = searchParamString(routeSearch.group);
  const routeType = searchParamString(routeSearch.type);
  const activeView = asBrowseView(routeView);
  // The old `?view=settings` browse-view is retired; personal preferences now
  // live on /profile. Redirect any lingering links there.
  useEffect(() => {
    if (routeView === 'settings') navigate({ to: '/profile' });
  }, [routeView, navigate]);

  // Home hands off "create by type" via ?new=<typeKey>: open the composer
  // preseeded with that content type, then strip the param so a refresh/back
  // doesn't reopen it.
  const routeNew = searchParamString((routeSearch as { new?: unknown }).new);
  useEffect(() => {
    if (!routeNew) return;
    setComposer((prev) => ({ ...createInitialComposer(), ...prev, type: routeNew }));
    setIsComposerOpen(true);
    const rest = { ...(routeSearch as Record<string, unknown>) };
    delete rest.new;
    navigate({ to: '/browse', search: rest as any, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeNew]);
  const queryText = routeQuery?.trim().toLowerCase() ?? '';
  const statusFilters = useMemo(() => asStatusFilters(routeStatus), [routeStatus]);
  const sortKey = asSortKey(routeSort);
  const topicCandidates = useMemo(() => normalizedFilterCandidates(routeTopic, routeSpace), [routeTopic, routeSpace]);
  const categoryCandidates = useMemo(() => normalizedFilterCandidates(routeCategory), [routeCategory]);
  const tagCandidates = useMemo(() => normalizedFilterCandidates(routeTag), [routeTag]);
  const groupCandidates = useMemo(() => normalizedFilterCandidates(routeGroup), [routeGroup]);
  const hasBrowseFilters = Boolean(
    routeQuery?.trim() ||
    routeStatus?.trim() ||
    routeTopic?.trim() ||
    routeSpace?.trim() ||
    routeCategory?.trim() ||
    routeTag?.trim() ||
    routeGroup?.trim() ||
    routeType?.trim() ||
    asSortKey(routeSort) !== 'updated_desc'
  );
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  // Library infinite scroll: how many flat results are currently rendered.
  const LIBRARY_PAGE = SCROLL_WINDOW_DEFAULT;
  const [searchInput, setSearchInput] = useState(routeQuery ?? '');
  const searchTypingRef = useRef(false);
  const debouncedSearchInput = useDebouncedValue(searchInput, 250);
  // Identity of the current result window: same filters => same scroll window.
  const scrollWindowKey = useMemo(
    () =>
      JSON.stringify([
        queryText, routeType, routeStatus, routeTopic, routeSpace,
        routeCategory, routeTag, routeGroup, sortKey, activeView,
      ]),
    [queryText, routeType, routeStatus, routeTopic, routeSpace, routeCategory, routeTag, routeGroup, sortKey, activeView],
  );
  const [visibleCount, setVisibleCount] = useState(() => readScrollWindow(scrollWindowKey));
  const scrollSentinelRef = useRef<HTMLDivElement>(null);

  // Load a generous page set so browse/group/filter operate on the full library
  // rather than the server's default 50. (Proper pagination is a follow-up.)
  const { data: pages = [], isLoading: pagesLoading } = usePages({ limit: 1000 });
  // When a query is active, membership AND ranking come from the SERVER search —
  // the one pipeline the palette also uses — so the two never disagree. Browse's
  // own facet filters (status/topic/category/tag/group/type) are applied to the
  // hydrated result set below; ordering is the server's relevance order.
  const isAdmin = currentUser?.role === 'admin';
  const { data: searchHits = [], isLoading: searchLoading } = useSearch(
    queryText ? routeQuery?.trim() : undefined,
    { limit: 100, includeDrafts: isAdmin },
  );
  const isLoading = pagesLoading || (queryText.length > 0 && searchLoading);
  const { data: topics = [] } = useTopics();
  const { data: primaryCategories = [] } = usePrimaryCategories();
  const { data: contentTypes = [] } = useContentTypes();
  const topicLookup = useMemo(() => buildTopicLookup(topics), [topics]);
  // Hydrate server hits to full pages (for previews/fields), preserving the
  // server's order; fall back to the snippet-only shape for out-of-window hits.
  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const queryPages = useMemo(() => {
    if (!queryText) return null;
    return searchHits.map((hit) => pagesById.get(hit.id) ?? pageFromSearchHit(hit));
  }, [queryText, searchHits, pagesById]);
  const categoryLookup = useMemo(() => buildCategoryLookup(primaryCategories), [primaryCategories]);
  const listRef = useRef<HTMLElement>(null);
  const scrollspyNavRef = useRef<HTMLElement>(null);
  const groupsScrollerRef = useRef<HTMLDivElement>(null);

  // Filter pages by status / route-level nav view / sidebar search.
  // When a query is active the base set is the server's ranked matches
  // (queryPages); otherwise it's the full loaded library. The facet filters
  // below apply either way. Note: no client query-matching here anymore — the
  // server decided membership, so browse and the palette can't diverge.
  const filteredPages = useMemo(() => {
    let list = queryText ? (queryPages ?? []) : pages;
    if (statusFilters.size > 0) {
      list = list.filter(p => statusFilters.has(p.status as StatusFilter));
    }
    if (topicCandidates.length > 0) {
      list = list.filter((p) => topicMatchesFilter(p, topicCandidates, topicLookup));
    }
    if (categoryCandidates.length > 0) {
      list = list.filter((p) =>
        (p.categories ?? []).some((category) => matchesFilter(category, categoryCandidates) || matchesFilter(displayCategorySlug(category, categoryLookup), categoryCandidates)),
      );
    }
    if (tagCandidates.length > 0) {
      list = list.filter((p) => (p.tags ?? []).some((tag) => matchesFilter(tag, tagCandidates)));
    }
    if (groupCandidates.length > 0) {
      list = list.filter((p) => (p.groups ?? []).some((group) => matchesFilter(group, groupCandidates)));
    }
    if (routeType?.trim()) {
      const t = routeType.trim().toLowerCase();
      list = list.filter((p) => (p.type ?? '').toLowerCase() === t);
    }
    return list;
  }, [categoryCandidates, categoryLookup, groupCandidates, pages, queryPages, queryText, topicCandidates, topicLookup, statusFilters, tagCandidates, routeType]);

  // Content-type facet counts (over the whole library) — the mock's key facet.
  const typeFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pages) {
      const t = (p.type ?? '').trim();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [pages]);

  // Sort pages. When a query is present, PRESERVE the server's relevance order
  // (filteredPages already came from queryPages in rank order); otherwise honor
  // the chosen sort.
  const sortedPages = useMemo(() => {
    const list = [...filteredPages];
    if (queryText) {
      return list; // server-ranked; facet filters above kept the order stable
    }
    switch (sortKey) {
      case 'created_desc':
        return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      case 'title_asc':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'updated_desc':
      default:
        return list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }
  }, [filteredPages, sortKey, queryText]);

  const activeTopic = useMemo(() => describeActiveTopicFilter({ topic: routeTopic, space: routeSpace }, topicLookup), [routeTopic, routeSpace, topicLookup]);

  // --- main search box: local value, debounced + replacing navigation ---
  // The field is driven by local state rather than the URL so keystrokes stay
  // instant, then a debounced effect pushes the settled value into the URL with
  // `replace`. `searchTypingRef` distinguishes the user typing from the URL
  // changing underneath us (Back, a link, a cleared filter) — without it the
  // effect would re-navigate in response to Back and fight the user.
  useEffect(() => {
    if (!searchTypingRef.current) setSearchInput(routeQuery ?? '');
  }, [routeQuery]);

  useEffect(() => {
    if (!searchTypingRef.current) return;
    searchTypingRef.current = false;
    if ((routeQuery ?? '') === debouncedSearchInput) return;
    updateBrowseSearch({ view: 'grouped', q: debouncedSearchInput || undefined }, { replace: true });
  }, [debouncedSearchInput]);

  // Infinite scroll: reset the window whenever the result set or view changes —
  // but RESTORE it when returning to a window we have seen before (Back), so a
  // click on result #200 doesn't dump you back at the top with 24 rows.
  useEffect(() => {
    setVisibleCount(readScrollWindow(scrollWindowKey));
  }, [scrollWindowKey]);

  useEffect(() => {
    writeScrollWindow(scrollWindowKey, visibleCount);
  }, [scrollWindowKey, visibleCount]);

  // Grow the window when the sentinel scrolls into view. Works for cards/list
  // (page-level scroll) AND the grouped view (its own nested scroll container).
  useEffect(() => {
    if (activeView !== 'cards' && activeView !== 'list' && activeView !== 'grouped') return;
    if (visibleCount >= sortedPages.length) return;
    const el = scrollSentinelRef.current;
    if (!el) return;
    const root = activeView === 'grouped' ? groupsScrollerRef.current : null;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + LIBRARY_PAGE, sortedPages.length));
        }
      },
      { root, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [activeView, visibleCount, sortedPages.length]);

  const visiblePages = useMemo(() => sortedPages.slice(0, visibleCount), [sortedPages, visibleCount]);
  // For the grouped view, the set of page ids currently within the scroll window.
  const visibleIds = useMemo(() => new Set(visiblePages.map((p) => p.id)), [visiblePages]);

  const groupedTopicPreviewLimit = 50;
  const categoryForBrowseGroup = (page: Page): string => {
    const category = page.categories?.find((value) => value.trim());
    return category ? displayCategorySlug(category, categoryLookup) : 'Uncategorized';
  };
  const groupedByPrimaryCategory = activeTopic.kind === 'topic';
  const scrollspyGroupLabel = groupedByPrimaryCategory ? 'Primary category groups' : 'Spaces';
  const scrollspyHeading = groupedByPrimaryCategory ? 'Primary categories' : 'Spaces';
  const groupedTopicGroups = useMemo(() => {
    const groups = new Map<string, Page[]>();
    for (const page of sortedPages) {
      const groupName = groupedByPrimaryCategory ? categoryForBrowseGroup(page) : topicForPage(page, topicLookup) || 'Default space';
      groups.set(groupName, [...(groups.get(groupName) ?? []), page]);
    }
    const topicGroups = [...groups.entries()]
      .map(([topic, topicPages]) => ({
        id: `${groupedByPrimaryCategory ? 'category' : 'topic'}-${slugifyFilterValue(topic) || 'default'}`,
        topic,
        pages: topicPages,
        previewPages: topicPages.slice(0, groupedTopicPreviewLimit),
      }));

    return topicGroups.sort((a, b) => {
      if (sortKey === 'title_asc') {
        return a.topic.localeCompare(b.topic, undefined, { sensitivity: 'base' });
      }
      const dateField = sortKey === 'created_desc' ? 'created_at' : 'updated_at';
      const aMostRecent = Math.max(...a.pages.map((page) => new Date(page[dateField]).getTime()));
      const bMostRecent = Math.max(...b.pages.map((page) => new Date(page[dateField]).getTime()));
      return bMostRecent - aMostRecent || a.topic.localeCompare(b.topic, undefined, { sensitivity: 'base' });
    });
  }, [categoryLookup, groupedByPrimaryCategory, sortedPages, sortKey, topicLookup]);

  useEffect(() => {
    if (activeView !== 'grouped') return;
    setActiveGroupId((current) => {
      if (current && groupedTopicGroups.some((group) => group.id === current)) return current;
      return groupedTopicGroups[0]?.id || '';
    });
  }, [activeView, groupedTopicGroups]);

  useEffect(() => {
    if (activeView !== 'grouped') return;
    const scroller = groupsScrollerRef.current;
    if (!scroller) return;

    let frame = 0;
    const updateActiveGroup = () => {
      frame = 0;
      const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[data-topic-group-id]'));
      if (sections.length === 0) return;

      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (scroller.scrollTop >= maxScrollTop - 4) {
        const lastSection = sections[sections.length - 1];
        const lastId = lastSection?.getAttribute('data-topic-group-id');
        if (lastId) setActiveGroupId(lastId);
        return;
      }

      const scrollerBox = scroller.getBoundingClientRect();
      const scrollerMidpoint = scrollerBox.top + Math.min(scrollerBox.height * 0.35, 180);
      const closest = sections
        .map((section) => ({
          id: section.getAttribute('data-topic-group-id') ?? '',
          distance: Math.abs(section.getBoundingClientRect().top - scrollerMidpoint),
        }))
        .filter((entry) => entry.id)
        .sort((a, b) => a.distance - b.distance)[0];

      if (closest?.id) setActiveGroupId(closest.id);
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveGroup);
    };

    scheduleUpdate();
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [activeView, groupedTopicGroups]);

  useEffect(() => {
    if (activeView !== 'grouped' || !activeGroupId) return;
    const nav = scrollspyNavRef.current;
    const activeLink = nav?.querySelector<HTMLAnchorElement>(`[data-scrollspy-target="${activeGroupId}"]`);
    if (!nav || !activeLink) return;
    nav.scrollTop = Math.max(0, activeLink.offsetTop - nav.offsetTop);
  }, [activeGroupId, activeView]);

  const tagGroups = useMemo(() => {
    const groups = new Map<string, Page[]>();
    for (const page of pages) {
      for (const tag of page.tags ?? []) {
        const key = tag.trim();
        if (!key) continue;
        groups.set(key, [...(groups.get(key) ?? []), page]);
      }
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pages]);

  const topicOptions = useMemo(() => buildTopicOptions({ pages, topics }), [pages, topics]);
  const topicDirectoryPages = queryText || hasBrowseFilters ? filteredPages : pages;
  const topicDirectory = useMemo(() => buildTopicDirectory({ pages: topicDirectoryPages, topics }), [topicDirectoryPages, topics]);

  const categoryOptions = useMemo(() => {
    const catalogCategories = primaryCategories.map((category) => category.name.trim() || displayFromSlug(category.slug));
    return uniqueSorted(catalogCategories);
  }, [primaryCategories]);

  const viewTitle = activeView === 'tags' ? 'Tags' : activeView === 'grouped' ? 'Grouped by space' : 'Library';

  const groupedUnitSingular = groupedByPrimaryCategory ? 'primary category' : 'space';
  const groupedUnitPlural = groupedByPrimaryCategory ? 'primary categories' : 'spaces';
  const viewSubtitle = activeView === 'tags'
    ? `${tagGroups.length} tags`
    : queryText
      ? `${sortedPages.length} result${sortedPages.length === 1 ? '' : 's'} for “${routeQuery?.trim()}” · ranked by relevance`
      : `${sortedPages.length} matching pages across ${groupedTopicGroups.length} ${groupedTopicGroups.length === 1 ? groupedUnitSingular : groupedUnitPlural}`;

  const activeFilters = [
    routeQuery?.trim()
      ? {
          key: 'q',
          label: `Search: ${routeQuery.trim()}`,
          removeLabel: `Remove search filter ${routeQuery.trim()}`,
          remove: () => updateBrowseSearch({ q: undefined }),
        }
      : null,
    routeType?.trim()
      ? {
          key: 'type',
          label: `Type: ${routeType.trim()}`,
          removeLabel: `Remove type filter ${routeType.trim()}`,
          remove: () => updateBrowseSearch({ type: undefined }),
        }
      : null,
    activeTopic.kind !== 'all'
      ? {
          key: 'topic',
          label: `Space: ${activeTopic.label}`,
          removeLabel: `Remove space filter ${activeTopic.label}`,
          remove: () => updateBrowseSearch({ topic: undefined, space: undefined }),
        }
      : null,
    routeCategory?.trim()
      ? {
          key: 'category',
          label: `Category: ${routeCategory.trim()}`,
          removeLabel: `Remove category filter ${routeCategory.trim()}`,
          remove: () => updateBrowseSearch({ category: undefined }),
        }
      : null,
    routeTag?.trim()
      ? {
          key: 'tag',
          label: `Tag: ${routeTag.trim()}`,
          removeLabel: `Remove tag filter ${routeTag.trim()}`,
          remove: () => updateBrowseSearch({ tag: undefined }),
        }
      : null,
    routeGroup?.trim()
      ? {
          key: 'group',
          label: `Group: ${routeGroup.trim()}`,
          removeLabel: `Remove group filter ${routeGroup.trim()}`,
          remove: () => updateBrowseSearch({ group: undefined }),
        }
      : null,
    routeStatus?.trim()
      ? {
          key: 'status',
          label: `Status: ${routeStatus.trim().split(',').join(' + ')}`,
          removeLabel: `Remove status filter ${routeStatus.trim().split(',').join(' and ')}`,
          remove: () => updateBrowseSearch({ status: undefined }),
        }
      : null,
    sortKey !== 'updated_desc'
      ? {
          key: 'sort',
          label: `Sort: ${sortKey === 'created_desc' ? 'Created ↓' : 'Title A-Z'}`,
          removeLabel: 'Remove sort filter',
          remove: () => updateBrowseSearch({ sort: undefined }),
        }
      : null,
  ].filter((filter): filter is { key: string; label: string; removeLabel: string; remove: () => void } => Boolean(filter));

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  };

  // Keyboard navigation: j/k and arrow up/down to move, Enter to open, Tab for native focus.
  // Scope shortcuts to the browse surface so composer fields, controls, links, and dialogs
  // keep normal typing/activation behavior.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isComposerOpen) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      const origin = target ?? activeElement;
      const interactiveSelector = 'input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]';
      if (origin?.closest(interactiveSelector)) return;

      const listContainsOrigin = origin ? Boolean(listRef.current?.contains(origin)) : false;
      const pageBodyOwnsFocus = !activeElement || activeElement === document.body;
      if (!listContainsOrigin && !pageBodyOwnsFocus) return;

      const maxIndex = sortedPages.length - 1;
      let newIndex = focusedIndex;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        newIndex = Math.min(focusedIndex + 1, maxIndex);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        newIndex = Math.max(focusedIndex - 1, -1);
      } else if (e.key === 'Enter' && focusedIndex >= 0) {
        e.preventDefault();
        const page = sortedPages[focusedIndex];
        if (!page) return; // noUncheckedIndexedAccess: focusedIndex is guarded above, but TS can't see it
        void navigate({ to: '/p/$slug', params: { slug: page.slug } });
        return;
      } else {
        return;
      }

      setFocusedIndex(newIndex);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedIndex, sortedPages, navigate, isComposerOpen]);

  const onNewPage = (seedFromSearch = false) => {
    const isUnassignedTopicContext = activeTopic.kind === 'unassigned';
    const selectedTopic = activeTopic.kind === 'topic'
      ? activeTopic.label
      : activeTopic.kind === 'unassigned'
        ? ''
        : '';
    const selectedCategory = routeCategory?.trim() || '';
    const selectedTag = routeTag?.trim() || (seedFromSearch ? slugifyComposerValue(routeQuery?.trim() ?? '') : '');
    const selectedGroup = routeGroup?.trim() || '';
    setComposer({
      ...createInitialComposer(seedFromSearch ? selectedTag : ''),
      title: seedFromSearch ? routeQuery?.trim() ?? '' : '',
      space: isUnassignedTopicContext ? '' : selectedTopic || topicOptions[0] || '',
      category: seedFromSearch ? selectedCategory : '',
      groups: seedFromSearch ? selectedGroup : '',
    });
    setComposerError(null);
    setIsComposerOpen(true);
  };

  const closeComposer = () => {
    if (createPage.isPending) return;
    setIsComposerOpen(false);
  };

  const updateComposer = <K extends keyof ComposerState>(key: K, value: ComposerState[K]) => {
    setComposer((current) => ({ ...current, [key]: value }));
    setComposerError(null);
  };

  const addComposerTag = (rawTag: string) => {
    const normalized = slugifyComposerValue(rawTag);
    if (!normalized) return;
    setComposer((current) => {
      const tags = normalizeComposerList(current.tags);
      if (!tags.includes(normalized)) tags.push(normalized);
      return { ...current, tags: tags.join(', '), tagEntry: '' };
    });
  };

  const removeComposerTag = (tagToRemove: string) => {
    setComposer((current) => ({
      ...current,
      tags: normalizeComposerList(current.tags).filter((tag) => tag !== tagToRemove).join(', '),
    }));
  };

  const submitComposer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = composer.title.trim();
    if (!title) return;

    const tags = normalizeComposerList(composer.tags);
    const categories = normalizeComposerList(composer.category);
    const groups = normalizeComposerList(composer.groups);
    const summary = composer.summary.trim();
    const space = composer.space.trim();
    const typeDef = contentTypes.find((t) => t.key === composer.type);
    const frontmatter: Record<string, unknown> = {
      ...(typeDef ? typeDef.defaultFrontmatter : {}),
      ...(typeDef ? { type: typeDef.label } : {}),
      ...(summary ? { summary } : {}),
      ...(space ? { topic: space } : {}),
      ...(categories.length ? { categories } : {}),
      ...(groups.length ? { groups } : {}),
    };

    setComposerError(null);
    try {
      const page = await createPage.mutateAsync({
        title,
        body: buildItemDraftMarkdown({ title, summary, body: composer.body, template: typeDef?.template }),
        status: composer.status,
        tags,
        frontmatter,
      });
      setIsComposerOpen(false);
      void navigate({ to: '/p/$slug', params: { slug: page.slug }, search: { edit: '1' } });
    } catch (error) {
      setComposerError(errorMessageFromUnknown(error));
    }
  };

  const updateBrowseSearch = (
    next: Partial<BrowseSearchParams>,
    opts: { replace?: boolean } = {},
  ) => {
    setFocusedIndex(-1);
    void navigate({
      to: '/browse',
      search: searchWith({
        ...routeSearch,
        view: activeView,
        ...next,
      }) as any,
      // Typing-driven updates replace, so refining a query costs ONE history
      // entry rather than one per keystroke.
      replace: opts.replace ?? false,
    });
  };

  const clearBrowseFilters = () => {
    setFocusedIndex(-1);
    void navigate({ to: '/browse', search: { view: 'grouped' } as any });
  };

  const toggleStatusFilter = (status: StatusFilter) => {
    const newFilters = new Set(statusFilters);
    if (newFilters.has(status)) {
      newFilters.delete(status);
    } else {
      newFilters.add(status);
    }
    updateBrowseSearch({
      view: 'grouped',
      status: newFilters.size > 0 ? [...newFilters].sort().join(',') : undefined,
    });
  };

  const applyMetadataFilter = (kind: MetadataFilterKey, value: string) => {
    if (kind === 'topic') {
      updateBrowseSearch({ view: 'grouped', topic: slugifyFilterValue(value), space: undefined });
      return;
    }
    updateBrowseSearch({ view: 'grouped', [kind]: value } as Partial<BrowseSearchParams>);
  };

  const applyTopicFilter = (value?: string) => {
    updateBrowseSearch({ view: 'grouped', topic: value, space: undefined });
  };

  const handleRowClick = (page: Page) => {
    navigate({ to: '/p/$slug', params: { slug: page.slug } });
  };

  const handleEditClick = (event: MouseEvent, page: Page) => {
    event.stopPropagation();
    navigate({ to: '/p/$slug', params: { slug: page.slug }, search: { edit: '1' } });
  };

  const handleCopyClick = async (event: MouseEvent, command: string) => {
    event.stopPropagation();
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      setCopyError('Copy failed. Check browser clipboard permissions and try again.');
    }
  };

  const stopCopyKeyPropagation = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  };

  const briefTextForPage = (page: Page): string => {
    const body = page.body_markdown ?? '';
    const command = commandForPage(page);
    if (command) return command;

    const line = body
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? '';
    const cleaned = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    return cleaned.length > 0 ? cleaned.slice(0, 180) : 'No preview text yet.';
  };

  const commandForPage = (page: Page): string | null => {
    const body = (page.body_markdown ?? '').trim();
    if (!body) return null;

    const fenced = body.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
    const fencedBody = fenced?.[1];
    const candidate = (fencedBody !== undefined ? fencedBody : body).trim();
    if (!candidate || candidate.includes('\n\n')) return null;

    const lines = candidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1) return null;

    const line = lines[0]!.replace(/^\$\s*/, '');
    return /^[\w./~:-]+(\s+.+)?$/.test(line) ? line : null;
  };

  const summaryForPage = (page: Page): string => {
    const frontmatterSummary = page.frontmatter?.['summary'];
    if (typeof frontmatterSummary === 'string' && frontmatterSummary.trim()) {
      return frontmatterSummary.trim().slice(0, 220);
    }

    const sectionSummary = extractSummarySection(page.body_markdown ?? '');
    if (sectionSummary) return sectionSummary.slice(0, 220);

    return briefTextForPage(page);
  };

  const extractSummarySection = (body: string): string | null => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => /^##\s+(executive summary|overview)\s*$/i.test(line.trim()));
    if (start < 0) return null;

    const collected: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s+/.test(line)) break;
      const cleaned = line
        .trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/`([^`]+)`/g, '$1');
      if (cleaned) collected.push(cleaned);
    }

    return collected.join(' ').trim() || null;
  };

  const categoryForPage = (page: Page): string => {
    const category = page.categories?.find((value) => value.trim());
    return category ? displayCategorySlug(category, categoryLookup) : 'uncategorized';
  };

  const colorForCategory = (category: string): string => {
    let hash = 0;
    for (const char of category.toLowerCase()) {
      hash = (hash * 31 + char.charCodeAt(0)) % 360;
    }
    return `hsl(${hash} 72% 52%)`;
  };


  const renderPageCard = (page: Page, idx: number) => {
    const explicitCopyEntries = extractCopyableEntries(page);
    const preview = summaryForPage(page);
    const chipMap = new Map<string, { kind: MetadataFilterKey; value: string }>();
    for (const value of page.categories ?? []) {
      const displayCategory = displayCategorySlug(value, categoryLookup);
      chipMap.set(uniqueChipKey('category', displayCategory), { kind: 'category', value: displayCategory });
    }
    for (const value of page.groups ?? []) chipMap.set(uniqueChipKey('group', value), { kind: 'group', value });
    for (const value of page.tags ?? []) chipMap.set(uniqueChipKey('tag', value), { kind: 'tag', value });
    const topic = topicForPage(page, topicLookup);
    if (topic) chipMap.set(uniqueChipKey('topic', topic), { kind: 'topic', value: topic });
    const chips = [...chipMap.values()].slice(0, 4);
    const category = categoryForPage(page);
    const cardStyle = { '--PageList-category-color': colorForCategory(category) } as CSSProperties;
    const searchReasons = searchReasonsForPage(page, queryText, topicLookup, categoryLookup);

    return (
      <li
        key={page.id}
        className={`PageList__Card ${focusedIndex === idx ? 'focused' : ''}`}
        style={cardStyle}
      >
        <button
          type="button"
          className="PageList__CardOpenAction"
          onClick={() => handleRowClick(page)}
          onFocus={() => setFocusedIndex(idx)}
          aria-label={`Open ${page.title}`}
        />
        <div className="PageList__CardHeader">
          <div className="PageList__CardTitle" title={page.title}>
            {page.title}
          </div>
          <div className="PageList__CardHeaderMeta">
            {page.type ? <ContentTypeBadge type={page.type} size="sm" /> : null}
            <div className={`PageList__Status ${page.status}`}>
              {page.status === 'draft' ? 'Draft' : 'Published'}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="PageList__IconAction PageList__EditOverlay"
          onClick={(event) => handleEditClick(event, page)}
          title={`Edit ${page.title}`}
          aria-label={`Edit ${page.title}`}
        >
          <Icon icon={appIcons.pencil} />
        </button>

        <div className="PageList__BriefPreview" title={preview}>
          {preview}
        </div>

        {explicitCopyEntries.length > 0 ? (
          <div className="PageList__CopyActions" aria-label={`Copyable content for ${page.title}`}>
            {explicitCopyEntries.slice(0, 3).map((entry) => (
              <button
                key={`${entry.label}:${entry.value}`}
                type="button"
                className="PageList__CopyAction"
                onClick={(event) => void handleCopyClick(event, entry.value)}
                onKeyDown={stopCopyKeyPropagation}
                title={entry.value}
                aria-label={`Copy ${entry.label} from ${page.title}`}
              >
                <Icon icon={appIcons.copy} />
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {searchReasons.length > 0 ? (
          <div className="PageList__SearchReasons" aria-label={`Why ${page.title} matched`}>
            {searchReasons.map((reason) => (
              <span key={reason} className="PageList__SearchReasonChip">
                {reason}
              </span>
            ))}
          </div>
        ) : null}

        {chips.length > 0 ? (
          <div className="PageList__Tags">
            {chips.map((chip, chipIdx) => (
              <button
                key={`${chip.kind}-${chip.value}-${chipIdx}`}
                type="button"
                className="PageList__TagChip PageList__TagChipButton"
                onClick={(event) => {
                  event.stopPropagation();
                  applyMetadataFilter(chip.kind, chip.value);
                }}
                title={`Filter by ${chip.kind === 'topic' ? 'topic' : chip.kind}: ${chip.value}`}
              >
                {chip.kind === 'tag' ? `#${chip.value}` : chip.value}
              </button>
            ))}
          </div>
        ) : null}

        <div className="PageList__CardFooter">
          <span>Updated {formatDate(page.updated_at)}</span>
          <span>{topicForPage(page, topicLookup) || 'Default space'}</span>
        </div>
      </li>
    );
  };

  const renderPageRow = (page: Page) => {
    const preview = summaryForPage(page);
    return (
      <li key={page.id} className="PageList__LibRow">
        <button type="button" className="PageList__RowOpen" onClick={() => handleRowClick(page)} aria-label={`Open ${page.title}`} />
        <div className="PageList__RowMain">
          <div className="PageList__RowBadges">
            {page.type ? <ContentTypeBadge type={page.type} size="sm" /> : null}
            <span className={`PageList__Status ${page.status}`}>{page.status === 'draft' ? 'Draft' : 'Published'}</span>
          </div>
          <h3 className="PageList__RowTitle">{page.title}</h3>
          {preview ? <p className="PageList__RowPreview">{preview}</p> : null}
        </div>
        <div className="PageList__RowSide">
          <span>{topicForPage(page, topicLookup) || 'Default space'}</span>
          <span>{formatDate(page.updated_at)}</span>
        </div>
      </li>
    );
  };

  const renderFacetPanel = () => {
    const tagFacets = [...tagGroups].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
    const spaceFacets = topicDirectory.filter((r) => r.kind === 'topic').slice(0, 12);
    const draftCount = pages.filter((p) => p.status === 'draft').length;
    const publishedCount = pages.filter((p) => p.status === 'published').length;
    const facetRow = (key: string, label: string, count: number, active: boolean, onClick: () => void) => (
      <button key={key} type="button" className={`PageList__FacetRow ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
        <span className="PageList__FacetRowLabel">{label}</span>
        <span className="PageList__FacetRowCount">{count}</span>
      </button>
    );
    return (
      <aside className="PageList__FacetPanel" aria-label="Filters">
        <h2 className="PageList__FacetPanelTitle">Filter</h2>
        {typeFacets.length > 0 && (
          <details className="PageList__FacetGroup" open>
            <summary>Content types</summary>
            <div className="PageList__FacetBody">
              {typeFacets.map(([type, count]) => {
                const active = (routeType ?? '').toLowerCase() === type.toLowerCase();
                return facetRow(`type-${type}`, type, count, active, () => updateBrowseSearch({ type: active ? undefined : type }));
              })}
            </div>
          </details>
        )}
        {spaceFacets.length > 0 && (
          <details className="PageList__FacetGroup" open>
            <summary>Spaces</summary>
            <div className="PageList__FacetBody">
              {spaceFacets.map((s) => {
                const active = activeTopic.value === s.slug;
                return facetRow(`space-${s.slug}`, s.label, s.count, active, () => applyTopicFilter(active ? undefined : s.slug));
              })}
            </div>
          </details>
        )}
        <details className="PageList__FacetGroup" open>
          <summary>Status</summary>
          <div className="PageList__FacetBody">
            {facetRow('status-published', 'Published', publishedCount, statusFilters.has('published'), () => toggleStatusFilter('published'))}
            {facetRow('status-draft', 'Draft', draftCount, statusFilters.has('draft'), () => toggleStatusFilter('draft'))}
          </div>
        </details>
        {tagFacets.length > 0 && (
          <details className="PageList__FacetGroup">
            <summary>Tags</summary>
            <div className="PageList__FacetBody">
              {tagFacets.map(([tag, tp]) => {
                const active = (routeTag ?? '') === tag;
                return facetRow(`tag-${tag}`, `#${tag}`, tp.length, active, () => updateBrowseSearch({ tag: active ? undefined : tag }));
              })}
            </div>
          </details>
        )}
      </aside>
    );
  };

  return (
    <div className="PageList">
      {isComposerOpen && (
        <div className="PageList__ComposerBackdrop" role="presentation" onMouseDown={closeComposer}>
          <form
            className="PageList__Composer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-item-composer-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => void submitComposer(event)}
          >
            <div className="PageList__ComposerHeader">
              <div>
                <h2 id="new-item-composer-title">New item composer</h2>
                <p>Capture the basics first, then start in the editor with a useful scaffold.</p>
              </div>
              <button type="button" className="PageList__ComposerGhost" onClick={closeComposer} aria-label="Close composer">
                ×
              </button>
            </div>

            <label className="PageList__ComposerField">
              <span>Title</span>
              <input
                autoFocus
                value={composer.title}
                onChange={(event) => updateComposer('title', event.target.value)}
                placeholder="Name this item"
                required
              />
            </label>

            <div className="PageList__ComposerGrid">
              <label className="PageList__ComposerField">
                <FieldLabel help="type" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Type</FieldLabel>
                <select
                  aria-label="Content type"
                  value={composer.type}
                  onChange={(event) => updateComposer('type', event.target.value)}
                >
                  {contentTypes.length === 0 ? (
                    <option value="concept">Concept</option>
                  ) : (
                    uniqueSorted(contentTypes.map((t) => t.group)).map((group) => (
                      <optgroup key={group} label={group}>
                        {contentTypes
                          .filter((t) => t.group === group)
                          .map((t) => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                          ))}
                      </optgroup>
                    ))
                  )}
                </select>
              </label>
              <label className="PageList__ComposerField">
                <FieldLabel help="topic" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Space</FieldLabel>
                <select
                  aria-label="Space"
                  value={composer.space}
                  onChange={(event) => updateComposer('space', event.target.value)}
                >
                  <option value="">No space</option>
                  {topicOptions.map((space) => (
                    <option key={space} value={space}>{space}</option>
                  ))}
                </select>
              </label>
              <label className="PageList__ComposerField">
                <FieldLabel help="status" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Status</FieldLabel>
                <select
                  aria-label="Status"
                  value={composer.status}
                  onChange={(event) => updateComposer('status', event.target.value as ComposerState['status'])}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                </select>
              </label>
              <label className="PageList__ComposerField" htmlFor="new-item-category">
                <FieldLabel help="primary-category" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Primary category</FieldLabel>
                <select
                  id="new-item-category"
                  value={composer.category}
                  onChange={(event) => updateComposer('category', event.target.value)}
                >
                  <option value="">Choose category…</option>
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>
              <div className="PageList__ComposerField">
                <label htmlFor="new-item-tags"><FieldLabel help="tags" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Tags</FieldLabel></label>
                <div className="PageList__ComposerTagEditor">
                  {normalizeComposerList(composer.tags).map((tag) => (
                    <span key={tag} className="PageList__ComposerTagPill">
                      #{tag}
                      <button type="button" onClick={() => removeComposerTag(tag)} aria-label={`Remove ${tag}`}>×</button>
                    </span>
                  ))}
                  <input
                    id="new-item-tags"
                    value={composer.tagEntry}
                    onChange={(event) => updateComposer('tagEntry', event.target.value)}
                    onBlur={() => addComposerTag(composer.tagEntry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault();
                        addComposerTag(composer.tagEntry);
                      }
                    }}
                    placeholder={composer.tags ? 'add another tag' : 'add tags...'}
                  />
                </div>
              </div>
            </div>

            <p className="PageList__ComposerHint">
              ID and URL slug are generated automatically from the title when you start the draft.
              Nothing is saved until Start draft succeeds. Manage category choices from Settings.
            </p>

            {composerError ? (
              <div className="PageList__ComposerError" role="alert">
                {composerError}
              </div>
            ) : null}

            <label className="PageList__ComposerField">
              <FieldLabel help="groups" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Groups</FieldLabel>
              <input
                aria-label="Groups"
                value={composer.groups}
                onChange={(event) => updateComposer('groups', event.target.value)}
                placeholder="Editor UX, Data Entry"
              />
            </label>

            <label className="PageList__ComposerField">
              <FieldLabel help="summary" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Optional summary</FieldLabel>
              <textarea
                aria-label="Optional summary"
                value={composer.summary}
                onChange={(event) => updateComposer('summary', event.target.value)}
                rows={3}
                placeholder="One or two sentences that should appear on browse cards."
              />
            </label>

            <label className="PageList__ComposerField">
              <FieldLabel help="body" activeHelp={activeHelp} onToggle={(id) => setActiveHelp(id)}>Body notes</FieldLabel>
              <textarea
                aria-label="Body notes"
                value={composer.body}
                onChange={(event) => updateComposer('body', event.target.value)}
                rows={4}
                placeholder="Seed the first section before opening the editor."
              />
            </label>

            <div className="PageList__ComposerActions">
              <button
                type="button"
                className="PageList__ComposerGhost"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  closeComposer();
                }}
              >
                Discard
              </button>
              <button type="submit" className="PageList__NewButton" disabled={createPage.isPending || !composer.title.trim()}>
                {createPage.isPending ? 'Creating…' : 'Start draft'}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Header */}
      <div className="PageList__Header">
        {activeView === 'grouped' ? (
          <div className="PageList__TitleBlock PageList__TitleBlock--compact">
            <div className="PageList__Subtitle">{viewSubtitle}</div>
          </div>
        ) : (
          <div className="PageList__TitleBlock">
            <h1 className="PageList__Title">{viewTitle}</h1>
            <div className="PageList__Subtitle">{viewSubtitle}</div>
          </div>
        )}

        {/* Controls: filters + sort + new button */}
        <div className="PageList__Controls">
          {activeView === 'tags' ? (
            <label className="PageList__MainSearch">
              <span>Filter tags</span>
              <input
                aria-label="Filter tags on this page"
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
                placeholder="Filter tags by name…"
              />
            </label>
          ) : (
            <label className="PageList__MainSearch">
              <span>Search items</span>
              <input
                data-main-search-input="true"
                aria-label="Search items on this page"
                value={searchInput}
                onChange={(event) => {
                  searchTypingRef.current = true;
                  setSearchInput(event.target.value);
                }}
                placeholder="Filter items, spaces, tags, categories…"
              />
            </label>
          )}

          <TopicSwitcher activeTopic={activeTopic} topics={topicDirectory} onSelectTopic={applyTopicFilter} />

          {activeView !== 'tags' && (
            <div className="PageList__ViewToggle" role="group" aria-label="Result layout">
              {([['cards', 'Cards'], ['list', 'List'], ['grouped', 'Grouped']] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={activeView === mode ? 'active' : ''}
                  aria-pressed={activeView === mode}
                  onClick={() => updateBrowseSearch({ view: mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--kp-space-3)', alignItems: 'center' }}>
            <select
              value={sortKey}
              onChange={(e) => updateBrowseSearch({ sort: e.target.value === 'updated_desc' ? undefined : (e.target.value as SortKey) })}
              className="PageList__SortDropdown"
            >
              <option value="updated_desc">Updated ↓</option>
              <option value="created_desc">Created ↓</option>
              <option value="title_asc">Title A-Z</option>
            </select>

            {canWrite && (
              <button
                type="button"
                onClick={() => onNewPage(hasBrowseFilters)}
                disabled={createPage.isPending}
                className="PageList__NewButton"
              >
                {createPage.isPending ? 'Creating…' : '+ New item'}
              </button>
            )}
          </div>
        </div>
        {activeView !== 'tags' && typeFacets.length > 0 ? (
          <div className="PageList__Facets" aria-label="Content type facets">
            <span className="PageList__FacetsLabel">Types</span>
            {typeFacets.map(([type, count]) => {
              const active = (routeType ?? '').toLowerCase() === type.toLowerCase();
              return (
                <button
                  key={type}
                  type="button"
                  className={`PageList__FacetChip ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() => updateBrowseSearch({ type: active ? undefined : type })}
                >
                  <span>{type}</span>
                  <span className="PageList__FacetCount">{count}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {hasBrowseFilters ? (
          <div className="PageList__ActiveFilters" aria-label="Active browse filters">
            {activeFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className="PageList__ActiveFilterChip PageList__ActiveFilterChipButton"
                onClick={filter.remove}
                aria-label={filter.removeLabel}
                title={filter.removeLabel}
              >
                <span>{filter.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <button type="button" className="PageList__ClearFilters" onClick={clearBrowseFilters}>
              Clear filters
            </button>
          </div>
        ) : null}
        {copyError ? <div className="PageList__CopyError" role="alert">{copyError}</div> : null}
      </div>

      {activeView === 'tags' && (() => {
        const q = tagFilter.trim().toLowerCase();
        const visibleTagGroups = q ? tagGroups.filter(([tag]) => tag.toLowerCase().includes(q)) : tagGroups;
        return (
          <div className="PageList__TagGrid">
            {tagGroups.length === 0 ? (
              <div className="PageList__EmptyInline">No tags yet. Add tags in item properties to populate this view.</div>
            ) : visibleTagGroups.length === 0 ? (
              <div className="PageList__EmptyInline">No tags match “{tagFilter.trim()}”.</div>
            ) : visibleTagGroups.map(([tag, tagPages]) => (
              <button
                type="button"
                key={tag}
                className="PageList__TagCard"
                onClick={() => navigate({ to: '/browse', search: { view: 'grouped', tag } as any })}
              >
                <span>#{tag}</span>
                <small>{tagPages.length} item{tagPages.length === 1 ? '' : 's'}</small>
              </button>
            ))}
          </div>
        );
      })()}

      {activeView !== 'tags' ? (
        <div className="PageList__Results">
      {isLoading && (
        <ul className="PageList__List" role="list">
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i} className="PageList__SkeletonRow">
              <div
                className="PageList__SkeletonBlock"
                style={{ flex: 1, height: '20px', maxWidth: '300px' }}
              />
              <div
                className="PageList__SkeletonBlock"
                style={{ width: '80px', height: '20px' }}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Empty state */}
      {!isLoading && sortedPages.length === 0 && (
        <div className="PageList__Empty">
          <h2 className="PageList__EmptyTitle">{hasBrowseFilters ? 'No matches found' : 'No pages yet'}</h2>
          <p className="PageList__EmptyText">
            {hasBrowseFilters
              ? 'No items matched the current search and facet filters. Try clearing a Space, status, tag, category, or group filter; use a broader term or related acronym; or create a new item from this search to capture the missing wording.'
              : 'Get started by creating your first page.'}
          </p>
          {canWrite && (
            <button
              type="button"
              onClick={() => onNewPage(hasBrowseFilters)}
              disabled={createPage.isPending}
              className="PageList__NewButton"
            >
              {createPage.isPending ? 'Creating…' : hasBrowseFilters ? 'Create item from search' : '+ New item'}
            </button>
          )}
        </div>
      )}

      {/* Library: results + facet panel (Cards or List), with infinite scroll. */}
      {!isLoading && sortedPages.length > 0 && (activeView === 'cards' || activeView === 'list') && (
        <div className="PageList__Library">
          <div className="PageList__LibraryMain" ref={listRef as RefObject<HTMLDivElement>} tabIndex={0} aria-label="Browse results">
            {activeView === 'cards' ? (
              <ul className="PageList__CardGrid" role="list">
                {visiblePages.map((page, idx) => renderPageCard(page, idx))}
              </ul>
            ) : (
              <ul className="PageList__RowList" role="list">
                {visiblePages.map((page) => renderPageRow(page))}
              </ul>
            )}
            {visibleCount < sortedPages.length ? (
              <div ref={scrollSentinelRef} className="PageList__ScrollSentinel" aria-hidden="true">
                Loading more… ({visibleCount} of {sortedPages.length})
              </div>
            ) : (
              <div className="PageList__ScrollEnd">{sortedPages.length} item{sortedPages.length === 1 ? '' : 's'}</div>
            )}
          </div>
          {renderFacetPanel()}
        </div>
      )}

      {!isLoading && sortedPages.length > 0 && activeView === 'grouped' && (
        <div className="PageList__GroupedLayout" ref={listRef as RefObject<HTMLDivElement>} tabIndex={0} aria-label="Grouped browse results">
          <aside className="PageList__TopicScrollspy" aria-label={scrollspyGroupLabel}>
            <div className="PageList__TopicScrollspyCard">
              <div className="PageList__TopicScrollspyTitle">{scrollspyHeading}</div>
              <nav aria-label={scrollspyGroupLabel} ref={scrollspyNavRef}>
                {groupedTopicGroups.map((group) => (
                  <a
                    key={group.id}
                    href={`#${group.id}`}
                    data-scrollspy-target={group.id}
                    className={`PageList__TopicScrollspyLink ${activeGroupId === group.id ? 'active' : ''}`}
                  >
                    <span>{group.topic}</span>
                    <span>{group.pages.length}</span>
                  </a>
                ))}
              </nav>
            </div>
          </aside>
          <div className="PageList__TopicGroupsScroller" role="region" aria-label="Scrollable topic results" ref={groupsScrollerRef}>
            <div className="PageList__TopicGroups">
            {groupedTopicGroups.map((group) => {
              // Only render items within the current infinite-scroll window.
              const shown = group.pages.filter((p) => visibleIds.has(p.id));
              if (shown.length === 0) return null;
              const groupKind = groupedByPrimaryCategory ? 'primary category' : 'topic';
              return (
                <section
                  key={group.id}
                  id={group.id}
                  className="PageList__TopicGroup"
                  data-topic-group-id={group.id}
                  aria-label={`${group.topic} ${groupKind} group`}
                >
                  <div className="PageList__TopicGroupHeader">
                    <div>
                      <h2>{group.topic}</h2>
                      <p>
                        Showing {shown.length} of {group.pages.length} item{group.pages.length === 1 ? '' : 's'} by current sort.
                      </p>
                    </div>
                    <span className="PageList__TopicGroupCount">{group.pages.length} item{group.pages.length === 1 ? '' : 's'}</span>
                  </div>
                  <ul className="PageList__CardGrid PageList__TopicGroupCards" role="list" aria-label={`${group.topic} cards`}>
                    {shown.map((page) => renderPageCard(page, sortedPages.findIndex((candidate) => candidate.id === page.id)))}
                  </ul>
                </section>
              );
            })}
            {visibleCount < sortedPages.length ? (
              <div ref={scrollSentinelRef} className="PageList__ScrollSentinel" aria-hidden="true">
                Loading more… ({visibleCount} of {sortedPages.length})
              </div>
            ) : (
              <div className="PageList__ScrollEnd">{sortedPages.length} item{sortedPages.length === 1 ? '' : 's'}</div>
            )}
            </div>
          </div>
        </div>
      )}
        </div>
      ) : null}
    </div>
  );
}
