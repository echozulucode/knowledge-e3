/**
 * @echozedlabs/knowledge-types — shared DTOs and interface contracts.
 *
 * This package is the seam between the presentation/protocol layers (web, REST,
 * MCP) and the content/storage layers. It contains **types only**: no runtime
 * code, no dependencies. Every other package and the server host implement or
 * consume these shapes.
 *
 * See the knowledge hub plan §9.3 for the design.
 * Field names deliberately match the server's existing `PageView`/`ItemView`/
 * `SearchHit` so adoption is additive, never a rename.
 */

// ---------------------------------------------------------------------------
// Actors and viewers
// ---------------------------------------------------------------------------

/** Who performs a write. OKF v0.2 actor convention: `human:<id>` | `process:<id>` | `agent:<id>`. */
export interface Actor {
  /** E3 user id (the authenticated user). Always a human account in this system. */
  userId: string;
  /** OKF actor string for provenance, e.g. `human:jdoe`, `process:claude-code/1.0`. */
  okfActor: string;
  /** The tool acting on the user's behalf, if any (recorded in `generated.by`). */
  via?: { kind: 'ui' | 'mcp' | 'rest' | 'git' | 'import'; client?: string };
}

/** Who reads. `null` user = anonymous. */
export interface Viewer {
  userId: string | null;
  role: 'anonymous' | 'user' | 'admin';
}

