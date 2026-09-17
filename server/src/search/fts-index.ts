/**
 * `pages_fts` — what the full-text index holds, how much each column weighs,
 * and the one routine every write path uses to (re)build an item's row.
 *
 * Reader UX plan §5.4 (R3.3): the ranker already scores Topic, category and
 * group, but they were not FTS columns, so they were reachable only through the
 * taxonomy LIKE net — which runs only when the FTS pass under-fills a page. An
 * item's aliases were not reachable at all. They are all first-class columns
 * now; the net stays as a safety net rather than the only route.
 *
 * One definition, four callers: the boot migration (`upgradeFtsColumns`), the
 * live write paths in `PagesService`, `IndexRebuildService` (rebuild from git)
 * and the taxonomy renames in `SpacesService`. Every one builds the row with
 * `reindexPageFts`, reading the page, its current version and its taxonomy back
 * out of the database, so an item edited, renamed, moved, restored or rebuilt
 * from git ends up with byte-identical FTS text — there is no second recipe to
 * drift.
 *
 * The same call keeps `page_authors` (the `author:` filter's lookup table) in
 * step, because it is derived from the same frontmatter at the same moment and
 * a second hook on every write path would be a second thing to forget.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '../db/schema.js';
import { normalizeAuthor } from '@echozedlabs/search';
import { descriptionFromFrontmatter } from '../pages/description.js';

/**
 * The columns after `page_id`, in declaration order. New columns are appended —
 * never reordered — because FTS5's `bm25()` weights are positional.
 */
export const FTS_COLUMNS = ['title', 'body', 'tags', 'description', 'topic', 'categories', 'groups', 'aliases'] as const;
export type FtsColumn = (typeof FTS_COLUMNS)[number];

/**
 * bm25 weight per column — THE place the column ordering is decided.
 *
 *   title (10) > aliases (8) > tags (6) > topic = categories = groups (4) > description (3) > body (1)
 *
 * The name an item goes by, then the other names it goes by, then the curated
 * tag vocabulary, then where it is filed, then the author's one-line summary,
 * then prose. The weighted ranker (`packages/search` `FtsRecencyRanker`) makes
 * the final ordering; these weights decide which candidates reach it when a
 * broad query matches more items than the candidate window holds, and they feed
 * its `fts_rank` term — so an alias-only match (which the ranker has no field
 * for) still outranks the same word buried in a body.
 */
export const FTS_COLUMN_WEIGHTS: Record<FtsColumn, number> = {
  title: 10,
  aliases: 8,
  tags: 6,
  topic: 4,
  categories: 4,
  groups: 4,
  description: 3,
  body: 1,
};

/** `bm25(pages_fts, …)` with the weights above (lower is better, as FTS5 reports it). */
export function ftsBm25Sql(): RawBuilder<number> {
  // The leading 0 is `page_id`: UNINDEXED columns still take a positional weight.
  const weights = [0, ...FTS_COLUMNS.map((column) => FTS_COLUMN_WEIGHTS[column])];
  return sql<number>`bm25(pages_fts, ${sql.raw(weights.join(', '))})`;
}

/** The `CREATE VIRTUAL TABLE` for the current column set, under `table`. */
export function createFtsTableSql(table: string, opts: { ifNotExists?: boolean } = {}): RawBuilder<unknown> {
  return sql`
    CREATE VIRTUAL TABLE ${sql.raw(opts.ifNotExists ? 'IF NOT EXISTS ' : '')}${sql.raw(table)} USING fts5(
      page_id UNINDEXED,
      ${sql.raw(FTS_COLUMNS.join(',\n      '))},
      tokenize = 'porter unicode61'
    )
  `;
}

/** The searchable text an item contributes beyond its title and body. */
export interface FtsTaxonomyText {
  tags: string;
  description: string;
  topic: string;
  categories: string;
  groups: string;
  aliases: string;
  /**
   * Not an FTS column: the item's authors, normalized for `author:` and written
   * to `page_authors` (see `authorsFromFrontmatter`).
   */
  authors: string[];
}

export interface FtsDocument extends FtsTaxonomyText {
  page_id: string;
  title: string;
  body: string;
}

