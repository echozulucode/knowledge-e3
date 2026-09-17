import { parse } from '@echozedlabs/codec';
import type {
  BundleLink,
  OkfActorEvent,
  OkfImportItem,
  OkfSource,
  OkfUsageWindow,
} from './types.js';
import { normalizeLifecycle } from './lifecycle.js';

/** OKF-standard frontmatter keys that should not leak back into E3 frontmatter. */
const OKF_KEYS = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'];
/**
 * OKF v0.2 frontmatter families consumed into dedicated {@link OkfImportItem}
 * fields (below) rather than preserved verbatim, so they are handled once and not
 * duplicated into `extraFrontmatter`. The Attested-Computation contract keys
 * (`runtime`/`parameters`/`computation`/`executor`/`attester`) are intentionally
 * NOT listed: they are preserved as-is for passthrough round-trip.
 */
const V02_KEYS = ['generated', 'verified', 'sources', 'usage_window', 'stale_after'];
/** E3 extension keys emitted on export; read back explicitly, not re-injected. */
const E3_EXT_KEYS = [
  'e3_id',
  'e3_slug',
  'e3_status',
  'e3_space',
  'e3_categories',
  'e3_groups',
  'e3_owner_id',
  'e3_created_at',
];
/** E3 frontmatter keys we reconstruct from dedicated fields. */
// Keys consumed into E3 fields rather than preserved verbatim. `state` joins
// `status` here so a resolved lifecycle value is represented exactly once, under
// E3's canonical `status` key (see toE3Frontmatter) — otherwise a file could
// carry `state: released` AND a generated `status: published`, which silently
// diverge the moment someone edits only one of them.
const MAPPED_KEYS = ['status', 'state', 'categories', 'groups', 'space', 'topic', 'summary'];

const RESERVED = new Set(['index.md', 'log.md']);

const PRESENTATIONS = ['portal', 'blog', 'docs', 'wiki'] as const;

/** Topic presentation recovered from a bundle-root `index.md` (see `renderBundleIndex`). */
export interface BundleIndexInfo {
  presentation?: (typeof PRESENTATIONS)[number];
  start_here?: string;
  landing_markdown?: string;
  /** Curated landing-page links, in authored order; omitted when none survive validation. */
  links?: BundleLink[];
}

/**
 * The most links one landing page will carry. A curated row is a handful of
 * destinations; a file that somehow lists hundreds is a mistake, and truncating
 * it keeps the landing page renderable instead of unusable.
 */
const MAX_LINKS = 24;

/** In-app destinations only: a single leading `/`, never protocol-relative (`//host`). */
const IN_APP_ROUTE = /^\/(?!\/)/;
/** External destinations: the schemes a landing-page link may legitimately use. */
const EXTERNAL_HREF = /^(?:https?:|mailto:)/i;

/**
 * Read the topic presentation back out of a bundle-root `index.md`: the
 * `presentation:` / `start_here:` / `links:` frontmatter keys, and the landing
 * prose — the body before `## Concepts`, minus the title line and the description
 * quote that `renderBundleIndex` emits ahead of it. Absent or malformed values are
 * omitted, so a hand-edited index never fails to parse.
 */