// ---------------------------------------------------------------------------
// Diagnostics (lint, validation, sync)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Stable rule id, e.g. `type.unknown`, `category.missing`, `link.unresolved`. */
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Frontmatter key or body location the diagnostic points at, when known. */
  path?: string;
  /** A machine-applicable fix, when one exists (e.g. a default `stale_after`). */
  fix?: { description: string; frontmatter?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Bundle validation (the integrity + lint gate)
// ---------------------------------------------------------------------------

/**
 * Severity of one bundle-validation finding.
 *
 * `critical` is reserved for the conformance tier: it is the only severity that
 * says "this is not an OKF bundle", and therefore the only one an importer may
 * reject on. `error` means a rule *this instance* enforces was broken — real,
 * but a local standard, not a format violation. `warning`/`info` never gate
 * anything.
 */
export type BundleValidationSeverity = 'critical' | DiagnosticSeverity;

/** One finding about one file in a bundle. */
export interface BundleValidationIssue {
  /** Bundle-relative path of the file the finding is about, e.g. `concepts/orders.md`. */
  path: string;
  /** Stable rule id, e.g. `type.missing`, `link.unresolved`, `category.unknown`. */
  code: string;
  severity: BundleValidationSeverity;
  message: string;
  /**
   * Link findings: the target exactly as it was written — the `[[Title]]` title
   * or the `/bundle/relative/path` — so a caller can offer to fix or drop it.
   */
  target?: string;
  /**
   * Frontmatter key (or `body`) the finding points at, when it is narrower than
   * the whole file. Carries the lint's `Diagnostic.path` through unchanged.
   */
  field?: string;
  /** A machine-applicable fix, carried through from the lint when it offers one. */
  fix?: { description: string; frontmatter?: Record<string, unknown> };
}

/**
 * What a caller needs to make a decision without walking the issue lists. The
 * two booleans are deliberately separate: a bundle can be a perfectly valid OKF
 * bundle (`conformant`) while failing this instance's editorial rules
 * (`meetsPolicy`), and only the first is grounds for refusing the import.
 */
export interface BundleValidationSummary {
  /** Non-reserved `.md` concept documents examined (`index.md`/`log.md` excluded). */
  conceptCount: number;
  /** False iff any conformance issue is `critical`. The import-rejection gate. */
  conformant: boolean;
  /** False iff any policy issue is `error`. Never a reason to reject an import. */
  meetsPolicy: boolean;
  /** Total conformance-tier issues, all severities. */
  conformanceCount: number;
  /** Total policy-tier issues, all severities. */
  policyCount: number;
  /** Total advisory-tier issues, all severities. */
  advisoryCount: number;
  /** Conformance issues at `critical` — the ones that make `conformant` false. */
  criticalCount: number;
  /** Policy issues at `error` — the ones that make `meetsPolicy` false. */
  policyErrorCount: number;
}

/**
 * The full result of validating an OKF bundle, in three tiers that answer three
 * different questions. Collapsing them loses the distinction that makes the
 * report usable, so each tier keeps its own list:
 *
 * - **conformance** — the OKF v0.2 spec rules (§11, plus the §10.2 Attested
 *   Computation contract). A `critical` here means the input is not an OKF
 *   bundle at all. This is the only tier that may block an import.
 * - **policy** — this instance's content-model rules (the lint). A failure here
 *   means the content does not meet local editorial standards: a softer and
 *   entirely separate statement, which must not be used to reject a bundle.
 * - **advisory** — unresolved cross-references and the v0.2 trust/provenance/
 *   freshness signals. Warnings and info only; never blocks anything.
 */
export interface BundleValidationReport {
  conformance: BundleValidationIssue[];
  policy: BundleValidationIssue[];
  advisory: BundleValidationIssue[];
  summary: BundleValidationSummary;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** E3 publication state (the `pages.status` column). */
export type PublicationStatus = 'draft' | 'published';

/** OKF v0.2 lifecycle `status` (absent ⇒ stable). */
export type LifecycleStatus = 'draft' | 'stable' | 'deprecated';

/** OKF v0.2 trust tier derived from `verified[]`. */
export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

/**
 * What the reader sees. Derived, never stored:
 *   Draft/Published from publication status; Needs review when published and
 *   past `stale_after`; Superseded when deprecated with a successor; Archived
 *   when deprecated without one; In review while the item's edits are staged on
 *   an open change request (`review` mode, plan §8.2) — that one wins over the
 *   lifecycle-derived value.
 */
export type DisplayState = 'draft' | 'published' | 'needs-review' | 'superseded' | 'archived' | 'in-review';

/** State of the change request an item's edits are staged on. */
export type ReviewState = 'open' | 'merged' | 'closed';

/**
 * The change request an item's edits are staged on in a `review`-mode source
 * (plan §8.2), as summaries and views carry it. Absent/`null` = never staged.
 */
export interface ReviewRef {
  state: ReviewState;
  url: string | null;
  branch: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

/**
 * Provenance of the file behind an item (plan §8.3): which registered source
 * holds it and how that source may be written. `role: 'reference'` is what the
 * reader renders as "External" — the content is somebody else's, so the edit
 * affordance becomes a link upstream rather than an editor.
 */
export interface ItemSourceRef {
  /** Source registry id (`main` / `topic:<slug>`). */
  id: string;
  role: SourceRole;
  mode: SyncMode;
  /** Repo-relative posix path of the canonical file, when the index recorded one. */
  path?: string | null;
  /** The file on the host's web UI, when the remote is one we can address; null otherwise. */
  url?: string | null;
}

/** Lifecycle/trust signals carried on summaries and views. All optional: absence means unknown. */
export interface LifecycleSignals {
  display_state?: DisplayState;
  lifecycle_status?: LifecycleStatus;
  trust_tier?: TrustTier;
  /** ISO date; true staleness is `stale_after <= now`. */
  stale_after?: string | null;
  stale?: boolean;
  last_verified_at?: string | null;
  /** OKF `generated.by` actor string, when present. */
  generated_by?: string | null;
  /** Successor item id/slug when `superseded_by` is set. */
  superseded_by?: string | null;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemSummary extends LifecycleSignals {
  id: string;
  slug: string;
  title: string;
  status: PublicationStatus;
  type: string | null;
  space_id: string | null;
  /** Topic slug, when resolved. */
  topic?: string;
  /** Topic display name, when resolved — what index surfaces label an item with (home plan R3). */
  topic_name?: string | null;
  description?: string | null;
  updated_at: string;
  published_at?: string | null;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  /**
   * The change request this item's edits are staged on (plan §8.2), or null
   * when it was never staged. While `state` is `open` the item stays a draft
   * and `display_state` reads `in-review`.
   */
  review?: ReviewRef | null;
  /**
   * Where this item's canonical file lives (plan §8.3). Absent when the row
   * records no source — an item written before the registry existed.
   */
  source?: ItemSourceRef | null;
}

/** Full item view — the same shape the server's `PageView`/`ItemView` carry today. */
export interface ItemView extends ItemSummary {
  owner_id: string | null;
  created_at: string;
  version_token: number;
  current_version_id: string | null;
  body_markdown: string;
  raw_markdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  categories: string[];
  groups: string[];
}

// ---------------------------------------------------------------------------
// Topics, Sections, feeds
// ---------------------------------------------------------------------------

export type PresentationProfile = 'portal' | 'blog' | 'docs' | 'wiki';

export type SectionSlot = 'start-here' | 'essential' | 'examples' | 'limitations' | 'advanced' | 'latest' | 'none';

export interface SectionView {
  slug: string;
  name: string;
  description?: string;
  /** OKF concept type filter, if any. */
  type?: string;
  /** Topic (space) slug/id filter, if any. */
  space?: string;
  /** Tag filter: an item matches if it carries ANY of these (empty/absent = no filter). */
  tags?: string[];
  slot?: SectionSlot;
  order?: number;
  limit?: number;
  /**
   * Resolved members, newest published first. `FeedEntry` rather than a bare
   * `ItemSummary` so a Section can render as a story list (cover, authors,
   * reading time, series) without a second request (home plan R2.11).
   */
  items?: FeedEntry[];
}

export interface TopicView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  presentation: PresentationProfile;
  /** Rendered from the bundle root `index.md` body, when present. */
  landing_markdown?: string | null;
  /** Slug of the "Start here" item, when the landing frontmatter names one. */
  start_here?: string | null;
  sections?: SectionView[];
  counts?: { items: number; published: number };
}

export interface FeedQuery {
  /** Topic slug; omitted = site-wide. */
  topic?: string;
  /** Restrict to these content types (labels), e.g. `['Blog Post']`. */
  types?: string[];
  series?: string;
  author?: string;
  limit?: number;
  cursor?: string;
}

export interface FeedEntry extends ItemSummary {
  authors?: string[];
  cover?: string | null;
  reading_time_minutes?: number;
  series?: string | null;
  series_order?: number | null;
}

/**
 * The published `Series` item whose slug a series names: the series' landing
 * (home plan R2.11). Its title, description and cover head the series page; its
 * body's hand-written *Parts* list is deliberately not carried, because the
 * parts' own `series_order` is the one source of order.
 */
export interface SeriesItem {
  id: string;
  slug: string;
  title: string;
  /** `description`, else `summary` — the same order `itemPreview` reads. */
  description: string | null;
  cover: string | null;
  /** Author-written alt text for the cover (`cover_alt`), when set. */
  cover_alt: string | null;
  space_id: string | null;
}

/** `GET /feed/series/:slug`: the parts in reading order, plus the Series item when one is visible. */
export interface SeriesView {
  /** The slug as requested (kept for existing callers). */
  series: string;
  /** Null when no published Series item with this slug is visible to the viewer. */
  series_item: SeriesItem | null;
  items: FeedEntry[];
}

/**
 * One entry in a "Popular" list (home plan R3): a feed entry plus how many
 * distinct signed-in readers opened it inside the window. Counts are aggregate
 * only — no list ever says WHO read something.
 */
export interface PopularEntry extends FeedEntry {
  views: number;
}

/** `GET /popular` — the most-read published items, site-wide or in one topic. */
export interface PopularView {
  /** The look-back window the counts cover, in days. */
  window_days: number;
  items: PopularEntry[];
}

export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `verified`: most recently verified first (`last_verified_at`), unverified items last. */
export type SortMode = 'relevance' | 'newest' | 'oldest' | 'az' | 'verified';

export interface SearchQuery {
  q?: string;
  /** Topic slug/id. */
  space?: string;
  tag?: string;
  category?: string;
  group?: string;
  type?: string;
  status?: PublicationStatus;
  since?: string;
  sort?: SortMode;
  include_drafts?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchHit extends ItemSummary {
  path?: string;
  url?: string;
  score: number;
  snippet?: string;
  matched_fields?: string[];
  reasons?: string[];
  /**
   * Where the query matched, as half-open `[start, end)` ranges in UTF-16 code
   * units into THIS hit's `title` and `snippet` strings exactly as returned, so
   * a client can wrap them in `<mark>` without re-running any matching. Ranges
   * are sorted, non-overlapping and within bounds; absent when nothing matched
   * in that field (search reader plan R6 / SEARCH-003).
   */
  highlights?: SearchHighlights;
  /**
   * Where `snippet` was cut from longer text. The snippet itself never contains
   * an ellipsis character (so `highlights` offsets stay exact); a client draws
   * `…` at each cut edge.
   */
  snippet_truncated?: { start: boolean; end: boolean };
}

export type HighlightRange = [start: number, end: number];

export interface SearchHighlights {
  title?: HighlightRange[];
  snippet?: HighlightRange[];
}

/** One group of a grouped result set (by content type or by kind of thing). */
export interface SearchGroup {
  /** Group key, e.g. `topic`, `section`, or a content-type label. */
  key: string;
  label: string;
  hits: SearchHit[];
  /** Total hits in the group before the per-group cap. */
  total: number;
}

/** One value of a search facet, counted over every match. */
export interface SearchFacetValue {
  /** Lowercased key, used for comparisons. */
  value: string;
  /** What to show, and what to put in the URL. */
  label: string;
  count: number;
  active?: boolean;
}

/**
 * `GET /search/overview` — what `/search` shows before anything is typed
 * (reader plan R12): the library's shape, counted over what THIS viewer may
 * read, so a reader can start from a type, topic, category or tag instead of a
 * blank box.
 */
export interface SearchOverview {
  /** Published items the viewer can read. */
  total: number;
  types: SearchFacetValue[];
  topics: SearchFacetValue[];
  categories: SearchFacetValue[];
  /** The most-used tags, capped (about 24). */
  tags: SearchFacetValue[];
  /** Most recently verified items (human-reviewed or machine-confirmed), newest first, capped (about 6). */
  recently_verified: ItemSummary[];
  /** Most recently updated published items, capped (about 6). */
  recently_updated: ItemSummary[];
}

export interface GroupedSearchResults {
  query: SearchQuery;
  groups: SearchGroup[];
  total: number;
}

/** A document as handed to a `SearchProvider` for indexing. */
export interface SearchDoc extends ItemSummary {
  body_text: string;
  description?: string | null;
  /** Frontmatter `authors` — what the `author:` filter matches (with a single `author`). */
  authors?: string[] | null;
}

export interface SearchProvider {
  index(doc: SearchDoc): Promise<void>;
  remove(id: string): Promise<void>;
  query(q: SearchQuery, viewer: Viewer): Promise<SearchHit[]>;
}

/**
 * Outcome of the most recent restore drill (issue 71). A backup nobody has
 * restored is a hope, not a backup, so this is the one health signal that is
 * about the PAST rather than the present: it says whether this instance's
 * recovery unit has actually been rehearsed, and how long it took.
 *
 * `outcome: 'never'` is the honest default and must be reported as such — an
 * instance that has never run a drill is not healthy-with-no-data, it is
 * unverified, which is exactly what issue 71 exists to make visible.
 */
export interface BackupDrillStatus {
  outcome: 'passed' | 'failed' | 'never';
  /** When the drill last ran to completion, pass or fail. */
  last_run_at: string | null;
  /** Data the restore would have lost, in seconds — the drill's measured RPO. */
  rpo_seconds: number | null;
  /** How long the restore took, in seconds — the drill's measured RTO. */
  rto_seconds: number | null;
  /** One line naming what failed; null when it passed or never ran. */
  failure: string | null;
  /** When the scheduler will next run it; null when scheduling is off. */
  next_run_at: string | null;
}

// ---------------------------------------------------------------------------
// Sync / sources
// ---------------------------------------------------------------------------

export type SourceRole = 'authoritative' | 'reference';
export type SyncMode = 'direct' | 'review' | 'read-only';

export interface SyncPolicy {
  mode: SyncMode;
  /** Branch prefix for `review` mode item branches. Default `e3/`. */
  branchPrefix?: string;
}

export interface SourceRef {
  id: string;
  /** Local working tree path. */
  local: string;
  remote?: string | null;
  branch?: string | null;
  role: SourceRole;
  policy: SyncPolicy;
}

export interface SyncStatus {
  source: string;
  state: 'idle' | 'fetching' | 'merging' | 'indexing' | 'committing' | 'pushing' | 'conflict' | 'error';
  ahead: number;
  behind: number;
  dirty_paths: string[];
  conflicted_paths: string[];
  last_synced_at: string | null;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Content store (files) and Git (repo-sync) — implemented in later phases
// ---------------------------------------------------------------------------

export interface StoredItemRef {
  path: string;
  slug: string;
  digest: string;
}

export interface StoredItem extends StoredItemRef {
  raw: string;
}

export interface ContentStore {
  root: string;
  /**
   * The bundle's items. With no `include` globs that is the canonical
   * `concepts/` layout; with them, exactly the `.md` files they select minus
   * `exclude` (plan §8.3, non-OKF Markdown import).
   */
  list(selection?: { include?: readonly string[]; exclude?: readonly string[] }): Promise<StoredItemRef[]>;
  read(path: string): Promise<StoredItem>;
  write(path: string, raw: string, opts?: { expectDigest?: string }): Promise<{ digest: string }>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  pathFor(slug: string, type?: string): string;
}

export interface Revision {
  content: string;
  dateIso?: string;
  authorEmail?: string;
  commit?: string;
}

export interface PathChange {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  from?: string;
}

export interface RepoStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: string[];
  conflicted: string[];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
}

export interface PushResult {
  ok: boolean;
  rejected?: boolean;
  error?: string;
}

export interface GitRepo {
  status(): Promise<RepoStatus>;
  commit(paths: string[], message: string, author: { name: string; email: string }): Promise<string>;
  fetch(): Promise<void>;
  merge(ref: string): Promise<MergeResult>;
  push(ref?: string): Promise<PushResult>;
  changedPaths(from: string, to: string): Promise<PathChange[]>;
  log(path: string): Promise<Revision[]>;
}

export interface ChangeRef {
  host: string;
  id: string;
  url: string;
}

export interface ChangeRequestHost {
  openChange(input: { source: SourceRef; branch: string; title: string; body: string }): Promise<ChangeRef>;
  status(ref: ChangeRef): Promise<'open' | 'merged' | 'closed'>;
  merge?(ref: ChangeRef): Promise<void>;
  comment?(ref: ChangeRef, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query and command contracts (implemented by the server host)
// ---------------------------------------------------------------------------

export interface KnowledgeQuery {
  item(idOrSlug: string, viewer: Viewer): Promise<ItemView | null>;
  topic(slug: string, viewer: Viewer): Promise<TopicView | null>;
  topics(viewer: Viewer): Promise<TopicView[]>;
  sections(topic?: string): Promise<SectionView[]>;
  /** Sections naming no topic: they draw from every topic, for the front page only. */
  crossTopicSections(viewer: Viewer): Promise<SectionView[]>;
  feed(q: FeedQuery, viewer: Viewer): Promise<Page<FeedEntry>>;
  search(q: SearchQuery, viewer: Viewer): Promise<GroupedSearchResults>;
  related(id: string, viewer: Viewer): Promise<ItemSummary[]>;
  changedSince(since: string, viewer: Viewer): Promise<Page<ItemSummary>>;
}

export type WriteSource = 'ui' | 'mcp' | 'rest' | 'git' | 'import';

export interface CreateInput {
  id?: string;
  title?: string;
  body?: string;
  raw?: string;
  frontmatter?: Record<string, unknown>;
  status?: PublicationStatus;
  /** Topic slug/id. */
  space?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
}

export interface UpdateInput {
  title?: string;
  body?: string;
  raw?: string;
  frontmatter?: Record<string, unknown>;
  status?: PublicationStatus;
  tags?: string[];
  categories?: string[];
  groups?: string[];
}

/** A write result: the view plus the lint diagnostics that were produced (warnings never block). */
export interface WriteResult {
  item: ItemView;
  diagnostics: Diagnostic[];
}

export interface LintContext {
  /** Topic slug/id the item targets, if known. */
  space?: string;
  /** Known vocabularies for tag/category/group checks. */
  known?: {
    tags?: string[];
    categories?: string[];
    groups?: string[];
    /**
     * Slugs of groups an admin archived. Naming one in frontmatter still links
     * the item to it (the group is not restored), so the lint says so
     * (`group.archived`, a warning — never a publish refusal).
     */
    archivedGroups?: string[];
    types?: string[];
  };
  /** Slugs that resolve, for wiki-link checks. */
  resolvableSlugs?: Set<string>;
  now?: Date;
}

export interface ContentCommands {
  create(actor: Actor, input: CreateInput, source: WriteSource): Promise<WriteResult>;
  update(actor: Actor, id: string, input: UpdateInput, ifMatch: number, source: WriteSource): Promise<WriteResult>;
  publish(actor: Actor, id: string, opts?: { reviewed?: boolean }): Promise<WriteResult>;
  verify(actor: Actor, id: string): Promise<WriteResult>;
  rename(actor: Actor, id: string, newTitle: string): Promise<WriteResult>;
  /**
   * Move an item to another topic (plan §8.3). The canonical file is written at
   * the target topic's path and removed from the one it left — across
   * repositories when the two topics resolve to different sources. The slug is
   * allocated instance-wide and never changes, so `/p/:slug` and `/items/:id`
   * keep resolving by construction (no alias table).
   */
  move(actor: Actor, id: string, targetTopic: string, opts?: { ifMatch?: number }): Promise<WriteResult>;
  remove(actor: Actor, id: string): Promise<void>;
  restore(actor: Actor, id: string): Promise<WriteResult>;
  lint(raw: string, ctx: LintContext): Promise<Diagnostic[]>;
}
