/**
 * `KnowledgeQuery` (plan §9.3) implemented by delegation over today's DB-first
 * services. REST, MCP, and (later) the web read through this one seam so they
 * answer the same question the same way. Phase 1: no behavior change — every
 * method calls the service the corresponding endpoint already called, and only
 * adds derived lifecycle/trust signals (never stored) on top.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { DerivedDisplayState } from '@echozedlabs/content-model';
import { applyLifecyclePolicy, groupHits } from '@echozedlabs/search';
import type { Kysely } from 'kysely';
import type {
  FeedEntry,
  FeedQuery,
  GroupedSearchResults,
  ItemSummary,
  KnowledgeQuery,
  Page,
  PopularView,
  ReviewRef,
  SearchHit as KnowledgeSearchHit,
  SearchOverview,
  SearchQuery,
  SectionView,
  SeriesItem,
  TopicView,
  Viewer,
} from '@echozedlabs/knowledge-types';
import { ConfigService, type SectionDef } from '../config/config.service.js';
import { canonicalTypeLabel } from '../content-types/content-types.registry.js';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { ItemsService, type ItemView } from '../items/items.service.js';
import { lifecycleSignals, reviewRefFrom, type LifecycleColumnRow } from '../pages/lifecycle-columns.js';
import { PagesService, type PageView } from '../pages/pages.service.js';
import { parseSearchQuery } from '../search/query-parser.js';
import { SearchService, type FilterInput, type SearchResultSet } from '../search/search.service.js';
import { SpacesService, type SpaceWithCountsView } from '../taxonomy/spaces.service.js';
import { WikiService } from '../wiki/wiki.service.js';
import { toReadActor } from './viewer.js';

/**
 * A server item view plus the derived display-state signals (additive fields
 * only). `display_state` reads `in-review` while the item's change request is
 * open (plan §8.2) — a value the shared `DisplayState` union now carries, so
 * this service implements `KnowledgeQuery` itself with no local widening.
 */
export type ItemViewWithSignals = ItemView & DerivedDisplayState;

/** Today's `SearchResultSet` (results/facets/warnings/empty_state) plus the grouped view. */
export type GroupedSearchResultSet = SearchResultSet & GroupedSearchResults;

/**
 * `SearchQuery` with the repeatable filters widened to arrays (reader UX plan
 * §5.2): `tag:a tag:b` and `?tag=a&tag=b` both mean "either tag", so the axes
 * a caller may repeat take a list. Widening a parameter keeps this method
 * assignable to the shared `KnowledgeQuery.search` contract.
 */
export type MultiValueSearchQuery = Omit<SearchQuery, 'space' | 'tag' | 'category' | 'group' | 'type'> & {
  space?: FilterInput;
  tag?: FilterInput;
  category?: FilterInput;
  group?: FilterInput;
  type?: FilterInput;
  /** `author:` as a parameter; repeatable (OR). Not in the shared contract yet. */
  author?: FilterInput;
  /** `is:` as a parameter; repeatable (OR). */
  is?: FilterInput;
  /** `updated:` as a parameter (`>2026-01-01`, `2026`, `30d`). */
  updated?: string;
};

/**
 * `FeedQuery` plus the homepage-aging knobs (§3.3) the shared contract does not
 * carry yet, and `tags` — any-of, exactly as a Section's `tags` match — so a
 * topic page can ask for "this topic's items carrying the Updates tags".
 */
export type FeedQueryOptions = FeedQuery & { homepage?: boolean; featured?: boolean; tags?: string[] };

/** `GET /popular`'s inputs, already validated and clamped by the controller. */
export interface PopularQuery {
  /** Topic slug or id; omitted = site-wide. */
  topic?: string;
  limit: number;
  days: number;
}

/** A feed entry plus `featured` (true while `featured_until` is in the future). */
export type HomepageFeedEntry = FeedEntry & { featured: boolean };

/**
 * Upper bound on rows scanned for feed/changedSince, which page in memory over
 * `PagesService.list` (the list API has a limit but no offset).
 */