export function parseBundleIndex(indexMd: string): BundleIndexInfo {
  const parsed = parse(indexMd);
  const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  const out: BundleIndexInfo = {};
  const presentation = str(fm['presentation']);
  if (presentation && (PRESENTATIONS as readonly string[]).includes(presentation)) {
    out.presentation = presentation as BundleIndexInfo['presentation'];
  }
  const startHere = str(fm['start_here']);
  if (startHere) out.start_here = startHere;
  const links = bundleLinks(fm['links']);
  if (links.length) out.links = links;

  const prose = parsed.body.split(/^## Concepts\s*$/m)[0] ?? '';
  const lines = prose.split(/\r?\n/);
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  if (lines[0]?.startsWith('# ')) lines.shift();
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  if (lines[0]?.startsWith('> ')) lines.shift();
  const landing = lines.join('\n').trim();
  if (landing) out.landing_markdown = landing;
  return out;
}

/**
 * Curated landing-page links from the index frontmatter's `links:` sequence.
 *
 * Hand-authored YAML, so every entry is validated and a bad one is *dropped*
 * rather than thrown: a typo in one link must never cost the site its front
 * page. An entry needs a label and exactly one destination — an in-app `to`
 * route or an external `href` — which is also what keeps `javascript:` and
 * `data:` out of an anchor the whole company clicks.
 */
function bundleLinks(value: unknown): BundleLink[] {
  if (!Array.isArray(value)) return [];
  const out: BundleLink[] = [];
  for (const raw of value) {
    if (out.length >= MAX_LINKS) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const label = str(entry['label']) ?? str(entry['title']);
    if (!label) continue;
    const to = str(entry['to']);
    const href = str(entry['href']);
    // Exactly one destination: two would make the rendered anchor ambiguous.
    if ((to && href) || (!to && !href)) continue;
    if (to && !IN_APP_ROUTE.test(to)) continue;
    if (href && !EXTERNAL_HREF.test(href)) continue;
    const description = str(entry['description']);
    out.push({
      label,
      ...(to ? { to } : { href: href! }),
      ...(description ? { description } : {}),
    });
  }
  return out;
}

/**
 * Restore E3 `[[wiki-links]]` from OKF link forms produced on export.
 *
 * - `dual`  → `[[Title]] ([Title](/concepts/x.md))` collapses back to `[[Title]]`.
 * - `markdown` → `[Title](/concepts/x.md)` becomes `[[Title]]`.
 * - `preserve` → already `[[Title]]`; both passes are no-ops.
 *
 * Targets only bundle-relative concept links (`/…/*.md`). For round-tripping a
 * bundle that was itself produced from E3, prefer the `preserve` or `markdown`
 * export styles; `dual` is best-effort.
 */
export function restoreWikiLinks(body: string): string {
  // 1) Collapse dual links: keep the wiki-link, drop the appended markdown link
  //    (any non-external `.md` target — bundle-relative or relative).
  let out = body.replace(
    /(\[\[[^\]\n]+?\]\])\s*\(\[[^\]\n]*?\]\((?!https?:)[^)\n]*?\.md[^)\n]*?\)\)/g,
    '$1',
  );
  // 2) Convert standalone concept links to wiki-links, keyed on the link text.
  //    Covers bundle-relative (`/concepts/x.md`), relative (`x.md`,
  //    `../dir/x.md`), and anchored/titled forms; external http(s) links are
  //    left intact so real web references survive.
  out = out.replace(/\[([^\]\n]+?)\]\((?!https?:)[^)\n]*?\.md[^)\n]*?\)/g, '[[$1]]');
  return out;
}

/** Recover an importable E3 item from a single OKF concept document. */
export function conceptToImport(content: string): OkfImportItem {
  const parsed = parse(content);
  const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;

  const e3Id = str(fm['e3_id']);
  const slug = str(fm['e3_slug']);
  const title = str(fm['title']) ?? slugToTitle(slug) ?? 'Untitled';
  const { status, unrecognized: unrecognizedStatus } = resolveStatus(fm);
  const tags = arr(fm['tags']);
  const categories = arr(fm['e3_categories'] ?? fm['categories']);
  const groups = arr(fm['e3_groups'] ?? fm['groups']);
  const space = str(fm['e3_space'] ?? fm['space'] ?? fm['topic']);
  const ownerId = str(fm['e3_owner_id']);
  const createdAt = isoStr(fm['e3_created_at']);
  // v0.2 trust/provenance/lifecycle, recovered for faithful re-export.
  const generated = readActorEvent(fm['generated']);
  // Prefer `generated.at`; fall back to a legacy `timestamp` (spec §13.1).
  const updatedAt = generated?.at ?? isoStr(fm['timestamp']);
  const verified = readVerified(fm['verified']);
  const sources = readSources(fm['sources']);
  const usageWindow = readUsageWindow(fm['usage_window']);
  const staleAfter = dateStr(fm['stale_after']);
  const lifecycle = normalizeLifecycle(fm['status']);
  const description = str(fm['description'] ?? fm['summary']);
  const body = restoreWikiLinks(parsed.body);

  const skip = new Set([...OKF_KEYS, ...V02_KEYS, ...E3_EXT_KEYS, ...MAPPED_KEYS, 'tags']);
  const extraFrontmatter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!skip.has(k)) extraFrontmatter[k] = v;
  }

  const item: OkfImportItem = { title, body, tags, categories, groups, extraFrontmatter };
  if (e3Id) item.e3Id = e3Id;
  if (slug) item.slug = slug;
  if (ownerId) item.ownerId = ownerId;
  if (createdAt) item.createdAt = createdAt;
  if (updatedAt) item.updatedAt = updatedAt;
  if (status) item.status = status;
  if (unrecognizedStatus) item.unrecognizedStatus = unrecognizedStatus;
  if (space) item.space = space;
  if (description) item.description = description;
  if (generated) item.generated = generated;
  if (verified) item.verified = verified;
  if (sources) item.sources = sources;
  if (usageWindow) item.usageWindow = usageWindow;
  if (staleAfter) item.staleAfter = staleAfter;
  if (lifecycle) item.lifecycle = lifecycle;
  return item;
}

