/**
 * Search service.
 *
 * SQLite dev/test uses pages_fts for relevance queries and direct pages queries
 * for browse/sort modes. REST and MCP call this same service so filter parity is
 * enforced in one place.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { FtsRecencyRanker, Ranker, RankedResult } from './ranker.js';
import { parseSearchQuery } from './query-parser.js';

export type SortMode = 'relevance' | 'newest' | 'oldest' | 'az';
export type SearchStatus = 'draft' | 'published';

export interface SearchOptions {
  q?: string;
  space?: string;
  tag?: string;
  category?: string;
  group?: string;
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
  snippet?: string;
  topic?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  matched_fields?: string[];
  reasons?: string[];
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
}

export interface SearchEmptyState {
  title: string;
  guidance: string[];
  can_create_from_search: boolean;
}

export interface SearchResultSet {
  results: SearchHit[];
  total: number;
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
  frontmatter: Record<string, unknown>;
  topic?: string;
  type?: string | null;
  tags: string[];
  categories: string[];
  groups: string[];
}

type EffectiveSearchOptions = SearchOptions & { warnings: string[] };

@Injectable()
export class SearchService {
  private readonly ranker: Ranker = new FtsRecencyRanker();

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async searchWithContext(opts: SearchOptions): Promise<SearchResultSet> {
    const effectiveOpts = applyStructuredQueryFilters(opts);
    const results = await this.search(effectiveOpts);
    return {
      results,
      total: results.length,
      facets: facetsFor(results, effectiveOpts),
      warnings: effectiveOpts.warnings,
      empty_state: results.length ? undefined : emptyStateFor(effectiveOpts),
    };
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const effectiveOpts = applyStructuredQueryFilters(opts);
    const limit = Math.min(Math.max(effectiveOpts.limit ?? 25, 1), 100);
    const sort: SortMode = effectiveOpts.sort ?? 'relevance';
    const includeDrafts = !!effectiveOpts.include_drafts;

    // Draft-only searches are only valid after the caller authorizes draft visibility.
    // Without this guard, non-admin REST/MCP callers could request status=draft and
    // bypass the normal published-only visibility filter. A non-admin with a
    // viewer_id may still see their *own* drafts (the visibility filter scopes
    // the draft results to owner_id below), so only short-circuit anonymous calls.
    if (effectiveOpts.status === 'draft' && !includeDrafts && !effectiveOpts.viewer_id) return [];

    if (!effectiveOpts.q || !effectiveOpts.q.trim() || sort !== 'relevance') {
      return this.directList({ ...effectiveOpts, limit, sort, includeDrafts });
    }
    return this.ftsSearch({ ...effectiveOpts, limit, includeDrafts });
  }

  private async directList(opts: SearchOptions & { limit: number; sort: SortMode; includeDrafts: boolean }): Promise<SearchHit[]> {
    let q = this.db
      .selectFrom('pages')
      .select(['id', 'slug', 'title', 'updated_at', 'status'])
      .where('deleted_at', 'is', null);
    q = applyCommonFilters(q, opts);
    if (opts.q && opts.q.trim()) {
      const searchStr = `%${opts.q.trim()}%`;
      q = q.where((eb) => eb.or([eb('pages.title', 'like', searchStr), eb('pages.slug', 'like', searchStr)]));
    }
    if (opts.sort === 'newest') q = q.orderBy('updated_at', 'desc');
    else if (opts.sort === 'oldest') q = q.orderBy('updated_at', 'asc');
    else if (opts.sort === 'az') q = q.orderBy('title', 'asc');
    else q = q.orderBy('updated_at', 'desc');
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const rows = await q.limit(opts.limit).offset(offset).execute();
    return this.enrichHits(rows.map((r) => ({ ...r, score: 0 })), opts.q, undefined, opts);
  }

  private async ftsSearch(opts: SearchOptions & { limit: number; includeDrafts: boolean }): Promise<SearchHit[]> {
    const query = opts.q!.trim();
    const parsedQuery = parseSearchQuery(query);
    const matchExpr = ftsMatchExprFromParsed(parsedQuery);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const candidateLimit = Math.min(Math.max((offset + opts.limit) * 5, 50), 400);
    const rows = await sql<RawSearchRow>`
      SELECT
        p.id AS page_id,
        p.slug AS slug,
        p.title AS title,
        p.updated_at AS updated_at,
        p.status AS status,
        bm25(pages_fts) AS bm25
      FROM pages_fts
      INNER JOIN pages p ON p.id = pages_fts.page_id
      WHERE pages_fts MATCH ${matchExpr}
        AND p.deleted_at IS NULL
        ${visibilitySql(opts)}
        ${opts.since ? sql`AND p.updated_at >= ${opts.since}` : sql``}
        ${opts.space
          ? sql`AND EXISTS (SELECT 1 FROM spaces s WHERE s.id = p.space_id AND (s.id = ${opts.space} OR s.slug = ${opts.space} OR s.name = ${opts.space}))`
          : sql``}
        ${opts.tag
          ? sql`AND EXISTS (SELECT 1 FROM page_tags pt WHERE pt.page_id = p.id AND pt.tag = ${opts.tag})`
          : sql``}
        ${opts.category
          ? sql`AND EXISTS (SELECT 1 FROM page_categories pc WHERE pc.page_id = p.id AND pc.category = ${opts.category})`
          : sql``}
        ${opts.group
          ? sql`AND EXISTS (SELECT 1 FROM page_groups pg INNER JOIN groups g ON g.id = pg.group_id WHERE pg.page_id = p.id AND (g.id = ${opts.group} OR g.slug = ${opts.group} OR g.name = ${opts.group}))`
          : sql``}
      ORDER BY bm25 ASC
      LIMIT ${candidateLimit}
    `.execute(this.db);

    const candidates = rows.rows.map((r) => ({
      id: r.page_id,
      slug: r.slug,
      title: r.title,
      updated_at: r.updated_at,
      fts_rank: 1 / (1 + Math.max(0, r.bm25)),
      status: r.status,
    }));

    const metadata = await this.metadataForPages(candidates.map((candidate) => candidate.id));
    const enrichedCandidates = candidates.map((candidate) => {
      const meta = metadata.get(candidate.id);
      return {
        ...candidate,
        body: meta?.body,
        topic: meta?.topic,
        tags: meta?.tags,
        categories: meta?.categories,
        groups: meta?.groups,
      };
    });

    const ranked: RankedResult[] = this.ranker.score(query, enrichedCandidates);
    const hits: SearchHit[] = ranked.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      updated_at: r.updated_at,
      status: (r as unknown as { status: SearchStatus }).status,
      score: r.score,
    }));

    if (hits.length < offset + opts.limit) {
      const taxonomyHits = await this.taxonomyMatches(opts, new Set(hits.map((hit) => hit.id)), offset + opts.limit - hits.length);
      hits.push(...taxonomyHits);
    }

    return this.enrichHits(hits.slice(offset, offset + opts.limit), query, metadata, opts);
  }

  private async taxonomyMatches(
    opts: SearchOptions & { limit: number; includeDrafts: boolean },
    excludeIds: Set<string>,
    limit: number,
  ): Promise<SearchHit[]> {
    if (limit <= 0 || !opts.q?.trim()) return [];
    const parsed = parseSearchQuery(opts.q.trim());
    const searchTerms = [...parsed.terms, ...parsed.phrases].filter(Boolean);
    const likeTerms = searchTerms.map((term) => `%${term}%`);
    if (!likeTerms.length) return [];

    let q = this.db
      .selectFrom('pages')
      .select(['pages.id', 'pages.slug', 'pages.title', 'pages.updated_at', 'pages.status'])
      .where('pages.deleted_at', 'is', null)
      .where((eb: any) =>
        eb.or(
          likeTerms.flatMap((likeTerm) => [
            eb.exists(eb.selectFrom('page_tags').select('page_id').whereRef('page_tags.page_id', '=', 'pages.id').where('page_tags.tag', 'like', likeTerm)),
            eb.exists(
              eb
                .selectFrom('page_categories')
                .select('page_id')
                .whereRef('page_categories.page_id', '=', 'pages.id')
                .where('page_categories.category', 'like', likeTerm),
            ),
            eb.exists(
              eb
                .selectFrom('page_groups')
                .innerJoin('groups', 'groups.id', 'page_groups.group_id')
                .select('page_groups.page_id')
                .whereRef('page_groups.page_id', '=', 'pages.id')
                .where((groupEb: any) => groupEb.or([groupEb('groups.slug', 'like', likeTerm), groupEb('groups.name', 'like', likeTerm)])),
            ),
            eb.exists(
              eb
                .selectFrom('spaces')
                .select('id')
                .whereRef('spaces.id', '=', 'pages.space_id')
                .where((spaceEb: any) => spaceEb.or([spaceEb('spaces.slug', 'like', likeTerm), spaceEb('spaces.name', 'like', likeTerm)])),
            ),
          ]),
        ),
      );
    q = applyCommonFilters(q, opts);
    if (excludeIds.size) q = q.where('pages.id', 'not in', [...excludeIds]);
    const rows = await q.orderBy('pages.updated_at', 'desc').limit(limit).execute();
    return rows.map((r) => ({ ...r, score: 0.5 }));
  }


  private async enrichHits(hits: SearchHit[], query?: string, preloadedMetadata?: Map<string, PageMetadata>, opts?: SearchOptions): Promise<SearchHit[]> {
    if (!hits.length) return hits;
    const metadata = new Map(preloadedMetadata ?? []);
    const missingIds = hits.map((hit) => hit.id).filter((id) => !metadata.has(id));
    if (missingIds.length) {
      const missingMetadata = await this.metadataForPages(missingIds);
      for (const [pageId, meta] of missingMetadata) metadata.set(pageId, meta);
    }
    return hits.map((hit) => {
      const canonical = withStableReferences(hit);
      const meta = metadata.get(hit.id);
      if (!meta) return canonical;
      const matched = query ? matchedFields(query, hit, meta) : [];
      return {
        ...canonical,
        type: meta.type ?? null,
        topic: meta.topic,
        tags: meta.tags,
        categories: meta.categories,
        groups: meta.groups,
        snippet: snippetFor(query, meta.body, hit.title, meta.frontmatter, meta),
        matched_fields: matched,
        reasons: reasonsFor(query, matched, meta, canonical, opts),
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
          .select(['page_versions.body_markdown', 'page_versions.frontmatter_json', 'spaces.name as space_name', 'pages.type as type'])
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
          frontmatter,
          topic,
          type: row?.type ?? null,
          tags: tags.map((r) => r.tag),
          categories: categories.map((r) => r.category),
          groups: groupRows.map((r) => r.slug),
        });
      }),
    );
    return result;
  }
}

function applyStructuredQueryFilters(opts: SearchOptions): EffectiveSearchOptions {
  const parsed = parseSearchQuery(opts.q ?? '');
  const q = freeTextFromParsed(parsed);
  return {
    ...opts,
    q,
    tag: opts.tag ?? firstFilter(parsed.filters.tag),
    category: opts.category ?? firstFilter(parsed.filters.category),
    group: opts.group ?? firstFilter(parsed.filters.group),
    space: opts.space ?? firstFilter(parsed.filters.space) ?? firstFilter(parsed.filters.topic),
    status: opts.status ?? parseStructuredStatus(firstFilter(parsed.filters.status)),
    warnings: parsed.warnings,
  };
}

function firstFilter(values: string[] | undefined): string | undefined {
  return values?.find((value) => value.trim().length > 0)?.trim();
}

function parseStructuredStatus(value: string | undefined): SearchStatus | undefined {
  return value === 'draft' || value === 'published' ? value : undefined;
}

function freeTextFromParsed(parsed: ReturnType<typeof parseSearchQuery>): string | undefined {
  const parts = [...parsed.phrases.map((phrase) => `"${phrase}"`), ...parsed.terms];
  return parts.length ? parts.join(' ') : undefined;
}

function withStableReferences(hit: SearchHit): SearchHit {
  return {
    ...hit,
    path: `/items/${hit.id}`,
    url: `/p/${hit.slug}`,
  };
}

function applyCommonFilters<T extends { where: (a: unknown, b?: unknown, c?: unknown) => T }>(q: T, opts: SearchOptions & { includeDrafts: boolean }): T {
  // Explicit status narrowing chosen by the caller.
  if (opts.status) q = q.where('status', '=', opts.status);
  // Visibility: unrestricted callers (includeDrafts) see all statuses; a
  // non-admin sees published pages plus their own drafts (parity with
  // PagesService.list); an anonymous/trusted-less caller sees published only.
  if (!opts.includeDrafts) {
    if (opts.viewer_id) {
      const viewerId = opts.viewer_id;
      q = q.where((eb: any) => eb.or([eb('status', '=', 'published'), eb('owner_id', '=', viewerId)]));
    } else {
      q = q.where('status', '=', 'published');
    }
  }
  if (opts.since) q = q.where('updated_at', '>=', opts.since);
  if (opts.space) {
    q = q.where((eb: any) =>
      eb.exists(
        eb
          .selectFrom('spaces')
          .select('id')
          .whereRef('spaces.id', '=', 'pages.space_id')
          .where((spaceEb: any) => spaceEb.or([spaceEb('spaces.id', '=', opts.space!), spaceEb('spaces.slug', '=', opts.space!), spaceEb('spaces.name', '=', opts.space!)])),
      ),
    );
  }
  if (opts.tag) {
    q = q.where((eb: any) =>
      eb.exists(
        eb
          .selectFrom('page_tags')
          .select('page_id')
          .whereRef('page_tags.page_id', '=', 'pages.id')
          .where('page_tags.tag', '=', opts.tag!),
      ),
    );
  }
  if (opts.category) {
    q = q.where((eb: any) =>
      eb.exists(
        eb
          .selectFrom('page_categories')
          .select('page_id')
          .whereRef('page_categories.page_id', '=', 'pages.id')
          .where('page_categories.category', '=', opts.category!),
      ),
    );
  }
  if (opts.group) {
    q = q.where((eb: any) =>
      eb.exists(
        eb
          .selectFrom('page_groups')
          .innerJoin('groups', 'groups.id', 'page_groups.group_id')
          .select('page_groups.page_id')
          .whereRef('page_groups.page_id', '=', 'pages.id')
          .where((groupEb: any) => groupEb.or([groupEb('groups.id', '=', opts.group!), groupEb('groups.slug', '=', opts.group!), groupEb('groups.name', '=', opts.group!)])),
      ),
    );
  }
  return q;
}

function visibilitySql(opts: SearchOptions & { includeDrafts: boolean }) {
  const statusClause = opts.status ? sql`AND p.status = ${opts.status}` : sql``;
  if (opts.includeDrafts) return statusClause;
  if (opts.viewer_id) {
    return sql`${statusClause} AND (p.status = 'published' OR p.owner_id = ${opts.viewer_id})`;
  }
  return sql`${statusClause} AND p.status = 'published'`;
}

/**
 * Produce a safe FTS5 match expression from parsed query tokens and phrases.
 * Tokens are quoted to avoid FTS5 syntax characters (`OR`, `NEAR`, `:`).
 */
