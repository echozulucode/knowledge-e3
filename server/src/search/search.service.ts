/**
 * Search service.
 *
 * SQLite dev/test uses pages_fts for relevance queries and direct pages queries
 * for browse/sort modes. REST and MCP call this same service so filter parity is
 * enforced in one place.
 *
 * Three rules, from the reader UX plan §5:
 *
 *   - **Every operator the parser accepts reaches the results.** Filter values
 *     within a key OR (`tag:a tag:b`), keys AND, `-key:value` excludes, and
 *     `-term` / `-"phrase"` exclude text. Anything not honoured comes back in
 *     `warnings` rather than vanishing.
 *   - **One predicate, three uses.** The filter/visibility clauses are built
 *     once, as SQL fragments over a table alias, and reused by the FTS pass,
 *     the browse pass, the honest `COUNT(*)`, and the facet aggregates — so a
 *     count, a facet and a result list can never disagree about what matched.
 *   - **The trailing word is a prefix.** While a reader is still typing, the
 *     last bare term matches as an FTS5 prefix (`modb` finds `modbus`); a
 *     quoted phrase never expands, and an exact token always outranks a prefix
 *     hit because the weighted ranker scores the finished word higher.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type RawBuilder } from 'kysely';
import type { OkfTrustTier } from '@echozedlabs/okf';
import {
  canonicalIsValue,
  DEFAULT_EXCERPT_CHARS,
  excerpt,
  freeTextOf,
  hasTextSignal,
  highlightRanges,
  IS_FILTER_VALUES,
  normalizeAuthor,
  parseSearchQuery,
  parseUpdatedFilter,
  plainTextForExcerpt,
  resolveFilters,
  type ExcerptMatch,
  type ExcerptResult,
  type IsFilterValue,
  type ParsedSearchQuery,
  type UpdatedRange,
} from '@echozedlabs/search';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { lifecycleSignals, reviewRefFrom, type LifecycleColumnRow } from '../pages/lifecycle-columns.js';
import { descriptionFromFrontmatter } from '../pages/description.js';
import { FtsRecencyRanker, Ranker, RankedResult } from './ranker.js';
import { aliasesFromFrontmatter, ftsBm25Sql } from './fts-index.js';
import { leadOf } from './snippet.js';

// One definition, in the contract sink; `verified` is ordered below (reader plan R5).
export type { SortMode } from '@echozedlabs/knowledge-types';
import type { ItemSummary, SearchHighlights, SearchOverview, SortMode } from '@echozedlabs/knowledge-types';
export type SearchStatus = 'draft' | 'published';

/** A filter the caller may repeat: `?tag=a&tag=b` arrives as an array. */
export type FilterInput = string | string[];

export interface SearchOptions {
  q?: string;
  space?: FilterInput;
  tag?: FilterInput;
  category?: FilterInput;
  group?: FilterInput;
  /** Content type label (`Runbook`), matched case-insensitively. */
  type?: FilterInput;
  /**
   * Author name(s) — frontmatter `authors` or `author`, exact after whitespace
   * collapse and case folding. Repeatable (OR). Replaces `author:` from `q`.
   */
  author?: FilterInput;
  /** Lifecycle/trust values (`verified`, `needs-review`, …). Repeatable (OR). Replaces `is:` from `q`. */
  is?: FilterInput;
  /** An `updated:` value (`>2026-01-01`, `2026-08`, `30d`). Replaces `updated:` from `q`. */
  updated?: string;
  status?: SearchStatus;
  since?: string;
  sort?: SortMode;
  include_drafts?: boolean;
  /**
   * The calling user's id. When set (and `include_drafts` is false), the caller
   * also sees their own drafts — parity with PagesService.list. Admins pass
   * `include_drafts` instead and this is ignored.
   */
  viewer_id?: string;
  limit?: number;
  /** Pagination offset into the ranked result set (infinite scroll / load-more). */
  offset?: number;
}

export interface SearchHit {
  id: string;
  slug: string;
  title: string;
  path?: string;
  url?: string;
  updated_at: string;
  status: SearchStatus;
  type?: string | null;
  score: number;
  /**
   * A plain-text excerpt (≤ ~180 chars, cut on word boundaries, never raw
   * Markdown). It carries no ellipsis characters; `snippet_truncated` says where
   * text was cut so the client draws them.
   */
  snippet?: string;
  snippet_truncated?: { start: boolean; end: boolean };
  /** `[start, end)` UTF-16 ranges into `title` and `snippet` where the query matched. */
  highlights?: SearchHighlights;
  topic?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  matched_fields?: string[];
  reasons?: string[];
  /** Derived OKF v0.2 trust tier (§5.3), from the concept's `verified` frontmatter. */
  trust_tier?: OkfTrustTier;
  /** Derived OKF v0.2 freshness (§5.5): true when past `stale_after`. */
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
  /** Content types, counted over every match rather than the returned page. */
  types: SearchFacetValue[];
  /** Primary categories — a curated, admin-managed vocabulary, so a reliable axis. */
  categories: SearchFacetValue[];
  /** Derived OKF v0.2 trust-tier distribution across the results (§5.3). */
  trust_tiers: SearchFacetValue[];
}

export interface SearchEmptyState {
  title: string;
  guidance: string[];
  can_create_from_search: boolean;
}

export interface SearchResultSet {
  results: SearchHit[];
  /**
   * Every item that matched, not the size of this page. Counted with the same
   * predicate that produced `results`, because a search that says "100 results"
   * when there are 400 costs the reader their trust in the whole index.
   */
  total: number;
  /** Where this page starts in the ranked list, echoed so a client can page. */
  offset: number;
  /** Page size actually applied (the caller's `limit`, clamped). */
  limit: number;
  facets: SearchFacets;
  warnings: string[];
  empty_state?: SearchEmptyState;
}

interface RawSearchRow {
  page_id: string;
  slug: string;
  title: string;
  updated_at: string;
  status: SearchStatus;
  bm25: number;
}

interface PageMetadata {
  body: string;
  /** The item's own one-line summary (frontmatter `description`), indexed in `pages_fts`. */
  description: string;
  /** Frontmatter `aliases` — other names the item goes by, indexed in `pages_fts`. */
  aliases: string[];
  frontmatter: Record<string, unknown>;
  topic?: string;
  type?: string | null;
  tags: string[];
  categories: string[];
  groups: string[];
  /** The indexed lifecycle columns (null on rows written before them). */
  lifecycle: Omit<LifecycleColumnRow, 'status'>;
}