/** Recover importable items from a whole bundle's files (reserved files skipped). */
export function parseBundleFiles(files: { path: string; content: string }[]): OkfImportItem[] {
  const items: OkfImportItem[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue;
    const base = file.path.split('/').pop() ?? file.path;
    if (RESERVED.has(base)) continue;
    items.push(conceptToImport(file.content));
  }
  return items;
}

const ASSET_PREFIX = 'assets/';
const DESCRIPTOR_SUFFIX = '.meta.json';

/** A binary asset recovered from a full-fidelity bundle, ready to re-register. */
export interface ImportedAsset {
  /** Content-addressed file name (the basename under `assets/`), e.g. `a1b2c3d4.png`. */
  file: string;
  bytes: Uint8Array;
  /** The parsed sidecar descriptor, when the bundle carried one. */
  descriptor?: Record<string, unknown>;
}

/**
 * Recover binary assets from a bundle's entries. Bytes arrive in the `assets`
 * channel (`assets/<file>`); their sidecar descriptors arrive as text among
 * `files` (`assets/<file>.meta.json`). Each byte entry is paired with its
 * descriptor by file name. Descriptor sidecars without matching bytes, and
 * nested/odd paths, are ignored — a partial bundle degrades cleanly rather than
 * importing an asset with no bytes.
 */
export function parseBundleAssets(
  files: { path: string; content: string }[],
  assets: { path: string; bytes: Uint8Array }[],
): ImportedAsset[] {
  const descriptors = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    if (!f.path.startsWith(ASSET_PREFIX) || !f.path.endsWith(DESCRIPTOR_SUFFIX)) continue;
    const file = f.path.slice(ASSET_PREFIX.length, -DESCRIPTOR_SUFFIX.length);
    if (!file || file.includes('/')) continue;
    try {
      const parsed = JSON.parse(f.content);
      if (parsed && typeof parsed === 'object') descriptors.set(file, parsed as Record<string, unknown>);
    } catch {
      // A corrupt sidecar just means the bytes import without descriptor metadata.
    }
  }
  const out: ImportedAsset[] = [];
  for (const a of assets) {
    if (!a.path.startsWith(ASSET_PREFIX)) continue;
    const file = a.path.slice(ASSET_PREFIX.length);
    // Flat `assets/` dir only, and never treat a sidecar as its own asset.
    if (!file || file.includes('/') || file.endsWith(DESCRIPTOR_SUFFIX)) continue;
    out.push({ file, bytes: a.bytes, descriptor: descriptors.get(file) });
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Coerce a timestamp value to an ISO string. YAML parses an unquoted ISO 8601
 * datetime into a `Date`, so a round-tripped `timestamp`/`e3_created_at` arrives
 * as a Date rather than a string.
 */
function isoStr(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

function arr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Coerce a date value to a `YYYY-MM-DD` string. Unquoted YAML dates
 * (`stale_after: 2026-09-23`, `last_modified: 2026-05-30`) parse to a `Date`.
 */
function dateStr(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return str(value);
}

/** Read a `{ by, at }` actor event; `by` is required, `at` is coerced to ISO. */
function readActorEvent(value: unknown): OkfActorEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const by = str(rec['by']);
  if (!by) return undefined;
  const at = isoStr(rec['at']);
  return at ? { by, at } : { by };
}

/**
 * Read `verified` as a list of events. A single verifier MAY be written as a bare
 * `{ by, at }` mapping; consumers MUST treat it as a one-element list (spec §5.2/§11).
 */
function readVerified(value: unknown): OkfActorEvent[] | undefined {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const events = list.map(readActorEvent).filter((e): e is OkfActorEvent => e !== undefined);
  return events.length > 0 ? events : undefined;
}

/** Read a `{ from, to }` usage window. */
function readUsageWindow(value: unknown): OkfUsageWindow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const from = dateStr(rec['from']);
  const to = dateStr(rec['to']);
  if (!from && !to) return undefined;
  const window: OkfUsageWindow = {};
  if (from) window.from = from;
  if (to) window.to = to;
  return window;
}

