/**
 * Open Knowledge Format (OKF) v0.2 types for exchanging Knowledge E3 content.
 *
 * OKF represents knowledge as a directory of Markdown "concept" files with YAML
 * frontmatter. The only required frontmatter field is `type`; everything else is
 * recommended or producer-defined. v0.2 adds optional *trust* families —
 * provenance (`sources`), authorship/confirmation (`generated`/`verified` →
 * trust tiers), lifecycle (`status`/`stale_after`) — and the
 * `Attested Computation` concept type. See the OKF format study and the OKF
 * v0.2 migration notes for the format and the migration this implements.
 *
 * NOTE (two version axes): "v0.2" here means the OKF *spec* version. The E3
 * *product* roadmap and v0.2 spec also use "v0.2" for an unrelated milestone —
 * do not conflate the two.
 */

/**
 * An actor string per the OKF actor convention (§7):
 * - `<producer>/<version>` — an agent or tool, e.g. `reference_agent/gemini-2.5-pro`.
 * - `human:<id>` — a person, e.g. `human:ericjzim`.
 * - `process:<id>` — an automated process, e.g. `process:git-mirror`.
 * Trust tiering keys off the `human:` prefix, so it MUST be exact for
 * human-authored or human-confirmed content.
 */
export type OkfActor = string;

/** Trust tier derived (never stored) from a concept's `verified` field (§5.3). */
export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

/** OKF v0.2 lifecycle vocabulary (§5.4). Absent ⇒ `stable`. */
export type OkfLifecycle = 'draft' | 'stable' | 'deprecated';

/** A `{ by, at }` event: who produced/confirmed the content, and when. */
export interface OkfActorEvent {
  /** An actor (§7). REQUIRED within `generated`; also present on each `verified` entry. */
  by: OkfActor;
  /** ISO 8601 datetime. */
  at?: string;
}

/** A `{ from, to }` date range framing `usage_count` credibility signals (§5.1). */
export interface OkfUsageWindow {
  from?: string;
  to?: string;
}

/** One entry in a concept's `sources` provenance list (§5.1). */
export interface OkfSource {
  /**
   * REQUIRED within an entry. A concrete artifact a consumer can follow (URL,
   * bundle-relative `/…` path, or a `references/` path) OR a population/scope
   * descriptor it cannot (e.g. `all queries in project X`).
   */
  resource: string;
  /** Stable key for per-claim attribution via `[^id]` footnotes. */
  id?: string;
  /** Human-readable label. */
  title?: string;
  /** Credibility signal — who produced the source, in the actor convention (§7). */
  author?: OkfActor;
  /** Credibility signal — how often `resource` was exercised over `usage_window`. */
  usage_count?: number;
  /** Credibility signal — when the source itself last changed (`YYYY-MM-DD`). */
  last_modified?: string;
  /** Per-entry override of the shared `usage_window`. */
  usage_window?: OkfUsageWindow;
}

/** A typed, named hole an agent may fill in an Attested Computation (§10.2). */
export interface OkfParameter {
  name: string;
  /** Type hint interpreted per `runtime` (e.g. `integer`, `string`). */
  type?: string;
  required?: boolean;
}

/** How an Attested Computation is run and what evidence a run must return (§10.2). */
export interface OkfExecutor {
  /** Path (§6.2) to run instructions or code. */
  resource?: string;
  /** Field names a run's receipt must return (e.g. `[job_id, executed_sql, result]`). */
  receipt?: string[];
}

/** Deterministic (no-LLM) check that inspects a receipt and returns a verdict (§10.2). */
export interface OkfAttester {
  /** Path (§6.2) to the attester code; meant to run consumer-side. */
  resource?: string;
}

/** OKF concept frontmatter. `type` is the only required field per the spec (§4.1, §11). */
export interface OkfFrontmatter {
  /** REQUIRED — short string identifying the kind of concept. */
  type: string;
  /** Human-readable display name. */
  title?: string;
  /** One-line summary used by index generators and previews. */
  description?: string;
  /** Canonical URI for an underlying asset, when the concept describes one. */
  resource?: string;
  /** Cross-cutting categorization. */
  tags?: string[];
  /**
   * v0.1 last-change timestamp. Superseded by `generated.at` in v0.2 (§13.1);
   * still emitted during the transition and read as a fallback on import.
   */
  timestamp?: string;

  // --- v0.2 trust: how the content was produced / confirmed (§5.2) ---
  /** How the current content was produced. `by` is required within `generated`. */
  generated?: OkfActorEvent;
  /**
   * Independent verification events. A single verifier MAY be a bare `{ by, at }`
   * mapping; consumers MUST treat it as a one-element list (§5.2/§11).
   */
  verified?: OkfActorEvent | OkfActorEvent[];