/** Taxonomy axes, resolved to the value lists both providers filter on. */
interface AxisFilters {
  space: string[];
  tag: string[];
  category: string[];
  group: string[];
  type: string[];
  not: { space: string[]; tag: string[]; category: string[]; group: string[]; type: string[] };
}

/**
 * The item filters, with the SAME meaning as `packages/search`
 * `filter-semantics.ts` (the reference `InMemorySearchProvider` filters with):
 * values OR within a key, keys AND, negation excludes.
 */
interface ItemFilters {
  /** `normalizeAuthor` form, compared to `page_authors.author`. */
  author: string[];
  is: IsFilterValue[];
  updated: UpdatedRange | null;
  not: { author: string[]; is: IsFilterValue[] };
}

/**
 * One query, fully resolved: free text, filters, visibility and paging. Every
 * read path takes this, so the structured part of a query is interpreted
 * exactly once (and re-resolving an already-resolved query cannot lose the
 * exclusions the way passing rewritten `q` around used to).
 */
interface ResolvedSearch {
  /** Free text only — the filters have been lifted out of the raw query. */
  q?: string;
  parsed: ParsedSearchQuery;
  filters: AxisFilters;
  /** `author:` / `is:` / `updated:`, resolved (authors already normalized). */
  items: ItemFilters;
  /** The one clock this query is evaluated against (`updated:30d`, `is:needs-review`). */
  now: Date;
  status?: SearchStatus;
  since?: string;
  sort: SortMode;
  limit: number;
  offset: number;
  includeDrafts: boolean;
  anonymous: boolean;
  viewerId?: string;
  warnings: string[];
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_FACET_VALUES = 12;
/** Overview caps (reader plan R3.6): enough vocabulary to start from, not a tag cloud. */
const OVERVIEW_TAGS = 24;
const OVERVIEW_ITEMS = 6;
/** Tiers that mean "somebody checked this"; `unverified` never counts as recently verified. */
const VERIFIED_TIERS = ['human-reviewed', 'machine-confirmed'];

@Injectable()
export class SearchService {
  private readonly ranker: Ranker = new FtsRecencyRanker();

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async searchWithContext(opts: SearchOptions): Promise<SearchResultSet> {
    const resolved = resolveSearch(opts);
    if (isForbiddenDraftSearch(resolved)) {
      return {
        results: [],
        total: 0,
        offset: resolved.offset,
        limit: resolved.limit,
        facets: emptyFacets(),
        warnings: resolved.warnings,
        empty_state: emptyStateFor(resolved),
      };
    }
    const [results, total, facets] = await Promise.all([
      this.runSearch(resolved),
      this.countMatching(resolved),
      this.facetsFor(resolved),
    ]);
    return {
      results,
      total,
      offset: resolved.offset,
      limit: resolved.limit,
      facets,
      warnings: resolved.warnings,
      empty_state: results.length ? undefined : emptyStateFor(resolved),
    };
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const resolved = resolveSearch(opts);
    if (isForbiddenDraftSearch(resolved)) return [];
    return this.runSearch(resolved);
  }

