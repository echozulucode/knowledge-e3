/**
 * The in-memory keyword index for ONE local source.
 *
 * Matching and ranking are `@echozedlabs/search`'s `InMemorySearchProvider` —
 * the reference provider the server's conformance suite holds to the same query
 * language as the server's FTS search (implicit AND, `tag:`/`type:`/`topic:`
 * filters OR within a key and AND across keys, `-term` and `-key:value`
 * exclusions, quoted phrases, trailing-word prefix, `author:`, `updated:`,
 * `is:`). Presentation — snippet, highlight ranges, matched fields, reasons,
 * lifecycle demotion and type grouping — follows `server/src/search/search.service.ts`
 * and `KnowledgeQueryService.search`, with the same `@echozedlabs/search`
 * functions.
 *
 * Keyword search only, lexical and unstemmed: a term matches whole tokens (or,
 * while typing, a token prefix), a phrase matches its exact token sequence.
 *
 * Scores are only meaningful inside this index. The backend never compares them
 * with another source's.
 */
import {
  applyLifecyclePolicy,
  DEFAULT_EXCERPT_CHARS,
  excerpt,
  groupHits,
  hasTextSignal,
  highlightRanges,
  InMemorySearchProvider,
  parseSearchQuery,
  plainTextForExcerpt,
  resolveFilters,
  type ExcerptMatch,
  type ExcerptResult,
  type ParsedSearchQuery,
} from '@echozedlabs/search';
import type { SearchDoc, SearchHighlights, SearchHit } from '@echozedlabs/knowledge-types';
import type { SearchToolInput } from '@echozedlabs/mcp-tools';
import { slugify, type LocalItem } from '../sources/concept.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const PROVIDER_PAGE = 100;
const GROUP_CAP = 5;
const MAX_FACET_VALUES = 12;
const RECENT_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * A hit from this index. `source` is the configured source id (a plain string), not
 * `ItemSummary.source` — the server-side canonical-file reference, which a local file does not have.
 */
export interface LocalSearchHit extends Omit<SearchHit, 'source'> {
  source: string;
  /** `<source>:<id>` — hand this to knowledge.get_item. */
  ref: string;
  /** Root-relative path of the file. */
  path: string;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
  active?: boolean;
}

/** One source's answer to `knowledge.search`, in the server's result-set shape. */
export interface LocalSearchResult {
  results: LocalSearchHit[];
  total: number;
  offset: number;
  limit: number;
  facets: {
    topics: FacetValue[];
    statuses: FacetValue[];
    tags: FacetValue[];
    types: FacetValue[];
    categories: FacetValue[];
    trust_tiers: FacetValue[];
  };
  warnings: string[];
  empty_state?: { title: string; guidance: string[]; can_create_from_search: boolean };
  groups: Array<Omit<ReturnType<typeof groupHits>[number], 'hits'> & { hits: LocalSearchHit[] }>;
}

export interface TopicEntry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: null;
  visibility: 'public';
  presentation: string;
  landing_markdown: string | null;
  start_here: string | null;
  color: null;
  icon: null;
  counts: { items: number; published: number; draft: number };
}

export interface TopicPresentation {
  presentation?: string;
  start_here?: string;
  landing_markdown?: string;
}

export interface TaxonomyEntry {
  id: string;
  name: string;
  slug: string;
  count: number;
  color: null;
  icon: null;
  scope: { type: 'global'; space_id: null; space_slug: null };
}

export class LocalIndex {
  private readonly provider: InMemorySearchProvider;
  private readonly byId = new Map<string, LocalItem>();
  readonly items: readonly LocalItem[];
  private readonly ready: Promise<void>;