/** SQLite's bound-parameter ceiling is far above this; it just keeps IN lists short. */
const ID_CHUNK = 500;

/**
 * Rebuild the `pages_fts` rows of the given pages from what the database says
 * about them NOW. Call it after the page row, its current version and its
 * taxonomy rows are written, inside the same transaction.
 *
 * A soft-deleted (or missing) page ends with no row: search must not find it,
 * and a restore brings it back through this same call.
 */
export async function reindexPageFts(db: Kysely<Database>, pageIds: string | readonly string[]): Promise<void> {
  const ids = [...new Set(typeof pageIds === 'string' ? [pageIds] : pageIds)];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const docs = await ftsDocumentsFor(db, chunk);
    // `page_id` is UNINDEXED, so each DELETE scans the table: one statement per
    // chunk rather than one per page keeps a category rename linear.
    await sql`DELETE FROM pages_fts WHERE page_id IN (${sql.join(chunk)})`.execute(db);
    for (const doc of docs) await insertFtsRow(db, 'pages_fts', doc);
    await db.deleteFrom('page_authors').where('page_id', 'in', chunk).execute();
    await insertPageAuthors(db, docs);
  }
}

/** `page_authors` rows for documents whose old rows are already gone. */
export async function insertPageAuthors(db: Kysely<Database>, docs: { page_id: string; authors: string[] }[]): Promise<void> {
  const rows = docs.flatMap((doc) => doc.authors.map((author) => ({ page_id: doc.page_id, author })));
  // Batched under SQLite's bound-parameter ceiling (two per row).
  for (let i = 0; i < rows.length; i += ID_CHUNK) {
    await db.insertInto('page_authors').values(rows.slice(i, i + ID_CHUNK)).onConflict((oc) => oc.doNothing()).execute();
  }
}

/**
 * Every author an item names, normalized the way `author:` compares them: the
 * `authors` list and the single `author` string together, whitespace collapsed,
 * case folded with JavaScript's full-Unicode `toLowerCase` (SQLite's `lower()`
 * folds ASCII only, which is why the folded form is STORED rather than computed
 * in the query), de-duplicated. `normalizeAuthor` is the library's definition,
 * so this cannot drift from `InMemorySearchProvider`.
 */
export function authorsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const list = frontmatter['authors'];
  const single = frontmatter['author'];
  const names = [...(Array.isArray(list) ? list : []), ...(typeof single === 'string' ? [single] : [])];
  return [...new Set(names.filter((name): name is string => typeof name === 'string').map(normalizeAuthor).filter(Boolean))];
}

/**
 * Reindex every live page that matches `where` — the taxonomy renames use this
 * ("pages in this Topic", "pages filed under this category").
 */
export async function reindexPagesFtsWhere(db: Kysely<Database>, where: RawBuilder<boolean>): Promise<number> {
  const rows = await sql<{ id: string }>`SELECT p.id AS id FROM pages p WHERE p.deleted_at IS NULL AND ${where}`.execute(db);
  const ids = rows.rows.map((row) => row.id);
  if (ids.length) await reindexPageFts(db, ids);
  return ids.length;
}

export async function insertFtsRow(db: Kysely<Database>, table: string, doc: Omit<FtsDocument, 'authors'>): Promise<void> {
  await sql`
    INSERT INTO ${sql.raw(table)} (page_id, ${sql.raw(FTS_COLUMNS.join(', '))})
    VALUES (${doc.page_id}, ${sql.join(FTS_COLUMNS.map((column) => sql`${doc[column]}`))})
  `.execute(db);
}

/** Full FTS documents (title and body included) for live pages. */
export async function ftsDocumentsFor(db: Kysely<Database>, pageIds: readonly string[]): Promise<FtsDocument[]> {
  if (!pageIds.length) return [];
  const rows = await db
    .selectFrom('pages')
    .leftJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
    .select(['pages.id as id', 'pages.title as title', 'page_versions.body_markdown as body'])
    .where('pages.id', 'in', [...pageIds])
    .where('pages.deleted_at', 'is', null)
    .execute();
  const taxonomy = await ftsTaxonomyFor(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    page_id: row.id,
    title: row.title,
    body: row.body ?? '',
    ...(taxonomy.get(row.id) ?? emptyTaxonomyText()),
  }));
}