  // --- v0.2 provenance (§5.1) ---
  /** Materials this concept derives from. */
  sources?: OkfSource[];
  /** Shared `{ from, to }` window framing every `usage_count`. Sibling of `sources`. */
  usage_window?: OkfUsageWindow;

  // --- v0.2 lifecycle (§5.4, §5.5) ---
  /** Lifecycle state. Absent ⇒ `stable`. */
  status?: OkfLifecycle;
  /** Absolute date (`YYYY-MM-DD`); stale when `today >= stale_after`. */
  stale_after?: string;

  // --- v0.2 Attested Computation contract (§10.2); only for `type: Attested Computation` ---
  /** REQUIRED for the type. How to run the computation (`bigquery`, `dbt`, `python`, …). */
  runtime?: string;
  /** The typed, named holes an agent may fill. */
  parameters?: OkfParameter[];
  /** Path to a file holding the computation, used instead of an inline `# Computation` fence. */
  computation?: string;
  /** How the computation is run and what its receipt must return. */
  executor?: OkfExecutor;
  /** Deterministic check over a receipt. */
  attester?: OkfAttester;

  /** Producer-defined extension keys are allowed and preserved. */
  [key: string]: unknown;
}

/**
 * The Knowledge E3 page data needed to produce one OKF concept. Deliberately
 * decoupled from the server's PageView so this library has no NestJS/DB deps.
 */
export interface PageInput {
  /** Immutable E3 item id — embedded in the concept so re-import keys on it, not the path. */
  id: string;
  /** Stable slug; becomes the concept's filename. */
  slug: string;
  title: string;
  status?: string;
  /** Space (topic) slug or name, if any. */
  space?: string | null;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  /** Owning user id, embedded so ownership survives a rebuild from files. */
  ownerId?: string | null;
  /** Full document: frontmatter + body, exactly as stored in E3. */
  rawMarkdown: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * How cross-references are rendered in exported bodies.
 * - `dual`: keep `[[Title]]` and append a bundle-relative markdown link (Obsidian + OKF + plain).
 * - `markdown`: replace `[[Title]]` with a bundle-relative markdown link only (purest OKF).
 * - `preserve`: leave the body untouched.
 */
export type LinkStyle = 'dual' | 'markdown' | 'preserve';

export interface ConceptResult {
  /** OKF concept id: the file path within the bundle, minus `.md`. */
  conceptId: string;
  /** Bundle-relative file path, e.g. `concepts/my-page.md`. */
  path: string;
  /** Full concept document (frontmatter + body). */
  content: string;
  frontmatter: OkfFrontmatter;
}

export interface BundleFile {
  /** Bundle-relative path. */
  path: string;
  content: string;
}

/**
 * A binary asset (image / PDF / attachment) referenced by a concept, carried in a
 * full-fidelity export so the bundle is self-contained. The bytes live at
 * `assets/<file>`; the sidecar descriptor (`assets/<file>.meta.json`, ADR-0003)
 * travels as a normal text {@link BundleFile}. Text `files` and binary `assets`
 * are kept in separate channels so the text model never has to base64-encode.
 */
export interface BundleAsset {
  /** Bundle-relative path to the bytes, e.g. `assets/a1b2c3d4.png`. */
  path: string;
  /** Raw asset bytes. */
  bytes: Uint8Array;
}

export interface OkfBundle {
  files: BundleFile[];
  /**
   * Binary assets referenced by the concepts. Present only in full-fidelity
   * (archive) exports — the JSON `{ files }` envelope stays text-only. Concept
   * text remains fully valid OKF without them; they add byte-for-byte portability.
   */
  assets?: BundleAsset[];
}

export interface ConformanceIssue {
  /** Bundle-relative path of the file the issue is about. */
  path: string;
  /** Stable rule id, e.g. `type.missing`, `attested.runtime.missing`. */
  code: string;
  /** `critical` is the rejection gate; `warning` never makes a bundle non-conformant. */
  severity: 'critical' | 'warning';
  message: string;
}

/**
 * A cross-reference inside the bundle that points at something the bundle does
 * not contain. Always a `warning`, never `critical`: a concept that references a
 * concept living in *another* bundle is legitimate OKF (§5.3 — consumers
 * tolerate broken links), and the whole point of the source registry is that
 * such bundles exist side by side. Report it so a caller can decide; never
 * reject on it.
 */
export interface BundleLinkIssue extends ConformanceIssue {
  /** The target exactly as written: the `[[Title]]` title, or the `/path` token. */
  target: string;
  /** Where the reference was found. */
  origin: 'wiki-link' | 'markdown-link' | 'frontmatter';
  /** For `frontmatter` origin, the key that held the path (e.g. `executor.resource`). */
  field?: string;
}

export interface ConformanceReport {
  /** True iff no issue in `issues` is `critical`. `links` never affects this. */
  conformant: boolean;
  /** Normative conformance issues (§11, §10.2). */
  issues: ConformanceIssue[];
  conceptCount: number;
  /**
   * Unresolved cross-references, kept in their own list rather than mixed into
   * `issues` so that existing single-list callers (which treat `issues` as "the
   * reasons this bundle is not conformant") keep reporting exactly what they
   * always did. Never empty-checked as a gate.
   */
  links: BundleLinkIssue[];
}

/**
 * A Knowledge E3 item recovered from an OKF concept document, ready to be
 * created or updated. Metadata is read back from the `e3_*` extension keys
 * (authoritative) with OKF-standard fields as fallbacks. Re-import keys on
 * `e3Id` so the same instance updates rather than duplicates.
 */
export interface OkfImportItem {
  /** Original E3 id, if the concept carries one. */
  e3Id?: string;
  /** Original E3 slug, recovered from `e3_slug` — used to rebuild the index faithfully. */
  slug?: string;
  /** Owning user id, recovered from `e3_owner_id`. */
  ownerId?: string;
  /** Creation timestamp, recovered from `e3_created_at`. */
  createdAt?: string;
  /** Last-change timestamp, recovered from `timestamp`. */
  updatedAt?: string;
  title: string;
  status?: 'draft' | 'published';
  /**
   * A lifecycle value present in frontmatter that we could not interpret (e.g.
   * `status: kinda-done`). The item falls back to the import default, but the
   * raw value is carried so the importer can REPORT it instead of the
   * information disappearing.
   */
  unrecognizedStatus?: string;
  /** Body markdown with bundle links restored to E3 `[[wiki-links]]`. */
  body: string;
  tags: string[];
  categories: string[];
  groups: string[];
  /** Space/topic slug or name. */
  space?: string;
  description?: string;

