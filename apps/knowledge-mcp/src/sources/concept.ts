/**
 * A working-tree Markdown file as a knowledge item, mapped the way the server
 * maps it when it indexes the same file from git.
 *
 * Mirrors, in order:
 *  - `server/src/sync/import-identity.ts` `stampImportFrontmatter`/`titleFrom`
 *    for a file outside the `concepts/` layout (a title from the first heading
 *    or the file name; the id from `.e3/ids.json` when the server recorded one);
 *  - `@echozedlabs/okf` `conceptToImport` for the OKF → E3 field recovery;
 *  - `server/src/okf/okf-frontmatter.ts` `toE3Frontmatter` and
 *    `server/src/storage/index-rebuild.service.ts` `e3FrontmatterOf`/`bodyOf`
 *    for the frontmatter corrections (`type`, `description`, `stale_after`,
 *    synthesized provenance) and the stored body;
 *  - `server/src/pages/taxonomy.ts` for tags/categories/groups normalization
 *    and `lifecycle-columns`' derived display state.
 *
 * Deliberate differences, because there is no database here: an id-less file
 * gets a stable path-derived id instead of a minted one; a file that declares
 * no status takes the source's `default_status` (default `published`, so a
 * plain notes folder is searchable without `include_drafts`); `updated_at`
 * falls back to the file's modification time rather than a git commit date.
 */
import { parse } from '@echozedlabs/codec';
import { canonicalTypeLabel, deriveDisplayState } from '@echozedlabs/content-model';
import { isConceptPath, slugFromPath } from '@echozedlabs/content-store';
import type { ItemView, LifecycleSignals, PublicationStatus } from '@echozedlabs/knowledge-types';
import { conceptToImport, e3OwnerToActor, type OkfImportItem } from '@echozedlabs/okf';

export interface LocalItem extends ItemView, LifecycleSignals {
  /** Root-relative posix path of the file this item was read from. */
  file: string;
  /** Topic display name (the slug is `space_id`), or null. */
  topic_name: string | null;
  authors: string[];
  aliases: string[];
}

export interface ConceptContext {
  /** Root-relative posix path. */
  path: string;
  raw: string;
  mtime: Date;
  /** Topic for a file that names none. */
  defaultTopic?: string;
  defaultStatus: PublicationStatus;
  /** Ids the server recorded for imported paths (`.e3/ids.json`). */
  recordedIds?: Record<string, string>;
  now?: Date;
}

export function conceptToLocalItem(ctx: ConceptContext): LocalItem {
  const imported = !isConceptPath(ctx.path);
  const fileFm = safeFrontmatter(ctx.raw);
  // In memory only, as the server does for glob-imported files: never written back.
  const content = imported && !nonEmpty(fileFm['title']) ? withTitle(ctx.raw, titleFrom(safeBody(ctx.raw), ctx.path)) : ctx.raw;
  const item = conceptToImport(content);
  const fm = e3FrontmatterOf(safeFrontmatter(content), item, content);

  const topicName = asString(fm['space']) ?? asString(fm['topic']) ?? subtreeOf(ctx.path) ?? ctx.defaultTopic ?? null;
  if (topicName && !asString(fm['topic']) && !asString(fm['space'])) fm['topic'] = topicName;
  const status: PublicationStatus = item.status ?? ctx.defaultStatus;
  const body = item.body.replace(/^\n+/, '');
  const createdAt = item.createdAt ?? isoOf(fileFm['e3_created_at']) ?? ctx.mtime.toISOString();
  const updatedAt = isoOf(fileFm['timestamp']) ?? item.updatedAt ?? item.createdAt ?? ctx.mtime.toISOString();
  const publishedAt = isoOf(fm['published_at'] ?? fm['date']) ?? (status === 'published' ? createdAt : null);
  const signals = deriveDisplayState(fm, status, ctx.now);
  const id = item.e3Id ?? ctx.recordedIds?.[ctx.path] ?? pathId(ctx.path);

  return {
    id,
    slug: item.slug ?? slugFromPath(ctx.path),
    title: item.title,
    status,
    type: canonicalTypeLabel(asString(fm['type'])),
    space_id: topicName ? slugify(topicName) : null,
    topic: topicName ?? undefined,
    topic_name: topicName,
    description: asString(fm['description']) ?? asString(fm['summary']) ?? null,
    updated_at: updatedAt,
    published_at: publishedAt,
    owner_id: item.ownerId ?? null,
    created_at: createdAt,
    version_token: 1,
    current_version_id: null,
    body_markdown: body,
    raw_markdown: ctx.raw,
    frontmatter: fm,
    tags: stringList(fm['tags']),
    categories: stringList(fm['categories']),
    groups: [...new Set(stringList(fm['groups']).map(slugify).filter(Boolean))].sort(),
    authors: authorsOf(fm),
    aliases: aliasesOf(fm),
    file: ctx.path,
    ...signals,
  };
}