const SCAN_LIMIT = 100_000;
const FEED_DEFAULT_LIMIT = 20;
const SEARCH_GROUP_CAP = 5;
const SECTION_DEFAULT_LIMIT = 10;
const WORDS_PER_MINUTE = 225;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class KnowledgeQueryService implements KnowledgeQuery {
  constructor(
    private readonly pages: PagesService,
    private readonly items: ItemsService,
    private readonly searchService: SearchService,
    private readonly spaces: SpacesService,
    private readonly config: ConfigService,
    private readonly wiki: WikiService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  /** Stable id first, then slug — the same order the MCP get_item tool resolves in. */
  async item(idOrSlug: string, viewer: Viewer): Promise<ItemViewWithSignals | null> {
    const actor = toReadActor(viewer);
    const item = (await this.items.getById(idOrSlug, actor)) ?? (await this.items.getBySlug(idOrSlug, actor));
    return item ? withLifecycleSignals(item) : null;
  }

  /**
   * One topic with its landing page (plan §3.1) and its curated Sections
   * resolved to items (§3.2). Sections with no visible items are omitted so
   * empty slots disappear from a portal landing page.
   */
  async topic(slug: string, viewer: Viewer): Promise<TopicView | null> {
    const spaces = await this.spaces.listWithCounts({ anonymousViewer: viewer.role === 'anonymous' });
    const space = spaces.find((s) => s.slug === slug || s.id === slug);
    if (!space) return null;
    const sections = (await this.sections(space.slug, viewer)).filter((s) => (s.items?.length ?? 0) > 0);
    return {
      ...toTopicView(space),
      landing_markdown: space.landing_markdown,
      start_here: space.start_here,
      sections,
    };
  }

  /** Topic list: presentation and counts only (no landing page or sections). */
  async topics(viewer: Viewer): Promise<TopicView[]> {
    const spaces = await this.spaces.listWithCounts({ anonymousViewer: viewer.role === 'anonymous' });
    return spaces.map(toTopicView);
  }

  /**
   * Curated Sections (all, or one topic's by slug/id), each with its published
   * items resolved newest first and capped at `limit` (default 10). Without a
   * viewer, items are resolved as an anonymous visitor. `type`, `space` and
   * `tags` all narrow together (AND); within `tags` any one match is enough.
   */
  async sections(topic?: string, viewer?: Viewer): Promise<SectionView[]> {
    const all = await this.config.getSections();
    let sections = all;
    if (topic) {
      // For a section that NAMES a topic, `space` is both PLACEMENT and
      // MEMBERSHIP: it decides which topic landing the section appears on AND
      // which topic its items come from. Do not split those into two fields —
      // two similar-looking fields is a classic confusion, and it would change
      // what `space` means for every section already configured.
      //
      // A section that names NO topic is the cross-topic case: it draws from
      // every topic and appears only on the front page (`crossTopicSections`),
      // deliberately not here, so one untopiced section does not become noise on
      // every topic landing in the instance.
      //
      // If "these three topics" is ever wanted, `topics?: string[]` is a clean
      // superset of both cases, with "no topic = every topic" as its default.
      const space = await this.spaces.getByRef(topic);
      const refs = new Set([topic, ...(space ? [space.slug, space.id] : [])]);
      sections = all.filter((s) => s.space !== undefined && refs.has(s.space));
    }
    return this.resolveSections(sections, viewer);
  }

  /**
   * The cross-topic Sections: those naming no topic, resolved across every topic
   * the viewer may read. These are the front page's, and only the front page's.
   *
   * Membership needs no special case — `pages.list` simply omits the space
   * filter — but that makes this the first surface drawing from every topic onto
   * the most public page in the product, so it leans on the list's anonymous
   * space gate: a private topic is "not exposed to anonymous visitors", and
   * signed-in readers are deliberately unaffected by that rule.
   */
  async crossTopicSections(viewer?: Viewer): Promise<SectionView[]> {
    const all = await this.config.getSections();
    const resolved = await this.resolveSections(all.filter((s) => s.space === undefined), viewer);
    // Drop the empty ones, exactly as `topic()` does. Without this the front
    // page renders a heading over an empty list — `SectionBlock` emits the
    // `<h2>` and then an empty `<ul>` — which is what a fresh instance saw the
    // moment anyone configured a "News" section before tagging anything `news`.
    // Tags are emergent here, so "configured but resolving to nothing" is the
    // NORMAL first state of a cross-topic section, not an edge case.
    return resolved.filter((s) => (s.items?.length ?? 0) > 0);
  }

  /** Each def's published members, newest first, as the given viewer. */
  private async resolveSections(defs: SectionDef[], viewer?: Viewer): Promise<SectionView[]> {
    const actor = toReadActor(viewer ?? { userId: null, role: 'anonymous' });
    const out: SectionView[] = [];
    for (const section of defs) {
      const pages = await this.pages.list(
        { type: section.type, space: section.space, tags: section.tags, status: 'published', sort: 'published', limit: section.limit ?? SECTION_DEFAULT_LIMIT },
        actor,
      );
      // `toFeedEntry`, not `toSummary`: Sections render as story lists, which
      // need cover, authors and reading time (home plan R2.11).
      const now = new Date();
      out.push({ ...section, items: pages.map((p) => toFeedEntry(p, now)) });
    }
    // One topic lookup for every Section in the response, not one per item.
    await this.withTopics(out.flatMap((s) => s.items ?? []));
    return out;
  }

  /**
   * Published items as a chronological feed (plan §3.3). `types` narrows to one
   * or more content-type labels (the list API takes a single type, so several
   * are filtered here); `author` matches case-insensitively; `homepage` drops
   * entries whose `homepage_until` has passed; a `series` request is ordered by
   * `series_order` (reading order) instead of date.
   */
  async feed(q: FeedQueryOptions, viewer: Viewer): Promise<Page<HomepageFeedEntry>> {
    const now = new Date();
    const single = q.types?.length === 1 ? q.types[0] : undefined;
    const pages = await this.pages.list(
      { space: q.topic, type: single, tags: q.tags, status: 'published', sort: 'published', limit: SCAN_LIMIT },
      toReadActor(viewer),
    );
    // `tags` narrows in SQL (`pages.list`), the same any-of match a Section
    // uses, so "a topic's updates" and "the Updates Section" cannot disagree
    // about which items carry the tag.
    let entries = pages
      .filter((p) => !q.homepage || !isPast(p.frontmatter['homepage_until'], now))
      .map((p) => toFeedEntry(p, now));
    if (q.types && q.types.length > 1) {
      const wanted = new Set(q.types.map((t) => canonicalTypeLabel(t)));
      entries = entries.filter((e) => e.type !== null && wanted.has(e.type));
    }
    if (q.featured) entries = entries.filter((e) => e.featured);
    if (q.series) entries = entries.filter((e) => e.series === q.series);
    if (q.author) {
      const needle = q.author.trim().toLowerCase();
      entries = entries.filter((e) => e.authors?.some((a) => a.toLowerCase() === needle));
    }
    if (q.series) {
      entries.sort(
        (a, b) =>
          (a.series_order ?? Number.MAX_SAFE_INTEGER) - (b.series_order ?? Number.MAX_SAFE_INTEGER) ||
          feedDate(a).localeCompare(feedDate(b)),
      );
    } else {
      entries.sort((a, b) => feedDate(b).localeCompare(feedDate(a)));
    }
    const page = paginate(entries, q.cursor, q.limit ?? FEED_DEFAULT_LIMIT);
    // After paging, so the lookup covers the page returned, not the whole scan.
    await this.withTopics(page.items);
    return page;
  }

  /**
   * The most-read published items in the last `days` (home plan R3): distinct
   * signed-in readers per item, most first, then the newest publish date.
   *
   * Two steps, and the split is the safety property. SQL only RANKS: it counts
   * distinct `user_id`s per page inside the window, over published, non-deleted
   * pages (and the topic, when named), so the candidate list is short and
   * already ordered. SQL does NOT decide visibility: every candidate then goes
   * through `pages.getById` with the viewer's actor — the same read path an item
   * open takes — so a private topic's item drops out for an anonymous visitor
   * exactly as it does everywhere else, and no second copy of that gate exists
   * here to drift. Walking stops once `limit` visible items are found.
   *
   * Aggregate only: the query selects a count, never a user id, so no response
   * can say who read what. Items nobody opened in the window have no
   * `page_views` row to join, so a zero-view item cannot appear.
   */
  async popular(q: PopularQuery, viewer: Viewer): Promise<PopularView> {
    const actor = toReadActor(viewer);
    const now = new Date();
    const since = new Date(now.getTime() - q.days * DAY_MS).toISOString();
    let ranked = this.db
      .selectFrom('page_views')
      .innerJoin('pages', 'pages.id', 'page_views.page_id')
      .select(({ fn }) => ['page_views.page_id as page_id', fn.count<number>('page_views.user_id').distinct().as('views')])
      .where('page_views.viewed_at', '>=', since)
      .where('pages.deleted_at', 'is', null)
      .where('pages.status', '=', 'published');
    if (q.topic) {
      const topic = q.topic;
      // Same id-or-slug resolution `pages.list({ space })` applies to `/feed?topic=`.
      ranked = ranked.where((eb) =>
        eb.exists(
          eb
            .selectFrom('spaces')
            .select('spaces.id')
            .whereRef('spaces.id', '=', 'pages.space_id')
            .where((inner) => inner.or([inner('spaces.id', '=', topic), inner('spaces.slug', '=', topic)])),
        ),
      );
    }
    const rows = await ranked
      .groupBy(['page_views.page_id', 'pages.published_at', 'pages.updated_at'])
      .orderBy('views', 'desc')
      .orderBy('pages.published_at', 'desc')
      .orderBy('pages.updated_at', 'desc')
      .execute();

    const items: PopularView['items'] = [];
    for (const row of rows) {
      if (items.length >= q.limit) break;
      const page = await this.pages.getById(row.page_id, { actor });
      if (!page || page.status !== 'published') continue;
      items.push({ ...toFeedEntry(page, now), views: Number(row.views) });
    }
    await this.withTopics(items);
    return { window_days: q.days, items };
  }

  /**
   * Fill `topic` (slug) and `topic_name` on list items, in place, with ONE query
   * for the whole response — an index surface labels every row with its topic,
   * and a lookup per row would be N queries for a page of N.
   *
   * No visibility check is needed or wanted here: every item handed in has
   * already passed the viewer's read gates, and an item's topic is visible to
   * anyone who may read the item (an anonymous visitor never receives an item
   * from a private topic, so never receives that topic's name either).
   */
  private async withTopics<T extends ItemSummary>(items: T[]): Promise<T[]> {
    const ids = Array.from(new Set(items.map((i) => i.space_id).filter((id): id is string => !!id)));
    if (!ids.length) return items;
    const rows = await this.db.selectFrom('spaces').select(['id', 'slug', 'name']).where('id', 'in', ids).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const item of items) {
      const space = item.space_id ? byId.get(item.space_id) : undefined;
      if (!space) continue;
      item.topic = space.slug;
      item.topic_name = space.name;
    }
    return items;
  }

  /**
   * The published `Series` item a series slug names (home plan R2.11), or null.
   *
   * `pages.slug` is UNIQUE across the instance, not per topic, so a slug names
   * at most one item and there is no "which topic's Series item" question to
   * answer. The read goes through `pages.getBySlug` with the viewer's actor, so
   * the private-topic gate applies exactly as it does to the parts; a draft is
   * excluded even for its owner or an admin, because the parts list excludes
   * drafts too and a landing page for unpublished work would disagree with it.
   * An item with the slug that is not a Series (a blog post called
   * `getting-started`, say) is not a landing page either.
   */
  async seriesItem(slug: string, viewer: Viewer): Promise<SeriesItem | null> {
    const page = await this.pages.getBySlug(slug, toReadActor(viewer));
    if (!page || page.status !== 'published') return null;
    if (canonicalTypeLabel(page.type ?? '') !== canonicalTypeLabel('series')) return null;
    const fm = page.frontmatter;
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      description: asString(fm['description']) ?? asString(fm['summary']) ?? null,
      cover: coverOf(fm),
      cover_alt: asString(fm['cover_alt']) ?? null,
      space_id: page.space_id,
    };
  }

  async search(q: MultiValueSearchQuery, viewer: Viewer): Promise<GroupedSearchResultSet> {
    // Same draft-visibility rule REST and MCP each applied before: drafts are
    // returned only when asked for (flag, status filter, or `status:draft` in
    // the query text) AND the caller is an admin.
    const parsed = parseSearchQuery(q.q ?? '');
    const structuredStatus = parsed.filters.status?.[0];
    // `is:draft` asks for drafts the same way `status:draft` does; it still only
    // widens visibility for an admin, below.
    const isValues = [...(parsed.filters.is ?? []), ...(Array.isArray(q.is) ? q.is : q.is ? [q.is] : [])];
    const wantDrafts =
      q.include_drafts === true || q.status === 'draft' || structuredStatus === 'draft' || isValues.some((value) => value.trim().toLowerCase() === 'draft');
    const set = await this.searchService.searchWithContext({
      q: q.q,
      tag: q.tag,
      category: q.category,
      group: q.group,
      space: q.space,
      type: q.type,
      author: q.author,
      is: q.is,
      updated: q.updated,
      status: q.status,
      since: q.since,
      sort: q.sort ?? 'relevance',
      include_drafts: wantDrafts && viewer.role === 'admin',
      viewer_id: toReadActor(viewer).id,
      limit: q.limit,
      offset: q.offset,
    });
    // Grouping reads only `type` and `score`; the server's hit shape carries
    // `topic` where the shared type has `space_id`, so the hits pass through
    // with only the review signals added and the groups reference the very same
    // objects as `results`.
    const signalled = await this.withReviewSignals(set.results as unknown as KnowledgeSearchHit[]);
    // Plan §3.5 item 3: stable and verified rank above stale, deprecated items
    // are shown but demoted with their successor still on the row, and
    // machine-generated-but-unverified is nudged down. The labels have been
    // rendering since Phase 2 while the ranking behind them was never wired in,
    // so results *showed* trust and freshness without being ordered by it —
    // half of "Find it fast. Trust it fully."
    //
    // Relevance only. Under an explicit `recent` (or any non-relevance) sort the
    // user asked for a specific order and a lifecycle multiplier would silently
    // override it; the demotion belongs to the relevance score, not to the sort.
    const hits = (q.sort ?? 'relevance') === 'relevance' ? applyLifecyclePolicy(signalled) : signalled;
    return {
      ...set,
      results: hits as unknown as SearchResultSet['results'],
      // The echoed query keeps the shared shape; a repeated filter reads back
      // as the list the caller sent.
      query: q as SearchQuery,
      groups: groupHits(hits, { capPerGroup: SEARCH_GROUP_CAP }),
    };
  }

  /**
   * `GET /search/overview` (reader plan R3.6): the library's shape for a reader
   * who has not typed anything yet. Counts and visibility come from
   * `SearchService.overview`, which filters with the search predicate itself;
   * this seam only labels the item lists with their Topic, as every other index
   * surface does.
   */
  async searchOverview(viewer: Viewer): Promise<SearchOverview> {
    const overview = await this.searchService.overview({ viewer_id: toReadActor(viewer).id });
    await this.withTopics([...overview.recently_verified, ...overview.recently_updated]);
    return overview;
  }

  /** Items linking to this one (backlinks), as visible to the viewer. */
  async related(id: string, viewer: Viewer): Promise<ItemSummary[]> {
    const actor = toReadActor(viewer);
    const target = await this.pages.getById(id, { actor });
    if (!target) return [];
    const rows = await this.wiki.backlinks({ id: target.id, slug: target.slug, title: target.title }, actor);
    const out: ItemSummary[] = [];
    for (const sourceId of new Set(rows.map((r) => r.source_item_id))) {
      const source = await this.pages.getById(sourceId, { actor });
      if (source) out.push(toSummary(source));
    }
    return out;
  }

  async changedSince(since: string, viewer: Viewer): Promise<Page<ItemSummary>> {
    const pages = await this.pages.list({ since, status: 'published', limit: SCAN_LIMIT }, toReadActor(viewer));
    const items = pages.map(toSummary).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return { items, next_cursor: null, total: items.length };
  }

  /**
   * Add the change request (plan §8.2) to search hits. The index carries
   * `trust_tier`/`stale` but not the `review_*` columns, so they are read here
   * in one pass over `pages` — the same columns `(source_id, review_state)` is
   * indexed on. Hits that were never staged are returned untouched; a hit whose
   * change request is open reads `display_state: 'in-review'`, exactly as its
   * item view does.
   */
  private async withReviewSignals(hits: KnowledgeSearchHit[]): Promise<KnowledgeSearchHit[]> {
    if (!hits.length) return hits;
    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'review_state', 'review_url', 'review_branch', 'review_opened_at', 'review_closed_at'])
      .where('review_state', 'is not', null)
      .where('id', 'in', hits.map((hit) => hit.id))
      .execute();
    if (!rows.length) return hits;
    const byId = new Map<string, ReviewRef>();
    for (const row of rows) {
      const review = reviewRefFrom(row);
      if (review) byId.set(row.id, review);
    }
    return hits.map((hit): KnowledgeSearchHit => {
      const review = byId.get(hit.id);
      if (!review) return hit;
      return review.state === 'open' ? { ...hit, review, display_state: 'in-review' } : { ...hit, review };
    });
  }
}