/**
 * Everything but title and body, for a batch of pages, in four set-based
 * queries (never one per page): tags, description and aliases from the stored
 * frontmatter and tag rows; Topic, category and group NAMES from their tables.
 *
 * Names are indexed alongside the stored keys because readers type the label
 * they see ("Incident Response"), while the item stores the key
 * (`incident-response`); when the two tokenize the same, only one is kept so a
 * word is not counted twice by bm25.
 */
export async function ftsTaxonomyFor(db: Kysely<Database>, pageIds: readonly string[]): Promise<Map<string, FtsTaxonomyText>> {
  const result = new Map<string, FtsTaxonomyText>();
  if (!pageIds.length) return result;
  const ids = [...pageIds];
  // Sequential, not Promise.all: this runs inside write transactions, which
  // hold one connection.
  const pages = await db
    .selectFrom('pages')
    .leftJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
    .leftJoin('spaces', 'spaces.id', 'pages.space_id')
    .select(['pages.id as id', 'page_versions.frontmatter_json as frontmatter_json', 'spaces.name as space_name'])
    .where('pages.id', 'in', ids)
    .execute();
  const tags = await db.selectFrom('page_tags').select(['page_id', 'tag']).where('page_id', 'in', ids).orderBy('tag').execute();
  const categories = await db
    .selectFrom('page_categories')
    .leftJoin('primary_categories', 'primary_categories.slug', 'page_categories.category')
    .select(['page_categories.page_id as page_id', 'page_categories.category as category', 'primary_categories.name as name'])
    .where('page_categories.page_id', 'in', ids)
    .orderBy('page_categories.category')
    .execute();
  const groups = await db
    .selectFrom('page_groups')
    .innerJoin('groups', 'groups.id', 'page_groups.group_id')
    .select(['page_groups.page_id as page_id', 'groups.slug as slug', 'groups.name as name'])
    .where('page_groups.page_id', 'in', ids)
    .orderBy('groups.slug')
    .execute();

  const collect = new Map<string, { tags: string[]; categories: string[]; groups: string[] }>();
  const bucket = (id: string) => {
    let entry = collect.get(id);
    if (!entry) collect.set(id, (entry = { tags: [], categories: [], groups: [] }));
    return entry;
  };
  for (const row of tags) bucket(row.page_id).tags.push(row.tag);
  for (const row of categories) bucket(row.page_id).categories.push(row.category, row.name ?? '');
  for (const row of groups) bucket(row.page_id).groups.push(row.name, row.slug);

  for (const page of pages) {
    const frontmatter = parseFrontmatter(page.frontmatter_json);
    const lists = collect.get(page.id);
    result.set(page.id, {
      tags: (lists?.tags ?? []).join(' '),
      description: descriptionFromFrontmatter(frontmatter),
      // The Topic's CURRENT name only. Frontmatter `topic` is how a file names
      // the Topic it is filed under (resolved to the row by slug or name), so
      // after an admin renames the Topic the file still carries the old name —
      // indexing it would keep the old name finding the item.
      topic: page.space_name ?? '',
      categories: distinctText(lists?.categories ?? []),
      groups: distinctText(lists?.groups ?? []),
      aliases: distinctText(aliasesFromFrontmatter(frontmatter)),
      authors: authorsFromFrontmatter(frontmatter),
    });
  }
  return result;
}

/**
 * Frontmatter `aliases` — the other names an item goes by (`MQTT` for "Message
 * Queuing Telemetry Transport"). A list of strings, or one string; anything
 * else is ignored rather than rejected, because the index must never refuse a
 * file the store accepted.
 */
export function aliasesFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter['aliases'];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function emptyTaxonomyText(): FtsTaxonomyText {
  return { tags: '', description: '', topic: '', categories: '', groups: '', aliases: '', authors: [] };
}

/** Values joined for indexing, dropping blanks and ones that tokenize like an earlier value. */
function distinctText(values: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.join(' ');
}

function parseFrontmatter(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