  /**
   * `GET /search/overview` — what `/search` shows before anything is typed
   * (reader plan R3.6): the library's shape as counts, plus the most recently
   * verified and updated items.
   *
   * Visibility is not re-derived here. The overview is resolved as a query-less,
   * published-only search for this viewer and filtered with `rowPredicates`, the
   * predicate every search pass uses — so it can never count or list an item
   * (or a private Topic's name, for an anonymous reader) that the same reader's
   * search would not return.
   *
   * Cost: one subquery of visible ids reused by four grouped aggregates and a
   * count, two ordered id lists, and one batched hydration of at most twelve
   * items — a fixed number of queries whatever the library's size.
   */
  async overview(opts: { viewer_id?: string } = {}): Promise<SearchOverview> {
    const r = resolveSearch({ ...(opts.viewer_id ? { viewer_id: opts.viewer_id } : {}), status: 'published' });
    const visible = this.matchingIds(r);
    const visibleRows = () => {
      let q = this.db.selectFrom('pages').select(['pages.id']);
      for (const predicate of rowPredicates('pages', r, { text: 'none' })) q = q.where(predicate);
      return q;
    };

    const [totalRow, types, topics, categories, tags, verified, updated] = await Promise.all([
      this.db
        .selectFrom('pages')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('pages.id', 'in', visible)
        .executeTakeFirst(),
      this.db
        .selectFrom('pages')
        .select(['pages.type as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', visible)
        .where('pages.type', 'is not', null)
        .groupBy('pages.type')
        .execute(),
      this.db
        .selectFrom('pages')
        .innerJoin('spaces', 'spaces.id', 'pages.space_id')
        .select(['spaces.name as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', visible)
        .groupBy('spaces.name')
        .execute(),
      this.db
        .selectFrom('page_categories')
        .select(['page_categories.category as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('page_categories.page_id', 'in', visible)
        .groupBy('page_categories.category')
        .execute(),
      this.db
        .selectFrom('page_tags')
        .select(['page_tags.tag as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('page_tags.page_id', 'in', visible)
        .groupBy('page_tags.tag')
        .execute(),
      visibleRows()
        .where('pages.trust_tier', 'in', VERIFIED_TIERS)
        .where('pages.last_verified_at', 'is not', null)
        .orderBy('pages.last_verified_at', 'desc')
        .orderBy('pages.updated_at', 'desc')
        .limit(OVERVIEW_ITEMS)
        .execute(),
      visibleRows().orderBy('pages.updated_at', 'desc').limit(OVERVIEW_ITEMS).execute(),
    ]);

    const summaries = await this.summariesFor([...verified, ...updated].map((row) => row.id));
    const pick = (rows: { id: string }[]) => rows.map((row) => summaries.get(row.id)).filter((item): item is ItemSummary => Boolean(item));
    return {
      total: Number(totalRow?.count ?? 0),
      // Every type, Topic and category: they are small, curated axes, and a
      // missing one is a door the reader cannot see. Tags are emergent, so capped.
      types: facetFrom(types, [], undefined, Number.POSITIVE_INFINITY),
      topics: facetFrom(topics, [], undefined, Number.POSITIVE_INFINITY),
      categories: facetFrom(categories, [], undefined, Number.POSITIVE_INFINITY),
      tags: facetFrom(tags, [], undefined, OVERVIEW_TAGS),
      recently_verified: pick(verified),
      recently_updated: pick(updated),
    };
  }

  /**
   * `ItemSummary` rows for a handful of already-authorized ids, in four batched
   * queries. Callers pass ids that came out of `rowPredicates`; this adds no
   * visibility of its own and must not be handed unfiltered ids.
   */
  private async summariesFor(pageIds: string[]): Promise<Map<string, ItemSummary>> {
    const ids = [...new Set(pageIds)];
    const out = new Map<string, ItemSummary>();
    if (!ids.length) return out;
    const [rows, tags, categories, groups] = await Promise.all([
      this.db
        .selectFrom('pages')
        .leftJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .select([
          'pages.id',
          'pages.slug',
          'pages.title',
          'pages.status',
          'pages.type',
          'pages.space_id',
          'pages.updated_at',
          'pages.published_at',
          'pages.lifecycle_status',
          'pages.stale_after',
          'pages.trust_tier',
          'pages.last_verified_at',
          'pages.generated_by',
          'pages.superseded_by',
          'pages.review_state',
          'pages.review_url',
          'pages.review_branch',
          'pages.review_opened_at',
          'pages.review_closed_at',
          'page_versions.frontmatter_json',
        ])
        .where('pages.id', 'in', ids)
        .execute(),
      this.db.selectFrom('page_tags').select(['page_id', 'tag as value']).where('page_id', 'in', ids).orderBy('tag').execute(),
      this.db.selectFrom('page_categories').select(['page_id', 'category as value']).where('page_id', 'in', ids).orderBy('category').execute(),
      this.db
        .selectFrom('page_groups')
        .innerJoin('groups', 'groups.id', 'page_groups.group_id')
        .select(['page_groups.page_id as page_id', 'groups.slug as value'])
        .where('page_groups.page_id', 'in', ids)
        .orderBy('groups.slug')
        .execute(),
    ]);
    const listsFor = (list: { page_id: string; value: string }[]) => {
      const byPage = new Map<string, string[]>();
      for (const row of list) byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), row.value]);
      return byPage;
    };
    const [tagsBy, categoriesBy, groupsBy] = [listsFor(tags), listsFor(categories), listsFor(groups)];
    const now = new Date();
    for (const row of rows) {
      const frontmatter = parseFrontmatter(row.frontmatter_json);
      const review = reviewRefFrom(row);
      out.set(row.id, {
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        type: row.type,
        space_id: row.space_id,
        description: descriptionFromFrontmatter(frontmatter) || null,
        updated_at: row.updated_at,
        published_at: row.published_at,
        tags: tagsBy.get(row.id) ?? [],
        categories: categoriesBy.get(row.id) ?? [],
        groups: groupsBy.get(row.id) ?? [],
        review,
        ...lifecycleSignals({ ...row, review }, frontmatter, now),
      });
    }
    return out;
  }

  private async runSearch(r: ResolvedSearch): Promise<SearchHit[]> {
    if (!r.q || !r.q.trim() || r.sort !== 'relevance') return this.directList(r);
    return this.ftsSearch(r);
  }

  private async directList(r: ResolvedSearch): Promise<SearchHit[]> {
    let q = this.db.selectFrom('pages').select(['id', 'slug', 'title', 'updated_at', 'status']);
    for (const predicate of rowPredicates('pages', r, { text: 'like' })) q = q.where(predicate);
    if (r.sort === 'newest') q = q.orderBy('updated_at', 'desc');
    else if (r.sort === 'oldest') q = q.orderBy('updated_at', 'asc');
    else if (r.sort === 'az') q = q.orderBy('title', 'asc');
    else if (r.sort === 'verified') {
      // Most recently verified first. SQLite sorts NULL lowest, so under DESC
      // every never-verified item lands after every verified one with no extra
      // term — which keeps `idx_pages_last_verified` usable — and within the
      // unverified band the newest edit leads.
      q = q.orderBy('last_verified_at', 'desc').orderBy('updated_at', 'desc');
    } else q = q.orderBy('updated_at', 'desc');
    const rows = await q.limit(r.limit).offset(r.offset).execute();
    return this.enrichHits(rows.map((row) => ({ ...row, score: 0 })), r.q, undefined, r);
  }

  private async ftsSearch(r: ResolvedSearch): Promise<SearchHit[]> {
    const query = r.q!.trim();
    const matchExpr = ftsMatchExpr(r.parsed);
    const candidateLimit = Math.min(Math.max((r.offset + r.limit) * 5, 50), 400);
    const where = sql.join(rowPredicates('p', r, { text: 'none' }), sql` AND `);
    const rows = await sql<RawSearchRow>`
      SELECT
        p.id AS page_id,
        p.slug AS slug,
        p.title AS title,
        p.updated_at AS updated_at,
        p.status AS status,
        ${ftsBm25Sql()} AS bm25
      FROM pages_fts
      INNER JOIN pages p ON p.id = pages_fts.page_id
      WHERE pages_fts MATCH ${matchExpr}
        AND ${where}
      ORDER BY bm25 ASC
      LIMIT ${candidateLimit}
    `.execute(this.db);

    const candidates = rows.rows.map((row) => ({
      id: row.page_id,
      slug: row.slug,
      title: row.title,
      updated_at: row.updated_at,
      fts_rank: 1 / (1 + Math.max(0, row.bm25)),
      status: row.status,
    }));

    const metadata = await this.metadataForPages(candidates.map((candidate) => candidate.id));
    const enrichedCandidates = candidates.map((candidate) => {
      const meta = metadata.get(candidate.id);
      return {
        ...candidate,
        body: meta?.body,
        description: meta?.description,
        topic: meta?.topic,
        tags: meta?.tags,
        categories: meta?.categories,
        groups: meta?.groups,
      };
    });

    const ranked: RankedResult[] = this.ranker.score(query, enrichedCandidates);
    const hits: SearchHit[] = ranked.map((hit) => ({
      id: hit.id,
      slug: hit.slug,
      title: hit.title,
      updated_at: hit.updated_at,
      status: (hit as unknown as { status: SearchStatus }).status,
      score: hit.score,
    }));

    return this.enrichHits(hits.slice(r.offset, r.offset + r.limit), query, metadata, r);
  }

  /**
   * How many items match — the real number, over the same predicate the result
   * page came from (relevance: the FTS match; browse: the title/slug filter),
   * so paging and the result count agree.
   */
  private async countMatching(r: ResolvedSearch): Promise<number> {
    const relevance = Boolean(r.q?.trim()) && r.sort === 'relevance';
    let q = this.db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('count'));
    for (const predicate of rowPredicates('pages', r, { text: relevance ? 'fts' : 'like' })) q = q.where(predicate);
    const row = await q.executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Facets over every match, not over the returned page: a chip that says "42"
   * has to mean 42 items, or the reader learns not to believe the numbers.
   */
  private async facetsFor(r: ResolvedSearch): Promise<SearchFacets> {
    // Each axis is counted with every OTHER filter applied but not its own, so
    // narrowing to `type:Runbook` still shows how many FAQs the query matched.
    // Hiding the chip you would use to widen the search is how a reader gets
    // stuck in a corner with no visible way out.
    const matching = (axis?: Axis | 'status' | 'trust') => this.matchingIds(axis ? withoutAxis(r, axis) : r);

    const [topics, statuses, tags, types, categories, trustTiers] = await Promise.all([
      this.db
        .selectFrom('pages')
        .innerJoin('spaces', 'spaces.id', 'pages.space_id')
        .select(['spaces.name as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', matching('space'))
        .groupBy('spaces.name')
        .execute(),
      this.db
        .selectFrom('pages')
        .select(['pages.status as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', matching('status'))
        .groupBy('pages.status')
        .execute(),
      this.db
        .selectFrom('page_tags')
        .select(['page_tags.tag as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('page_tags.page_id', 'in', matching('tag'))
        .groupBy('page_tags.tag')
        .execute(),
      this.db
        .selectFrom('pages')
        .select(['pages.type as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', matching('type'))
        .where('pages.type', 'is not', null)
        .groupBy('pages.type')
        .execute(),
      this.db
        .selectFrom('page_categories')
        .select(['page_categories.category as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('page_categories.page_id', 'in', matching('category'))
        .groupBy('page_categories.category')
        .execute(),
      this.db
        .selectFrom('pages')
        .select(['pages.trust_tier as value', (eb) => eb.fn.countAll<number>().as('count')])
        .where('pages.id', 'in', matching('trust'))
        .where('pages.trust_tier', 'is not', null)
        .groupBy('pages.trust_tier')
        .execute(),
    ]);

    return {
      topics: facetFrom(topics, r.filters.space),
      statuses: facetFrom(statuses, r.status ? [r.status] : [], (status) => (status === 'draft' ? 'Draft' : 'Published')),
      tags: facetFrom(tags, r.filters.tag),
      types: facetFrom(types, r.filters.type),
      categories: facetFrom(categories, r.filters.category),
      trust_tiers: facetFrom(trustTiers, [], trustTierLabel),
    };
  }

  /** The ids of everything that matched, as a subquery the facet aggregates reuse. */
  private matchingIds(r: ResolvedSearch) {
    const relevance = Boolean(r.q?.trim()) && r.sort === 'relevance';
    let q = this.db.selectFrom('pages').select('pages.id');
    for (const predicate of rowPredicates('pages', r, { text: relevance ? 'fts' : 'like' })) q = q.where(predicate);
    return q;
  }

  private async enrichHits(hits: SearchHit[], query?: string, preloadedMetadata?: Map<string, PageMetadata>, r?: ResolvedSearch): Promise<SearchHit[]> {
    if (!hits.length) return hits;
    const metadata = new Map(preloadedMetadata ?? []);
    const missingIds = hits.map((hit) => hit.id).filter((id) => !metadata.has(id));
    if (missingIds.length) {
      const missingMetadata = await this.metadataForPages(missingIds);
      for (const [pageId, meta] of missingMetadata) metadata.set(pageId, meta);
    }
    const now = new Date();
    return hits.map((hit) => {
      const canonical = withStableReferences(hit);
      const meta = metadata.get(hit.id);
      if (!meta) return canonical;
      const matched = query ? matchedFields(query, hit, meta) : [];
      // Indexed OKF v0.2 signals (columns), falling back to frontmatter for
      // rows that predate them. `stale` is as of this query's `now`.
      const signals = lifecycleSignals({ status: hit.status, ...meta.lifecycle }, meta.frontmatter, now);
      return {
        ...canonical,
        type: meta.type ?? null,
        topic: meta.topic,
        tags: meta.tags,
        categories: meta.categories,
        groups: meta.groups,
        ...presentationFor(r ? matchOf(r.parsed) : null, hit.title, meta),
        matched_fields: matched,
        reasons: reasonsFor(query, matched, meta, canonical, r),
        trust_tier: signals.trust_tier,
        stale: signals.stale,
      };
    });
  }

  private async metadataForPages(pageIds: string[]): Promise<Map<string, PageMetadata>> {
    const uniqueIds = [...new Set(pageIds)];
    const result = new Map<string, PageMetadata>();
    await Promise.all(
      uniqueIds.map(async (pageId) => {
        const row = await this.db
          .selectFrom('pages')
          .leftJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
          .leftJoin('spaces', 'spaces.id', 'pages.space_id')
          .select([
            'page_versions.body_markdown',
            'page_versions.frontmatter_json',
            'spaces.name as space_name',
            'pages.type as type',
            'pages.lifecycle_status',
            'pages.stale_after',
            'pages.trust_tier',
            'pages.last_verified_at',
            'pages.generated_by',
            'pages.superseded_by',
          ])
          .where('pages.id', '=', pageId)
          .executeTakeFirst();
        const [tags, categories, groupRows] = await Promise.all([
          this.db.selectFrom('page_tags').select('tag').where('page_id', '=', pageId).orderBy('tag', 'asc').execute(),
          this.db.selectFrom('page_categories').select('category').where('page_id', '=', pageId).orderBy('category', 'asc').execute(),
          this.db
            .selectFrom('page_groups')
            .innerJoin('groups', 'groups.id', 'page_groups.group_id')
            .select('groups.slug')
            .where('page_groups.page_id', '=', pageId)
            .orderBy('groups.slug', 'asc')
            .execute(),
        ]);
        const frontmatter = parseFrontmatter(row?.frontmatter_json);
        const topic = typeof frontmatter.topic === 'string' && frontmatter.topic.trim() ? frontmatter.topic : row?.space_name ?? undefined;
        result.set(pageId, {
          body: row?.body_markdown ?? '',
          description: descriptionFromFrontmatter(frontmatter),
          aliases: aliasesFromFrontmatter(frontmatter),
          frontmatter,
          topic,
          type: row?.type ?? null,
          tags: tags.map((r) => r.tag),
          categories: categories.map((r) => r.category),
          groups: groupRows.map((r) => r.slug),
          lifecycle: {
            lifecycle_status: row?.lifecycle_status ?? null,
            stale_after: row?.stale_after ?? null,
            trust_tier: row?.trust_tier ?? null,
            last_verified_at: row?.last_verified_at ?? null,
            generated_by: row?.generated_by ?? null,
            superseded_by: row?.superseded_by ?? null,
          },
        });
      }),
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Query resolution
// ---------------------------------------------------------------------------

function resolveSearch(opts: SearchOptions): ResolvedSearch {
  const now = new Date();
  const parsed = parseSearchQuery(opts.q ?? '', { now });
  const axes = resolveFilters(parsed, {
    space: opts.space,
    tag: opts.tag,
    category: opts.category,
    group: opts.group,
    type: opts.type,
  });
  const warnings = [...parsed.warnings];
  const status = opts.status ?? parseStructuredStatus(parsed.filters.status?.[0]);
  return {
    q: freeTextOf(parsed),
    parsed,
    filters: axes,
    items: resolveItemFilters(parsed, opts, now, warnings),
    now,
    ...(status ? { status } : {}),
    ...(opts.since ? { since: opts.since } : {}),
    sort: opts.sort ?? 'relevance',
    limit: Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT),
    offset: Math.max(0, Math.floor(opts.offset ?? 0)),
    includeDrafts: !!opts.include_drafts,
    // Derived, never passed in: an unauthenticated visitor is exactly the caller
    // whose viewer_id is the anonymous sentinel. Deriving it here means a new
    // caller (REST, MCP, a future transport) cannot leak private spaces by
    // forgetting to set a flag.
    anonymous: opts.viewer_id === ANONYMOUS_ACTOR.id,
    ...(opts.viewer_id ? { viewerId: opts.viewer_id } : {}),
    warnings,
  };
}

/**
 * `author:`, `is:` and `updated:` from the query text, with an explicit option
 * REPLACING the parsed values of the same key — the rule `resolveFilters`
 * applies to the taxonomy axes, so `?author=` and `author:` compose the same
 * way `?tag=` and `tag:` do. Values the parser would have warned about are
 * warned about here too, never silently dropped.
 */
function resolveItemFilters(parsed: ParsedSearchQuery, opts: SearchOptions, now: Date, warnings: string[]): ItemFilters {
  const authors = (values: string[]) => [...new Set(values.map(normalizeAuthor).filter(Boolean))];
  const explicitAuthors = filterList(opts.author);
  const explicitIs: IsFilterValue[] = [];
  for (const value of filterList(opts.is)) {
    const canonical = canonicalIsValue(value);
    if (canonical) explicitIs.push(canonical);
    else warnings.push(`Unknown is value ignored: ${value} (use ${IS_FILTER_VALUES.join(', ')})`);
  }
  let updated = parsed.updated ?? null;
  if (opts.updated?.trim()) {
    const range = parseUpdatedFilter(opts.updated, now);
    if (range) updated = range;
    else warnings.push(`Unrecognised updated value ignored: ${opts.updated}`);
  }
  return {
    author: authors(explicitAuthors.length ? explicitAuthors : (parsed.filters.author ?? [])),
    // The parser has already canonicalized `is:` values and warned about the rest.
    is: explicitIs.length ? [...new Set(explicitIs)] : ((parsed.filters.is ?? []) as IsFilterValue[]),
    updated,
    not: {
      author: authors(parsed.excludedFilters.author ?? []),
      is: (parsed.excludedFilters.is ?? []) as IsFilterValue[],
    },
  };
}

function filterList(value: FilterInput | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Draft-only searches are only valid after the caller authorizes draft
 * visibility. Without this guard, non-admin REST/MCP callers could request
 * status=draft and bypass the normal published-only visibility filter. A
 * non-admin with a viewer_id may still see their *own* drafts (the visibility
 * predicate scopes drafts to owner_id), so only anonymous calls short-circuit.
 */
function isForbiddenDraftSearch(r: ResolvedSearch): boolean {
  return r.status === 'draft' && !r.includeDrafts && !r.viewerId;
}

function parseStructuredStatus(value: string | undefined): SearchStatus | undefined {
  return value === 'draft' || value === 'published' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Predicates — built once, used by every pass
// ---------------------------------------------------------------------------

/**
 * Every WHERE clause a row must satisfy, over `alias`: soft-delete, visibility,
 * the taxonomy filters (including exclusions), `since`, text exclusions, and —
 * depending on `text` — the textual match itself.
 *
 *   - `none`: the caller applies the text match itself (the FTS pass MATCHes).
 *   - `fts`: `id IN (fts match)` — what the relevance pass
 *     returns, used for the count and the facets.
 *   - `like`: the browse pass's title/slug filter.
 */
function rowPredicates(alias: string, r: ResolvedSearch, opts: { text: 'none' | 'fts' | 'like' }): RawBuilder<boolean>[] {
  const a = sql.raw(alias);
  const predicates: RawBuilder<boolean>[] = [sql<boolean>`${a}.deleted_at IS NULL`];

  // Explicit status narrowing chosen by the caller.
  if (r.status) predicates.push(sql<boolean>`${a}.status = ${r.status}`);
  // Visibility: unrestricted callers (includeDrafts) see all statuses; a
  // non-admin sees published pages plus their own drafts (parity with
  // PagesService.list); an anonymous/trusted-less caller sees published only.
  if (!r.includeDrafts) {
    predicates.push(
      r.viewerId
        ? sql<boolean>`(${a}.status = 'published' OR ${a}.owner_id = ${r.viewerId})`
        : sql<boolean>`${a}.status = 'published'`,
    );
  }
  // Space gate (anonymous only): private spaces are not searchable anonymously.
  // Mirrors PagesService.isSpaceVisibleTo / list.
  if (r.anonymous) {
    predicates.push(sql<boolean>`(${a}.space_id IS NULL OR EXISTS (
      SELECT 1 FROM spaces s WHERE s.id = ${a}.space_id AND s.visibility <> 'private'
    ))`);
  }
  if (r.since) predicates.push(sql<boolean>`${a}.updated_at >= ${r.since}`);
  predicates.push(...itemPredicates(a, r));

  for (const axis of AXES) {
    const wanted = r.filters[axis];
    if (wanted.length) predicates.push(axisSql(a, axis, wanted));
    const unwanted = r.filters.not[axis];
    if (unwanted.length) predicates.push(sql<boolean>`NOT ${axisSql(a, axis, unwanted)}`);
  }

  const excluded = ftsExcludeExpr(r.parsed);
  if (excluded) {
    predicates.push(sql<boolean>`${a}.id NOT IN (SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${excluded})`);
  }

  if (opts.text === 'like' && r.q?.trim()) {
    const like = `%${r.q.trim()}%`;
    predicates.push(sql<boolean>`(${a}.title LIKE ${like} OR ${a}.slug LIKE ${like})`);
  }
  if (opts.text === 'fts' && r.q?.trim()) {
    // The same MATCH the relevance pass runs, and nothing else: FTS5 ANDs the
    // query's terms within one row, and that row carries every field a term may
    // be satisfied by (title, aliases, tags, Topic, categories, groups,
    // description, body). A second "or it matched some taxonomy name" route
    // here is exactly what once let `marker alpha` return an item that only
    // said `alpha`, in its Topic name.
    predicates.push(sql<boolean>`${a}.id IN (SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${ftsMatchExpr(r.parsed)})`);
  }

  return predicates;
}

/**
 * `author:`, `is:` and `updated:` as SQL, meaning exactly what
 * `filter-semantics.ts` means (the conformance suite holds the two together).
 * Every clause is NULL-safe (`IFNULL(…, 0)`), so a negation keeps a row whose
 * column is empty instead of dropping it on a NULL comparison. None of these
 * touches visibility: `is:draft` narrows what the viewer may already see.
 */
function itemPredicates(a: RawBuilder<unknown>, r: ResolvedSearch): RawBuilder<boolean>[] {
  const { items } = r;
  const out: RawBuilder<boolean>[] = [];
  const anyIs = (values: IsFilterValue[]) => sql<boolean>`(${sql.join(values.map((value) => isSql(a, value, r.now)), sql` OR `)})`;
  if (items.author.length) out.push(authorSql(a, items.author));
  if (items.not.author.length) out.push(sql<boolean>`NOT ${authorSql(a, items.not.author)}`);
  if (items.is.length) out.push(anyIs(items.is));
  if (items.not.is.length) out.push(sql<boolean>`NOT ${anyIs(items.not.is)}`);
  // Instants, not strings: `updated_at` is stored with and without milliseconds,
  // and `…T10:00:00Z` sorts after `…T10:00:00.000Z` as text though it is the
  // same moment. `after` is inclusive and `before` exclusive.
  if (items.updated?.after) out.push(sql<boolean>`IFNULL(julianday(${a}.updated_at) >= julianday(${items.updated.after}), 0)`);
  if (items.updated?.before) out.push(sql<boolean>`IFNULL(julianday(${a}.updated_at) < julianday(${items.updated.before}), 0)`);
  return out;
}

/**
 * Author names are compared in their stored `normalizeAuthor` form — folded in
 * JavaScript on both sides, never with SQLite's ASCII-only `lower()` — through
 * `page_authors`, an indexed lookup rather than a JSON scan of every version.
 */
function authorSql(a: RawBuilder<unknown>, normalized: string[]): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM page_authors pa WHERE pa.page_id = ${a}.id AND pa.author IN (${sql.join(normalized)}))`;
}

const VERIFIED_TIER_SQL = sql`('human-reviewed', 'machine-confirmed')`;

/** One `is:` value over the indexed lifecycle columns. */
function isSql(a: RawBuilder<unknown>, value: IsFilterValue, now: Date): RawBuilder<boolean> {
  switch (value) {
    case 'verified':
      return sql<boolean>`IFNULL(${a}.trust_tier IN ${VERIFIED_TIER_SQL}, 0)`;
    case 'unverified':
      // No recorded tier is unverified too: nobody has vouched for it.
      return sql<boolean>`NOT IFNULL(${a}.trust_tier IN ${VERIFIED_TIER_SQL}, 0)`;
    case 'human-reviewed':
    case 'machine-confirmed':
      return sql<boolean>`IFNULL(${a}.trust_tier = ${value}, 0)`;
    case 'needs-review':
      // The staleness rule `lifecycleSignals` derives `stale` (and the
      // `needs-review` display state) from: at or past `stale_after`.
      return sql<boolean>`IFNULL(julianday(${a}.stale_after) <= julianday(${now.toISOString()}), 0)`;
    case 'draft':
    case 'published':
      return sql<boolean>`${a}.status = ${value}`;
  }
}

const AXES = ['space', 'tag', 'category', 'group', 'type'] as const;
type Axis = (typeof AXES)[number];

/**
 * The same query with one axis's narrowing lifted — what a facet on that axis
 * has to be counted over. Exclusions stay: `-tag:legacy` is a rule about the
 * whole search, not a narrowing the chips offer to undo.
 */
function withoutAxis(r: ResolvedSearch, axis: Axis | 'status' | 'trust'): ResolvedSearch {
  // `is:` spans two chip groups: its publication values belong to the Status
  // chips and its tier values to the Trust chips, so each lifts only its own.
  const liftIs = (lifted: readonly IsFilterValue[]) => ({ ...r.items, is: r.items.is.filter((value) => !lifted.includes(value)) });
  if (axis === 'status') {
    const { status: _status, ...rest } = r;
    return { ...rest, items: liftIs(['draft', 'published']) };
  }
  if (axis === 'trust') return { ...r, items: liftIs(['verified', 'unverified', 'human-reviewed', 'machine-confirmed']) };
  return { ...r, filters: { ...r.filters, [axis]: [] } };
}

/**
 * One taxonomy axis as SQL: values OR within the axis, matched
 * case-insensitively so `type:runbook` finds `Runbook` — the same rule
 * `InMemorySearchProvider` applies, which is what the conformance suite checks.
 */
function axisSql(alias: RawBuilder<unknown>, axis: Axis, values: string[]): RawBuilder<boolean> {
  const list = inList(values);
  switch (axis) {
    case 'space':
      return sql<boolean>`EXISTS (SELECT 1 FROM spaces s WHERE s.id = ${alias}.space_id
        AND (lower(s.id) IN ${list} OR lower(s.slug) IN ${list} OR lower(s.name) IN ${list}))`;
    case 'tag':
      return sql<boolean>`EXISTS (SELECT 1 FROM page_tags pt WHERE pt.page_id = ${alias}.id AND lower(pt.tag) IN ${list})`;
    case 'category':
      return sql<boolean>`EXISTS (SELECT 1 FROM page_categories pc WHERE pc.page_id = ${alias}.id AND lower(pc.category) IN ${list})`;
    case 'group':
      return sql<boolean>`EXISTS (SELECT 1 FROM page_groups pg INNER JOIN groups g ON g.id = pg.group_id
        WHERE pg.page_id = ${alias}.id AND (lower(g.id) IN ${list} OR lower(g.slug) IN ${list} OR lower(g.name) IN ${list}))`;
    case 'type':
      // NULL-safe on purpose: an untyped page is not `type:Runbook`, and
      // `-type:Runbook` must keep it rather than drop it on a NULL comparison.
      return sql<boolean>`(${alias}.type IS NOT NULL AND lower(${alias}.type) IN ${list})`;
  }
}

function inList(values: string[]): RawBuilder<unknown> {
  return sql`(${sql.join(values.map((value) => sql`${value.toLowerCase()}`))})`;
}

/*
 * There is deliberately no taxonomy "safety net" beside the FTS match any more.
 *
 * It existed because Topic, category and group names were not FTS columns, so
 * a word found only there needed a second route: a token-boundary LIKE over
 * the taxonomy tables, ORed with the FTS match. That second route was ORed per
 * TERM as well as per query, so a two-word query was satisfied by an item
 * whose Topic name held just one of the words (`scopemark… alpha` returned
 * "Alpha Sort Anchor", which never says the marker) — and since it fed `total`
 * and the facets, the counts were wrong too.
 *
 * Since R3.3 those names are FTS columns (`search/fts-index.ts`), reindexed on
 * every write and rename, so FTS5's own implicit AND — every term somewhere in
 * the item's one row — is the whole rule. What the net matched and FTS does
 * not is only a Topic's slug after a rename, which should not find the item
 * anyway. The conformance and eval suites stayed at 1.0 without it.
 */

// ---------------------------------------------------------------------------
// FTS expressions
// ---------------------------------------------------------------------------

/**
 * A safe FTS5 match expression. Tokens are quoted so FTS5 operators (`OR`,
 * `NEAR`, `:`) in user text cannot change the query's shape; the trailing term
 * gets FTS5's prefix marker so a half-typed word still finds pages, which is
 * what turns ⌘K from a lookup into a type-ahead.
 */
export function ftsMatchExpr(parsed: ParsedSearchQuery): string {
  const phrases = parsed.phrases.map(ftsQuote);
  const terms = parsed.terms.map((term, index) => {
    const isTrailing = index === parsed.terms.length - 1 && parsed.prefixTerm === term;
    return isTrailing ? `${ftsQuote(term)}*` : ftsQuote(term);
  });
  const tokens = [...phrases, ...terms];
  if (!tokens.length) return '""';
  return tokens.join(' ');
}

/** The `-term` / `-"phrase"` side of the query, as an FTS5 expression, or null. */
export function ftsExcludeExpr(parsed: ParsedSearchQuery): string | null {
  const tokens = [...parsed.excludedPhrases, ...parsed.excludedTerms].filter(Boolean).map(ftsQuote);
  if (!tokens.length) return null;
  return tokens.join(' OR ');
}

function ftsQuote(token: string): string {
  return '"' + token.replace(/"/g, '""') + '"';
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function withStableReferences(hit: SearchHit): SearchHit {
  return {
    ...hit,
    path: `/items/${hit.id}`,
    url: `/p/${hit.slug}`,
  };
}

function parseFrontmatter(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function matchedFields(query: string | undefined, hit: SearchHit, meta: PageMetadata): string[] {
  if (!query) return [];
  const parsed = parseSearchQuery(query);
  const terms = parsed.terms.map(normalize).filter(Boolean);
  const phrases = parsed.phrases.map(normalize).filter(Boolean);
  const fields: string[] = [];

  if (containsPhrase(hit.title, phrases) || containsAnyTerm(hit.title, terms)) fields.push('title');
  if (containsPhrase(hit.slug, phrases) || containsAnyTerm(hit.slug, terms)) fields.push('slug');
  if (meta.aliases.some((alias) => containsPhrase(alias, phrases) || containsAnyTerm(alias, terms))) fields.push('aliases');
  if (meta.description && (containsPhrase(meta.description, phrases) || containsAnyTerm(meta.description, terms))) fields.push('description');
  if (containsPhrase(meta.body, phrases) || containsAnyTerm(meta.body, terms)) fields.push('body');
  if (meta.topic && (containsPhrase(meta.topic, phrases) || containsAnyTerm(meta.topic, terms))) fields.push('topic');
  if (meta.tags.some((tag) => containsPhrase(tag, phrases) || containsAnyTerm(tag, terms))) fields.push('tags');
  if (meta.categories.some((category) => containsPhrase(category, phrases) || containsAnyTerm(category, terms))) fields.push('categories');
  if (meta.groups.some((group) => containsPhrase(group, phrases) || containsAnyTerm(group, terms))) fields.push('groups');
  return fields;
}

function reasonsFor(query: string | undefined, fields: string[], meta: PageMetadata, hit: SearchHit, r?: ResolvedSearch): string[] {
  const reasons: string[] = [];
  if (query) {
    const parsed = parseSearchQuery(query);
    const terms = parsed.terms.map(normalize).filter(Boolean);
    const phrases = parsed.phrases.map(normalize).filter(Boolean);
    if (fields.includes('title')) reasons.push('Title match');
    for (const alias of meta.aliases.filter((alias) => containsAnyTermOrPhrase(alias, terms, phrases))) reasons.push(`Alias: ${alias}`);
    if (fields.includes('body')) reasons.push('Body match');
    if (fields.includes('topic') && meta.topic) reasons.push(`Topic: ${meta.topic}`);
    for (const tag of meta.tags.filter((tag) => containsAnyTermOrPhrase(tag, terms, phrases))) reasons.push(`Tag: ${tag}`);
    for (const category of meta.categories.filter((category) => containsAnyTermOrPhrase(category, terms, phrases))) reasons.push(`Category: ${category}`);
    for (const group of meta.groups.filter((group) => containsAnyTermOrPhrase(group, terms, phrases))) reasons.push(`Group: ${group}`);
  }
  if (r?.status === hit.status) reasons.push(`Status: ${hit.status === 'draft' ? 'Draft' : 'Published'}`);
  if (isRecentlyUpdated(hit.updated_at)) reasons.push('Recently updated');
  return [...new Set(reasons)];
}

/** The parsed query's free text as the excerpt module wants it, or null for a filter-only query. */
function matchOf(parsed: ParsedSearchQuery): ExcerptMatch | null {
  if (!hasTextSignal(parsed)) return null;
  return { terms: parsed.terms, phrases: parsed.phrases, prefixTerm: parsed.prefixTerm };
}

/** How long a result row's snippet may be; the library's default, stated once. */
const SNIPPET_CHARS = DEFAULT_EXCERPT_CHARS;

/**
 * A hit's snippet, its truncation, and where the query matched in it and in
 * the title. Every match here is `packages/search`'s excerpt module — lexical,
 * case- and accent-insensitive, never stemmed — so a highlight marks text that
 * literally matched, and the client never re-runs matching.
 */
function presentationFor(match: ExcerptMatch | null, title: string, meta: PageMetadata): Pick<SearchHit, 'snippet' | 'snippet_truncated' | 'highlights'> {
  const snip = snippetFor(match, meta);
  const titleRanges = match ? highlightRanges(title, match) : [];
  const highlights: SearchHighlights = {
    ...(titleRanges.length ? { title: titleRanges } : {}),
    ...(snip?.highlights.length ? { snippet: snip.highlights } : {}),
  };
  return {
    ...(snip ? { snippet: snip.text, snippet_truncated: { start: snip.truncatedStart, end: snip.truncatedEnd } } : {}),
    ...(highlights.title || highlights.snippet ? { highlights } : {}),
  };
}

/**
 * The best excerpt, in order: where the query matched the body (Markdown
 * reduced to prose FIRST, then cut, so no `[[…` fragments), then the
 * description, then the taxonomy line. When nothing literally matches — a
 * filter-only query, or FTS matched through Porter stemming (`renew` →
 * `renewing`) or an alias — the description, else the start of the body,
 * unhighlighted: a missing highlight is honest, a guessed one is not.
 */
function snippetFor(match: ExcerptMatch | null, meta: PageMetadata): ExcerptResult | null {
  const body = plainTextForExcerpt(meta.body);
  if (match) {
    for (const source of [body, meta.description, taxonomySummary(meta)]) {
      const found = source ? excerpt(source, match, { maxChars: SNIPPET_CHARS }) : null;
      if (found) return found;
    }
  }
  const lead = meta.description || body;
  return lead ? leadOf(lead, SNIPPET_CHARS) : null;
}

/** The item's taxonomy as one readable line, so a taxonomy-only match still shows why it matched. */
function taxonomySummary(meta: PageMetadata): string {
  return [
    meta.aliases.length ? `Also known as: ${meta.aliases.join(', ')}` : undefined,
    meta.topic ? `Topic: ${meta.topic}` : undefined,
    meta.tags.length ? `Tags: ${meta.tags.join(', ')}` : undefined,
    meta.categories.length ? `Categories: ${meta.categories.join(', ')}` : undefined,
    meta.groups.length ? `Groups: ${meta.groups.join(', ')}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function emptyFacets(): SearchFacets {
  return { topics: [], statuses: [], tags: [], types: [], categories: [], trust_tiers: [] };
}

/** A SQL `GROUP BY` result as facet values: counted, labelled, sorted, capped. */
function facetFrom(
  rows: { value: string | null; count: number }[],
  active: string[],
  labelFor: (value: string) => string = (value) => value,
  cap: number = MAX_FACET_VALUES,
): SearchFacetValue[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const trimmed = (row.value ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? labelFor(trimmed), count: (current?.count ?? 0) + Number(row.count) });
  }
  const activeValues = active.map((value) => value.toLowerCase().trim()).filter(Boolean);
  return [...counts.entries()]
    .map(([value, entry]) => ({
      value,
      label: entry.label,
      count: entry.count,
      active: activeValues.length ? activeValues.some((candidate) => facetMatchesActive(candidate, value, entry.label)) : undefined,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .slice(0, cap);
}

function trustTierLabel(tier: string): string {
  if (tier === 'human-reviewed') return 'Human-reviewed';
  if (tier === 'machine-confirmed') return 'Machine-confirmed';
  return 'Unverified';
}

function facetMatchesActive(active: string, value: string, label: string): boolean {
  const candidates = [value, label].flatMap((candidate) => [candidate.toLowerCase(), slugifyFacet(candidate)]);
  return candidates.includes(active) || candidates.includes(slugifyFacet(active));
}

function slugifyFacet(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function emptyStateFor(r: ResolvedSearch): SearchEmptyState {
  const hasQuery = Boolean(r.q?.trim());
  const activeFilters = [
    r.filters.space.length ? 'Topic' : null,
    r.status ? 'Status' : null,
    r.filters.tag.length ? 'Tag' : null,
    r.filters.category.length ? 'Category' : null,
    r.filters.group.length ? 'Group' : null,
    r.filters.type.length ? 'Type' : null,
    r.items.author.length || r.items.not.author.length ? 'Author' : null,
    r.items.is.length || r.items.not.is.length ? 'Is' : null,
    r.items.updated ? 'Updated' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    title: hasQuery ? `No matches for “${r.q!.trim()}”` : 'No items match the current filters',
    guidance: [
      activeFilters ? `Relax these filters and try again: ${activeFilters}.` : 'Try a broader term, a related acronym, or a tag/topic name.',
      'Search checks titles, aliases, descriptions, body text, tags, categories, groups, Topic, status filters, and recently updated notes.',
      'If this should exist, create an item from the search so the wording is captured for next time.',
    ],
    can_create_from_search: hasQuery,
  };
}

function isRecentlyUpdated(updatedAt: string): boolean {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return ageMs >= 0 && ageMs <= 1000 * 60 * 60 * 24 * 30;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function containsAnyTerm(value: string, terms: string[]): boolean {
  const tokens = tokenize(value);
  const lowerValue = value.toLowerCase();
  return terms.some((term) => {
    if (!term) return false;
    return lowerValue.includes(term) || tokens.includes(term);
  });
}

function containsPhrase(value: string, phrases: string[]): boolean {
  const lowerValue = value.toLowerCase();
  return phrases.some((phrase) => lowerValue.includes(phrase));
}

function containsAnyTermOrPhrase(value: string, terms: string[], phrases: string[]): boolean {
  return containsAnyTerm(value, terms) || containsPhrase(value, phrases);
}
