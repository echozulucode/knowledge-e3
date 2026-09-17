/**
 * Identity of an **imported** file — one a source's `include_globs` brought in
 * rather than the canonical `concepts/` layout (plan §8.3).
 *
 * Such a file is ordinary Markdown: it usually carries no `e3_id`, no `type`
 * and often no `title`. Two paths have to turn it into the same item:
 *
 *  - `InboundIndexService.prepareImport`, on every fetch/merge, and
 *  - `IndexRebuildService`, when the derived index is dropped and rebuilt from
 *    the files alone (issue 94 — before which the rebuild did not even see
 *    these files).
 *
 * They must agree on the id, the type and the title or a rebuild would re-mint
 * ids and re-type content, so the rule lives here once and both call it.
 *
 * Only the two keys that cannot be derived from the file — `e3_id` and
 * `e3_created_at`, the moment the path was first indexed — are ever recorded,
 * and even those never in a `reference` source's working tree: they go into the
 * file for an `authoritative` source and into `.e3/ids.json` beside the clone
 * otherwise. `type` and `title` are derived in memory on every pass, so the
 * file stays the author's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '@echozedlabs/codec';
import { toPosix } from '@echozedlabs/content-store';

/** Directory (inside the working tree, git-ignored locally) holding the import id map. */
export const E3_DIR = '.e3';
export const IDS_FILE = 'ids.json';

/**
 * What one source's `.e3/ids.json` records about the paths it has indexed:
 * the id assigned to each, and when it was first indexed.
 *
 * `created` is a **sibling** map, not a change to `ids`, so the file stays
 * readable by (and compatible with) the id-only form it had before.
 */
export interface ImportIds {
  /** `path → e3_id`. */
  ids: Record<string, string>;
  /** `path → e3_created_at`; may be missing for a path recorded before this was kept. */
  created: Record<string, string>;
}

export interface ImportDefaults {
  /**
   * The id this path already owns — from `.e3/ids.json`, or from the row
   * indexed under this path. Ignored when the file carries its own `e3_id`.
   */
  id?: string | null;
  /**
   * When this path was first indexed. Ignored when the file carries its own
   * `e3_created_at`. Without it a rebuild would date an imported item at the
   * moment of the rebuild, which also re-orders the feed.
   */
  createdAt?: string | null;
  /** The source's `default_type`, applied when the file names no type. */
  defaultType?: string | null;
}

/** The `e3_*` identity keys this file already carries. */
export function importCarries(raw: string): { id: boolean; createdAt: boolean } {
  const fm = parseSafe(raw).frontmatter;
  return { id: isNonEmptyString(fm['e3_id']), createdAt: isNonEmptyString(fm['e3_created_at']) };
}

/** True when the file itself carries an `e3_id` (so no id has to be assigned). */
export function importCarriesId(raw: string): boolean {
  return importCarries(raw).id;
}

/**
 * The identity keys to write back into an imported file — only those it does
 * not already have, since `stampFrontmatter` appends blindly. Empty when the
 * file already records both.
 */
export function identityStampEntries(raw: string, id: string, createdAt: string): [string, string][] {
  const carries = importCarries(raw);
  const entries: [string, string][] = [];
  if (!carries.id) entries.push(['e3_id', id]);
  if (!carries.createdAt) entries.push(['e3_created_at', createdAt]);
  return entries;
}

/**
 * The frontmatter an imported file is indexed with, added **in memory only**:
 *
 *  - `e3_id`: `opts.id`, so re-syncing (or a rebuild) never mints a second id.
 *  - `e3_created_at`: `opts.createdAt`, so a rebuild dates the item when it was
 *    first indexed rather than when the rebuild ran.
 *  - `type`: the source's `default_type`, when the file names none.
 *  - `title`: the first `# heading`, else the file name — otherwise every
 *    untitled import indexes as "Untitled".
 *
 * Nothing is ever overwritten: only keys the file does not have are added.
 */