/**
 * Prefer the indexed lifecycle columns when the item carries them (`trust_tier`
 * set); otherwise derive from frontmatter. Same output either way.
 */
export function withLifecycleSignals<T extends ItemView & Partial<LifecycleColumnRow>>(
  item: T,
): Omit<T, 'display_state'> & DerivedDisplayState {
  return { ...item, ...lifecycleSignals(item, item.frontmatter) };
}

function toTopicView(space: SpaceWithCountsView): TopicView {
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    description: space.description,
    visibility: space.visibility,
    presentation: space.presentation,
    counts: { items: space.counts.items, published: space.counts.published },
  };
}

/**
 * A page row as a summary. `review` and the review-aware `display_state` ride
 * along (plan §8.2), so a card in a feed, a Section or a browse list can show
 * the "In review" badge the read page shows — same derivation as `item()`.
 */
function toSummary(page: PageView): ItemSummary {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    type: page.type,
    space_id: page.space_id,
    description: asString(page.frontmatter['description']) ?? null,
    updated_at: page.updated_at,
    published_at: page.published_at,
    tags: page.tags,
    categories: page.categories,
    groups: page.groups,
    review: page.review ?? null,
    ...lifecycleSignals(page, page.frontmatter),
  };
}

function toFeedEntry(page: PageView, now: Date): HomepageFeedEntry {
  const fm = page.frontmatter;
  const authors = Array.isArray(fm['authors'])
    ? fm['authors'].filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
    : [];
  const author = asString(fm['author']);
  const seriesOrder = fm['series_order'];
  return {
    ...toSummary(page),
    authors: authors.length ? authors : author ? [author] : [],
    cover: coverOf(fm),
    reading_time_minutes: readingTimeMinutes(page.body_markdown),
    series: asString(fm['series']) ?? null,
    series_order: typeof seriesOrder === 'number' ? seriesOrder : null,
    featured: isFuture(fm['featured_until'], now),
  };
}