/** `toE3Frontmatter` (server/src/okf/okf-frontmatter.ts), then the rebuild's corrections against the file. */
function e3FrontmatterOf(file: Record<string, unknown>, item: OkfImportItem, content: string): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...item.extraFrontmatter, title: item.title };
  if (item.status) fm['status'] = item.status;
  if (item.tags.length > 0) fm['tags'] = item.tags;
  if (item.categories.length > 0) fm['categories'] = item.categories;
  if (item.groups.length > 0) fm['groups'] = item.groups;
  if (item.space) fm['topic'] = item.space;
  if (item.description) fm['summary'] = item.description;
  if (item.generated) fm['generated'] = item.generated;
  if (item.verified && item.verified.length > 0) fm['verified'] = item.verified;
  if (item.sources && item.sources.length > 0) fm['sources'] = item.sources;
  if (item.usageWindow) fm['usage_window'] = item.usageWindow;
  if (item.staleAfter) fm['stale_after'] = item.staleAfter;

  if (typeof file['type'] === 'string' && file['type'].trim()) fm['type'] = file['type'];
  if (file['description'] !== undefined && file['summary'] === undefined) {
    delete fm['summary'];
    fm['description'] = file['description'];
  }
  if (file['stale_after'] !== undefined) fm['stale_after'] = staleAfterAsAuthored(content, file['stale_after']);
  if (isSynthesizedProvenance(file)) delete fm['generated'];
  return JSON.parse(JSON.stringify(fm)) as Record<string, unknown>;
}

function staleAfterAsAuthored(content: string, parsed: unknown): unknown {
  if (!(parsed instanceof Date) || !content.startsWith('---')) return parsed;
  const end = content.indexOf('\n---', 3);
  const block = end < 0 ? content : content.slice(0, end);
  const m = /^stale_after:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m.exec(block);
  return m ? m[1] : parsed;
}

function isSynthesizedProvenance(file: Record<string, unknown>): boolean {
  const g = file['generated'];
  if (!g || typeof g !== 'object' || Array.isArray(g)) return false;
  const { by, at } = g as Record<string, unknown>;
  const owner = typeof file['e3_owner_id'] === 'string' ? file['e3_owner_id'] : undefined;
  return by === e3OwnerToActor(owner) && isoOf(at) === isoOf(file['timestamp']);
}

/** A title for an untitled import: the first `# heading`, else the file name (import-identity `titleFrom`). */
export function titleFrom(body: string, path: string): string {
  const heading = /^[ \t]{0,3}#[ \t]+(\S.*?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading) return heading[1]!.trim();
  const base = path.slice(path.lastIndexOf('/') + 1);
  return (
    base
      .replace(/\.md$/i, '')
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'Untitled'
  );
}

/** Add a `title` key without reformatting the file (import-identity `stampFrontmatter`). */
function withTitle(raw: string, title: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const line = `title: ${JSON.stringify(title)}`;
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '---') {
        lines.splice(i, 0, line);
        return lines.join(eol);
      }
    }
  }
  return `---${eol}${line}${eol}---${eol}${eol}${raw}`;
}

/** `<topic>/concepts/x.md` → `topic` (the shared main repo's subtree layout); null otherwise. */
function subtreeOf(path: string): string | null {
  const m = /^([^/]+)\/concepts\/[^/]+$/.exec(path);
  return m ? m[1]! : null;
}

/** A stable id for a file that carries none: its root-relative path without the extension. */
function pathId(path: string): string {
  return path.replace(/\.md$/i, '');
}

export function slugify(title: string): string {
  const normalised = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  return normalised || 'untitled';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))].sort();
}

function authorsOf(fm: Record<string, unknown>): string[] {
  const list = Array.isArray(fm['authors']) ? fm['authors'].filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
  const single = asString(fm['author']);
  return [...new Set([...list.map((v) => v.trim()), ...(single ? [single] : [])])];
}

function aliasesOf(fm: Record<string, unknown>): string[] {
  const value = fm['aliases'];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

function safeFrontmatter(raw: string): Record<string, unknown> {
  try {
    const fm = parse(raw).frontmatter;
    return fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeBody(raw: string): string {
  try {
    return parse(raw).body;
  } catch {
    return raw;
  }
}

function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
