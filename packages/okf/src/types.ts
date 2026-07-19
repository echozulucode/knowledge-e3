/**
 * Open Knowledge Format (OKF) v0.1 types for exporting Knowledge E3 content.
 *
 * OKF (https://cloud.google.com/.../open-knowledge-format) represents knowledge as a
 * directory of Markdown "concept" files with YAML frontmatter. The only required
 * frontmatter field is `type`; everything else is recommended or producer-defined.
 * See docs/okf-study/ for the format study this implements.
 */

/** OKF concept frontmatter. `type` is the only required field per the spec. */
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
  /** ISO 8601 datetime of last meaningful change. */
  timestamp?: string;
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

export interface OkfBundle {
  files: BundleFile[];
}

export interface ConformanceIssue {
  path: string;
  severity: 'critical' | 'warning';
  message: string;
}

export interface ConformanceReport {
  conformant: boolean;
  issues: ConformanceIssue[];
  conceptCount: number;
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
  /** OKF version declared in the bundle-root index. Default `0.1`. */
  okfVersion?: string;
  /** Title shown in the bundle-root index. */
  bundleTitle?: string;
  /** Description shown in the bundle-root index. */
  bundleDescription?: string;
}