/** The cover URL from frontmatter — same lookup order as the web's blogMeta.coverImageOf. */
function coverOf(fm: Record<string, unknown>): string | null {
  return asString(fm['cover']) ?? asString(fm['cover_image']) ?? asString(fm['hero_image']) ?? null;
}

/** True when `value` parses as a date later than `now` (missing/unparseable ⇒ false). */
function isFuture(value: unknown, now: Date): boolean {
  const ms = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
  return !Number.isNaN(ms) && ms > now.getTime();
}

/** True when `value` parses as a date at or before `now` (missing/unparseable ⇒ never expires). */
function isPast(value: unknown, now: Date): boolean {
  const ms = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
  return !Number.isNaN(ms) && ms <= now.getTime();
}

function feedDate(entry: FeedEntry): string {
  return entry.published_at ?? entry.updated_at;
}

function paginate<T>(entries: T[], cursor: string | undefined, limit: number): Page<T> {
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const end = offset + limit;
  return {
    items: entries.slice(offset, end),
    next_cursor: end < entries.length ? String(end) : null,
    total: entries.length,
  };
}

/** Same estimate the web's blog cards use (words / 225, whole minutes, >= 1). */
function readingTimeMinutes(body: string | undefined): number {
  if (!body) return 1;
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#*_>[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 1;
  const words = text.split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