  // --- v0.2 families recovered for faithful re-export / trust surfacing ---
  /** How the content was produced (§5.2). */
  generated?: OkfActorEvent;
  /** Verification events, always normalized to a list (a bare mapping ⇒ one element). */
  verified?: OkfActorEvent[];
  /** Provenance entries (§5.1). */
  sources?: OkfSource[];
  /** Shared usage window framing `usage_count` signals. */
  usageWindow?: OkfUsageWindow;
  /** Absolute staleness date (`YYYY-MM-DD`). */
  staleAfter?: string;
  /** v0.2 lifecycle value (`draft|stable|deprecated`), distinct from E3 publish `status`. */
  lifecycle?: OkfLifecycle;

  /** Producer-defined frontmatter keys not mapped to E3 fields, preserved. */
  extraFrontmatter: Record<string, unknown>;
}

export interface BuildOptions {
  /** Subdirectory for concept files. Default `concepts`. */
  conceptDir?: string;
  /** Link rendering style. Default `dual`. */
  linkStyle?: LinkStyle;
  /** `type` used when a page declares none. Default `Knowledge Page`. */
  defaultType?: string;
  /** OKF version declared in the bundle-root index. Default `0.2`. */
  okfVersion?: string;
  /** Title shown in the bundle-root index. */
  bundleTitle?: string;
  /** Description shown in the bundle-root index. */
  bundleDescription?: string;
  /** Topic presentation profile, written as `presentation:` in the index frontmatter. */
  presentation?: 'portal' | 'blog' | 'docs' | 'wiki';
  /** Slug of the "Start here" item, written as `start_here:` in the index frontmatter. */
  startHere?: string;
  /** Landing-page prose, rendered in the index body before `## Concepts`. */
  landingMarkdown?: string;
  /**
   * Curated landing-page links, written as `links:` in the index frontmatter.
   * Authored by the curator in the bundle's own `index.md`, so the front page's
   * navigation travels with the content in git rather than living in the host.
   */
  links?: BundleLink[];
}

/**
 * One curated link on a topic's landing page. Exactly one destination:
 * `to` is an in-app route (`/sections`, `/p/onboarding`), `href` an external
 * URL. A link with neither, or with both, is not a link and is dropped.
 */
export interface BundleLink {
  label: string;
  to?: string;
  href?: string;
  description?: string;
}