export function stampImportFrontmatter(
  raw: string,
  path: string,
  opts: ImportDefaults = {},
): { raw: string; hadId: boolean } {
  const parsed = parseSafe(raw);
  const fm = parsed.frontmatter;
  const hadId = isNonEmptyString(fm['e3_id']);
  const entries: [string, string][] = [];
  if (!hadId && opts.id) entries.push(['e3_id', opts.id]);
  if (!isNonEmptyString(fm['e3_created_at']) && opts.createdAt) entries.push(['e3_created_at', opts.createdAt]);
  if (opts.defaultType && !isNonEmptyString(fm['type'])) entries.push(['type', opts.defaultType]);
  if (!isNonEmptyString(fm['title'])) entries.push(['title', titleFrom(parsed.body, path)]);
  return { raw: stampFrontmatter(raw, entries), hadId };
}

/**
 * `.e3/ids.json` beside a source's clone, tolerantly: absent, empty or
 * malformed all read as "no ids yet". This is where a `reference` source keeps
 * its ids, because its working tree must stay clean — and therefore where a
 * rebuild has to look to give an imported file back the id it had.
 */
export function readIdMap(dir: string, onWarn?: (message: string) => void): ImportIds {
  const map: ImportIds = { ids: {}, created: {} };
  const file = join(dir, E3_DIR, IDS_FILE);
  if (!existsSync(file)) return map;
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.trim()) return map;
    const parsed = JSON.parse(text) as unknown;
    const doc = isRecord(parsed) ? parsed : {};
    // `{ version, source, ids, created }`, or the bare `{ path: id }` form.
    const ids = isRecord(doc['ids']) ? doc['ids'] : doc;
    for (const [k, v] of Object.entries(ids)) {
      if (typeof v === 'string' && v.trim()) map.ids[toPosix(k)] = v.trim();
    }
    const created = isRecord(doc['created']) ? doc['created'] : {};
    for (const [k, v] of Object.entries(created)) {
      if (typeof v === 'string' && v.trim()) map.created[toPosix(k)] = v.trim();
    }
  } catch (err) {
    onWarn?.(`ignoring unreadable ${E3_DIR}/${IDS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}

/** The `{ version, source, ids, created }` document written to `.e3/ids.json` (keys sorted). */
export function serializeIdMap(sourceId: string, map: ImportIds): string {
  const ids: Record<string, string> = {};
  for (const key of Object.keys(map.ids).sort()) ids[key] = map.ids[key]!;
  const created: Record<string, string> = {};
  for (const key of Object.keys(map.created).sort()) {
    if (ids[key]) created[key] = map.created[key]!;
  }
  return `${JSON.stringify({ version: 1, source: sourceId, ids, created }, null, 2)}\n`;
}

/**
 * Status for an imported file that declares none — the source's
 * `default_status`, else the instance default. The same fallback
 * `ContentCommands.indexFromFile` applies on the sync path, so a rebuild does
 * not silently publish what the sync left a draft.
 */
export function importedStatus(
  declared: 'draft' | 'published' | undefined,
  defaultStatus: 'draft' | 'published' | null | undefined,
): 'draft' | 'published' {
  return declared ?? defaultStatus ?? instanceDefaultImportStatus();
}

/** Same fallback the OKF importer uses for a file that declares no status. */
export function instanceDefaultImportStatus(): 'draft' | 'published' {
  return process.env['KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS'] === 'published' ? 'published' : 'draft';
}

/**
 * Add frontmatter keys to a Markdown file without reformatting it: the lines go
 * in at the end of an existing `---` block, or a new block is prepended. Never
 * overwrites a key — callers pass only keys the file does not have.
 */
export function stampFrontmatter(raw: string, entries: [string, string][]): string {
  if (!entries.length) return raw;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const added = entries.map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '---') {
        lines.splice(i, 0, ...added);
        return lines.join(eol);
      }
    }
  }
  return `---${eol}${added.join(eol)}${eol}---${eol}${eol}${raw}`;
}

/** A title for an untitled import: the first `# heading`, else the file name. */
export function titleFrom(body: string, path: string): string {
  const heading = /^[ \t]{0,3}#[ \t]+(\S.*?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading) return heading[1]!.trim();
  return basename(toPosix(path))
    .replace(/\.md$/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Untitled';
}

/** Plain where it is unambiguous, double-quoted otherwise. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][\w .'()/-]*$/.test(value) ? value : JSON.stringify(value);
}

/** The file's frontmatter and body; a file that will not parse is all body. */
function parseSafe(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    const parsed = parse(raw);
    return { frontmatter: (parsed.frontmatter ?? {}) as Record<string, unknown>, body: parsed.body };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
