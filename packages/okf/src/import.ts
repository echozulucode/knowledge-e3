import { parse } from '@echozedlabs/codec';
import type { OkfImportItem } from './types.js';

/** OKF-standard frontmatter keys that should not leak back into E3 frontmatter. */
const OKF_KEYS = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'];
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
  const updatedAt = isoStr(fm['timestamp']);
  const description = str(fm['description'] ?? fm['summary']);
  const body = restoreWikiLinks(parsed.body);

  const skip = new Set([...OKF_KEYS, ...E3_EXT_KEYS, ...MAPPED_KEYS, 'tags']);
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
  stable: 'published',
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