/** Read the `sources` provenance list; entries without a `resource` are dropped. */
function readSources(value: unknown): OkfSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: OkfSource[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const resource = str(rec['resource']);
    if (!resource) continue; // `resource` is required within an entry (§5.1)
    const source: OkfSource = { resource };
    const id = str(rec['id']);
    const title = str(rec['title']);
    const author = str(rec['author']);
    const usageCount = num(rec['usage_count']);
    const lastModified = dateStr(rec['last_modified']);
    const window = readUsageWindow(rec['usage_window']);
    if (id) source.id = id;
    if (title) source.title = title;
    if (author) source.author = author;
    if (usageCount !== undefined) source.usage_count = usageCount;
    if (lastModified) source.last_modified = lastModified;
    if (window) source.usage_window = window;
    out.push(source);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Vocabulary a hand-authored bundle may use for lifecycle state.
 *
 * E3 itself only has `draft` | `published`, but bundles are written by humans
 * and other tools, which reach for words like `released` or `wip`. Previously
 * anything outside the two exact strings was silently discarded and the item
 * fell back to the import default — so `state: released` imported as a draft and
 * simply never appeared. Unrecognised values still fall back, but the caller is
 * told (see statusOf), rather than the information vanishing.
 */
const STATUS_SYNONYMS: Record<string, 'draft' | 'published'> = {
  published: 'published',
  release: 'published',
  released: 'published',
  live: 'published',
  final: 'published',
  // v0.2 lifecycle values map onto E3's binary visibility: `stable` is ready for
  // consumption ⇒ published; `deprecated` is kept for links/history but still
  // visible ⇒ published (the distinct lifecycle value is carried on
  // OkfImportItem.lifecycle so `deprecated` is not lost).
  stable: 'published',
  deprecated: 'published',
  draft: 'draft',
  wip: 'draft',
  'in-progress': 'draft',
  in_progress: 'draft',
  unreleased: 'draft',
  unpublished: 'draft',
};

export interface StatusResolution {
  status?: 'draft' | 'published';
  /** The raw value we could not interpret, when there was one. */
  unrecognized?: string;
}

/**
 * Resolve lifecycle state from frontmatter, in precedence order:
 * `e3_status` (what E3 writes on export) → `status` → `state`.
 * Matching is case- and whitespace-insensitive.
 */
export function resolveStatus(fm: Record<string, unknown>): StatusResolution {
  for (const key of ['e3_status', 'status', 'state']) {
    const raw = fm[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const normalized = String(raw).trim().toLowerCase();
    const mapped = STATUS_SYNONYMS[normalized];
    if (mapped) return { status: mapped };
    return { unrecognized: String(raw) };
  }
  return {};
}

function slugToTitle(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