function ftsMatchExprFromParsed(parsed: ReturnType<typeof parseSearchQuery>): string {
  const tokens = [...parsed.phrases, ...parsed.terms].map((tok) => '"' + tok.replace(/"/g, '""') + '"');
  if (!tokens.length) return '""';
  return tokens.join(' ');
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
  if (containsPhrase(meta.body, phrases) || containsAnyTerm(meta.body, terms)) fields.push('body');
  if (meta.topic && (containsPhrase(meta.topic, phrases) || containsAnyTerm(meta.topic, terms))) fields.push('topic');
  if (meta.tags.some((tag) => containsPhrase(tag, phrases) || containsAnyTerm(tag, terms))) fields.push('tags');
  if (meta.categories.some((category) => containsPhrase(category, phrases) || containsAnyTerm(category, terms))) fields.push('categories');
  if (meta.groups.some((group) => containsPhrase(group, phrases) || containsAnyTerm(group, terms))) fields.push('groups');
  return fields;
}

function reasonsFor(query: string | undefined, fields: string[], meta: PageMetadata, hit: SearchHit, opts?: SearchOptions): string[] {
  const reasons: string[] = [];
  if (query) {
    const parsed = parseSearchQuery(query);
    const terms = parsed.terms.map(normalize).filter(Boolean);
    const phrases = parsed.phrases.map(normalize).filter(Boolean);
    if (fields.includes('title')) reasons.push('Title match');
    if (fields.includes('body')) reasons.push('Body match');
    if (fields.includes('topic') && meta.topic) reasons.push(`Topic: ${meta.topic}`);
    for (const tag of meta.tags.filter((tag) => containsAnyTermOrPhrase(tag, terms, phrases))) reasons.push(`Tag: ${tag}`);
    for (const category of meta.categories.filter((category) => containsAnyTermOrPhrase(category, terms, phrases))) reasons.push(`Category: ${category}`);
    for (const group of meta.groups.filter((group) => containsAnyTermOrPhrase(group, terms, phrases))) reasons.push(`Group: ${group}`);
  }
  if (opts?.status === hit.status) reasons.push(`Status: ${hit.status === 'draft' ? 'Draft' : 'Published'}`);
  if (isRecentlyUpdated(hit.updated_at)) reasons.push('Recently updated');
  return [...new Set(reasons)];
}

function snippetFor(query: string | undefined, body: string, title: string, frontmatter: Record<string, unknown>, meta: PageMetadata): string {
  const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary : '';
  if (!query || !body) return summary || title;
  const parsed = parseSearchQuery(query);
  const snippets = [...parsed.phrases, ...parsed.terms].map(normalize).filter(Boolean);
  const lowerBody = body.toLowerCase();
  const snippetTerm = snippets.find((snippet) => lowerBody.includes(snippet.toLowerCase()));
  if (!snippetTerm) {
    const taxonomySnippet = taxonomySnippetFor(snippets, meta);
    return taxonomySnippet || summary || body.slice(0, 160) || title;
  }
  const index = lowerBody.indexOf(snippetTerm.toLowerCase());
  const start = Math.max(0, index - 60);
  const end = Math.min(body.length, index + snippetTerm.length + 100);
  return body.slice(start, end).replace(/\s+/g, ' ').trim();
}

function facetsFor(results: SearchHit[], opts: SearchOptions): SearchFacets {
  return {
    topics: countedFacet(
      results.map((hit) => hit.topic).filter((value): value is string => Boolean(value?.trim())),
      opts.space,
    ),
    statuses: countedFacet(
      results.map((hit) => hit.status),
      opts.status,
      (status) => (status === 'draft' ? 'Draft' : 'Published'),
    ),
    tags: countedFacet(results.flatMap((hit) => hit.tags ?? []), opts.tag),
  };
}

function countedFacet(values: string[], activeValue?: string, labelFor: (value: string) => string = (value) => value): SearchFacetValue[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? labelFor(trimmed), count: (current?.count ?? 0) + 1 });
  }
  const active = activeValue?.toLowerCase().trim();
  return [...counts.entries()]
    .map(([value, entry]) => ({
      value,
      label: entry.label,
      count: entry.count,
      active: active ? facetMatchesActive(active, value, entry.label) : undefined,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .slice(0, 12);
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

function emptyStateFor(opts: SearchOptions): SearchEmptyState {
  const hasQuery = Boolean(opts.q?.trim());
  const activeFilters = [opts.space ? 'Topic' : null, opts.status ? 'Status' : null, opts.tag ? 'Tag' : null, opts.category ? 'Category' : null, opts.group ? 'Group' : null]
    .filter(Boolean)
    .join(', ');
  return {
    title: hasQuery ? `No matches for “${opts.q!.trim()}”` : 'No items match the current filters',
    guidance: [
      activeFilters ? `Relax these filters and try again: ${activeFilters}.` : 'Try a broader term, a related acronym, or a tag/topic name.',
      'Search checks titles, body text, tags, categories, groups, Topic, status filters, and recently updated notes.',
      'If this should exist, create an item from the search so the wording is captured for next time.',
    ],
    can_create_from_search: hasQuery,
  };
}

function taxonomySnippetFor(snippets: string[], meta: PageMetadata): string | undefined {
  if (!snippets.length) return undefined;
  const parts = [
    meta.topic ? `Topic: ${meta.topic}` : undefined,
    meta.tags.length ? `Tags: ${meta.tags.join(', ')}` : undefined,
    meta.categories.length ? `Categories: ${meta.categories.join(', ')}` : undefined,
    meta.groups.length ? `Groups: ${meta.groups.join(', ')}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const summary = parts.join(' · ');
  return snippets.some((snippet) => summary.toLowerCase().includes(snippet)) ? summary : undefined;
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