  constructor(
    readonly sourceId: string,
    items: LocalItem[],
    private readonly presentations: Map<string, TopicPresentation> = new Map(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.provider = new InMemorySearchProvider({ now });
    this.items = items;
    for (const item of items) this.byId.set(item.id, item);
    this.ready = Promise.all(items.map((item) => this.provider.index(toSearchDoc(item)))).then(() => undefined);
  }

  get size(): number {
    return this.items.length;
  }

  async search(input: SearchToolInput): Promise<LocalSearchResult> {
    await this.ready;
    const now = this.now();
    const parsed = parseSearchQuery(input.q ?? '', { now });
    // The server's draft rule (KnowledgeQueryService.search): drafts only when
    // asked for — the flag, a status filter, `status:draft` or `is:draft`. A
    // local reader owns the files, so asking is enough; no role check applies.
    const wantDrafts =
      input.include_drafts ||
      input.status === 'draft' ||
      parsed.filters.status?.[0] === 'draft' ||
      (parsed.filters.is ?? []).some((v) => v.trim().toLowerCase() === 'draft');
    const status = input.status ?? parseStatus(parsed.filters.status?.[0]);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Every match, in the provider's order; the count, the facets and the page all come from this list.
    const all: SearchHit[] = [];
    for (let offset = 0; ; offset += PROVIDER_PAGE) {
      const page = await this.provider.query(
        {
          q: input.q,
          space: input.space,
          tag: input.tag,
          category: input.category,
          group: input.group,
          type: input.type,
          status,
          sort: input.sort,
          include_drafts: wantDrafts,
          limit: PROVIDER_PAGE,
          offset,
        },
        { userId: null, role: 'user' },
      );
      all.push(...page);
      if (page.length < PROVIDER_PAGE) break;
    }

    const ordered = input.sort === 'relevance' ? applyLifecyclePolicy(all) : all;
    const match = matchOf(parsed);
    const pageHits = ordered.slice(0, limit).map((hit) => this.present(hit, parsed, match, status, now));
    const axes = resolveFilters(parsed, { space: input.space, tag: input.tag, category: input.category, group: input.group, type: input.type });
    const matched = ordered.map((hit) => this.byId.get(hit.id)).filter((i): i is LocalItem => Boolean(i));

    return {
      results: pageHits,
      total: ordered.length,
      offset: 0,
      limit,
      facets: {
        topics: facet(matched.map((i) => i.topic_name), axes.space),
        statuses: facet(matched.map((i) => i.status), status ? [status] : [], (s) => (s === 'draft' ? 'Draft' : 'Published')),
        tags: facet(matched.flatMap((i) => i.tags), axes.tag),
        types: facet(matched.map((i) => i.type), axes.type),
        categories: facet(matched.flatMap((i) => i.categories), axes.category),
        trust_tiers: facet(matched.map((i) => i.trust_tier ?? null), [], trustTierLabel),
      },
      warnings: [...parsed.warnings],
      ...(pageHits.length ? {} : { empty_state: emptyStateFor(input, parsed, axes, status) }),
      groups: groupHits(pageHits as unknown as SearchHit[], { capPerGroup: GROUP_CAP }) as unknown as LocalSearchResult['groups'],
    };
  }

  /** Stable id first, then slug — the order the server's get_item resolves in. */
  find(idOrSlug: string): LocalItem | null {
    const byId = this.byId.get(idOrSlug);
    if (byId) return byId;
    return this.items.find((item) => item.slug === idOrSlug) ?? null;
  }

  findByTitle(title: string): LocalItem | null {
    return this.items.find((item) => item.title === title) ?? null;
  }

  topics(): TopicEntry[] {
    const bySlug = new Map<string, TopicEntry>();
    for (const item of this.items) {
      if (!item.space_id || !item.topic_name) continue;
      let entry = bySlug.get(item.space_id);
      if (!entry) {
        const p = this.presentations.get(item.space_id) ?? {};
        entry = {
          id: item.space_id,
          slug: item.space_id,
          name: item.topic_name,
          description: null,
          created_at: item.created_at,
          updated_at: item.updated_at,
          archived_at: null,
          visibility: 'public',
          presentation: p.presentation ?? 'wiki',
          landing_markdown: p.landing_markdown ?? null,
          start_here: p.start_here ?? null,
          color: null,
          icon: null,
          counts: { items: 0, published: 0, draft: 0 },
        };
        bySlug.set(item.space_id, entry);
      }
      entry.counts.items += 1;
      entry.counts[item.status] += 1;
      if (item.created_at < entry.created_at) entry.created_at = item.created_at;
      if (item.updated_at > entry.updated_at) entry.updated_at = item.updated_at;
    }
    return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  taxonomy(): { tags: TaxonomyEntry[]; categories: TaxonomyEntry[]; groups: TaxonomyEntry[] } {
    const count = (values: string[], slugOf: (v: string) => string) => {
      const map = new Map<string, { name: string; count: number }>();
      for (const v of values) {
        const slug = slugOf(v);
        const current = map.get(slug);
        map.set(slug, { name: current?.name ?? v, count: (current?.count ?? 0) + 1 });
      }
      return [...map.entries()]
        .map(([slug, { name, count: n }]): TaxonomyEntry => ({
          id: slug,
          name,
          slug,
          count: n,
          color: null,
          icon: null,
          scope: { type: 'global', space_id: null, space_slug: null },
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    return {
      tags: count(this.items.flatMap((i) => i.tags), (v) => v),
      categories: count(this.items.flatMap((i) => i.categories), (v) => v),
      groups: count(this.items.flatMap((i) => i.groups), slugify),
    };
  }

  /** Known vocabularies and resolvable slugs, for the lint's tag/category/group and wiki-link checks. */
  vocabulary(): { tags: string[]; categories: string[]; groups: string[]; slugs: string[] } {
    const t = this.taxonomy();
    return {
      tags: t.tags.map((e) => e.slug),
      categories: t.categories.map((e) => e.slug),
      groups: t.groups.map((e) => e.slug),
      slugs: this.items.map((i) => i.slug),
    };
  }

  private present(hit: SearchHit, parsed: ParsedSearchQuery, match: ExcerptMatch | null, status: string | undefined, now: Date): LocalSearchHit {
    const item = this.byId.get(hit.id)!;
    const matched = hasTextSignal(parsed) ? matchedFields(parsed, item) : [];
    const signals = {
      display_state: item.display_state,
      lifecycle_status: item.lifecycle_status,
      trust_tier: item.trust_tier,
      stale: item.stale,
      stale_after: item.stale_after,
      last_verified_at: item.last_verified_at,
      generated_by: item.generated_by,
      superseded_by: item.superseded_by,
    };
    const out: LocalSearchHit = {
      source: this.sourceId,
      ref: `${this.sourceId}:${item.id}`,
      id: item.id,
      slug: item.slug,
      title: item.title,
      path: item.file,
      updated_at: item.updated_at,
      published_at: item.published_at ?? null,
      status: item.status,
      type: item.type,
      space_id: item.space_id,
      ...(item.topic_name ? { topic: item.topic_name } : {}),
      description: item.description ?? null,
      score: hit.score,
      ...presentationFor(match, item),
      tags: item.tags,
      categories: item.categories,
      groups: item.groups,
      matched_fields: matched,
      reasons: [...new Set([...reasonsFor(parsed, matched, item, status, now), ...(hit.reasons ?? [])])],
      ...signals,
    };
    return out;
  }
}

/** What the provider indexes: the item, with aliases and taxonomy names folded into the body text so they match. */
function toSearchDoc(item: LocalItem): SearchDoc & { author?: string | null } {
  const extra = [...item.aliases, item.topic_name ?? '', ...item.categories, ...item.groups].filter(Boolean).join(' ');
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    status: item.status,
    type: item.type,
    space_id: item.space_id,
    ...(item.topic_name ? { topic: item.topic_name } : {}),
    description: item.description ?? null,
    updated_at: item.updated_at,
    published_at: item.published_at ?? null,
    tags: item.tags,
    categories: item.categories,
    groups: item.groups,
    authors: item.authors,
    body_text: extra ? `${item.body_markdown}\n${extra}` : item.body_markdown,
    display_state: item.display_state,
    lifecycle_status: item.lifecycle_status,
    trust_tier: item.trust_tier,
    stale: item.stale,
    stale_after: item.stale_after,
    last_verified_at: item.last_verified_at,
    generated_by: item.generated_by,
    superseded_by: item.superseded_by,
  };
}

function matchOf(parsed: ParsedSearchQuery): ExcerptMatch | null {
  if (!hasTextSignal(parsed)) return null;
  return { terms: parsed.terms, phrases: parsed.phrases, prefixTerm: parsed.prefixTerm };
}

/** Snippet, truncation and highlight ranges — `presentationFor` in the server's search service. */
function presentationFor(match: ExcerptMatch | null, item: LocalItem): Pick<SearchHit, 'snippet' | 'snippet_truncated' | 'highlights'> {
  const snip = snippetFor(match, item);
  const titleRanges = match ? highlightRanges(item.title, match) : [];
  const highlights: SearchHighlights = {
    ...(titleRanges.length ? { title: titleRanges } : {}),
    ...(snip?.highlights.length ? { snippet: snip.highlights } : {}),
  };
  return {
    ...(snip ? { snippet: snip.text, snippet_truncated: { start: snip.truncatedStart, end: snip.truncatedEnd } } : {}),
    ...(highlights.title || highlights.snippet ? { highlights } : {}),
  };
}

function snippetFor(match: ExcerptMatch | null, item: LocalItem): ExcerptResult | null {
  const body = plainTextForExcerpt(item.body_markdown);
  const description = item.description ?? '';
  if (match) {
    for (const source of [body, description, taxonomySummary(item)]) {
      const found = source ? excerpt(source, match, { maxChars: DEFAULT_EXCERPT_CHARS }) : null;
      if (found) return found;
    }
  }
  const lead = description || body;
  return lead ? leadOf(lead, DEFAULT_EXCERPT_CHARS) : null;
}

function taxonomySummary(item: LocalItem): string {
  return [
    item.aliases.length ? `Also known as: ${item.aliases.join(', ')}` : undefined,
    item.topic_name ? `Topic: ${item.topic_name}` : undefined,
    item.tags.length ? `Tags: ${item.tags.join(', ')}` : undefined,
    item.categories.length ? `Categories: ${item.categories.join(', ')}` : undefined,
    item.groups.length ? `Groups: ${item.groups.join(', ')}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The opening of a text cut on a word boundary (server/src/search/snippet.ts `leadOf`). */
function leadOf(text: string, maxChars: number): ExcerptResult {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return { text: collapsed, highlights: [], truncatedStart: false, truncatedEnd: false };
  const space = collapsed.lastIndexOf(' ', maxChars);
  let end = space > maxChars * 0.6 ? space : maxChars;
  if (/[\uD800-\uDBFF]/.test(collapsed[end - 1] ?? '')) end -= 1;
  const cut = collapsed.slice(0, end).replace(/[\s,;:\-–—]+$/u, '');
  return { text: cut, highlights: [], truncatedStart: false, truncatedEnd: true };
}

function matchedFields(parsed: ParsedSearchQuery, item: LocalItem): string[] {
  const terms = parsed.terms.map(normalize).filter(Boolean);
  const phrases = parsed.phrases.map(normalize).filter(Boolean);
  const hit = (value: string) => containsPhrase(value, phrases) || containsAnyTerm(value, terms);
  const fields: string[] = [];
  if (hit(item.title)) fields.push('title');
  if (hit(item.slug)) fields.push('slug');
  if (item.aliases.some(hit)) fields.push('aliases');
  if (item.description && hit(item.description)) fields.push('description');
  if (hit(item.body_markdown)) fields.push('body');
  if (item.topic_name && hit(item.topic_name)) fields.push('topic');
  if (item.tags.some(hit)) fields.push('tags');
  if (item.categories.some(hit)) fields.push('categories');
  if (item.groups.some(hit)) fields.push('groups');
  return fields;
}

function reasonsFor(parsed: ParsedSearchQuery, fields: string[], item: LocalItem, status: string | undefined, now: Date): string[] {
  const reasons: string[] = [];
  if (hasTextSignal(parsed)) {
    const terms = parsed.terms.map(normalize).filter(Boolean);
    const phrases = parsed.phrases.map(normalize).filter(Boolean);
    const hit = (value: string) => containsAnyTerm(value, terms) || containsPhrase(value, phrases);
    if (fields.includes('title')) reasons.push('Title match');
    for (const alias of item.aliases.filter(hit)) reasons.push(`Alias: ${alias}`);
    if (fields.includes('body')) reasons.push('Body match');
    if (fields.includes('topic') && item.topic_name) reasons.push(`Topic: ${item.topic_name}`);
    for (const tag of item.tags.filter(hit)) reasons.push(`Tag: ${tag}`);
    for (const category of item.categories.filter(hit)) reasons.push(`Category: ${category}`);
    for (const group of item.groups.filter(hit)) reasons.push(`Group: ${group}`);
  }
  if (status === item.status) reasons.push(`Status: ${item.status === 'draft' ? 'Draft' : 'Published'}`);
  const age = now.getTime() - new Date(item.updated_at).getTime();
  if (age >= 0 && age <= RECENT_MS) reasons.push('Recently updated');
  return reasons;
}

function emptyStateFor(
  input: SearchToolInput,
  parsed: ParsedSearchQuery,
  axes: ReturnType<typeof resolveFilters>,
  status: string | undefined,
): NonNullable<LocalSearchResult['empty_state']> {
  const q = input.q?.trim();
  const active = [
    axes.space.length ? 'Topic' : null,
    status ? 'Status' : null,
    axes.tag.length ? 'Tag' : null,
    axes.category.length ? 'Category' : null,
    axes.group.length ? 'Group' : null,
    axes.type.length ? 'Type' : null,
    parsed.filters.author?.length || parsed.excludedFilters.author?.length ? 'Author' : null,
    parsed.filters.is?.length || parsed.excludedFilters.is?.length ? 'Is' : null,
    parsed.updated ? 'Updated' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    title: q ? `No matches for “${q}”` : 'No items match the current filters',
    guidance: [
      active ? `Relax these filters and try again: ${active}.` : 'Try a broader term, a related acronym, or a tag/topic name.',
      'Search checks titles, aliases, descriptions, body text, tags, categories, groups, Topic, status filters, and recently updated notes.',
    ],
    can_create_from_search: false,
  };
}

function facet(values: (string | null | undefined)[], active: string[], labelFor: (v: string) => string = (v) => v): FacetValue[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? labelFor(trimmed), count: (current?.count ?? 0) + 1 });
  }
  const wanted = active.map((v) => v.toLowerCase().trim()).filter(Boolean);
  return [...counts.entries()]
    .map(([value, e]) => ({
      value,
      label: e.label,
      count: e.count,
      active: wanted.length ? wanted.some((w) => w === value || w === slugify(e.label) || slugify(w) === slugify(value)) : undefined,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_FACET_VALUES);
}

function trustTierLabel(tier: string): string {
  if (tier === 'human-reviewed') return 'Human-reviewed';
  if (tier === 'machine-confirmed') return 'Machine-confirmed';
  return 'Unverified';
}

function parseStatus(value: string | undefined): 'draft' | 'published' | undefined {
  return value === 'draft' || value === 'published' ? value : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).map((t) => t.trim()).filter(Boolean);
}

function containsAnyTerm(value: string, terms: string[]): boolean {
  const tokens = tokenize(value);
  const lower = value.toLowerCase();
  return terms.some((term) => !!term && (lower.includes(term) || tokens.includes(term)));
}

function containsPhrase(value: string, phrases: string[]): boolean {
  const lower = value.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}
