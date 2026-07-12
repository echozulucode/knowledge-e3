import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import { conceptToImport, type OkfImportItem } from '@echozedlabs/okf';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import {
  ensureSpaceForFrontmatterInTx,
  serializeFromParts,
} from '../pages/pages.service.js';
import { toE3Frontmatter } from '../okf/okf-import.service.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from '../pages/taxonomy.js';
import { WikiService } from '../wiki/wiki.service.js';

const RESERVED = new Set(['index.md', 'log.md']);

/** One revision of a concept file: its content and (if known) commit time + author. */
interface Revision {
  content: string;
  dateIso?: string;
  authorEmail?: string;
}

interface RecoveredFile {
  slug: string;
  /** Oldest → newest. At least one entry (current working-tree content). */
  revisions: Revision[];
}

export interface RebuildReport {
  pages: number;
  /** Total page_versions rows reconstructed (> pages when history is replayed). */
  versions: number;
  links: number;
  /** Files that referenced an owner who no longer exists; reassigned to the rebuild actor. */
  reassignedOwners: number;
}

export interface RebuildOptions {
  /** User id used as author/owner when a file's embedded owner is missing or unknown. */
  actorId: string;
  /**
   * Replay each concept's full version history from its git commits, so
   * `page_versions` is reconstructed from git — not just the current state.
   * Requires the directory to be a git repository. Default false (current state).
   */
  replayHistory?: boolean;
}

/**
 * Phase B of the git-of-record pivot (see docs/adr/0001-git-of-record-storage.md):
 * the **rebuild-from-git path**. Given the OKF-conformant Markdown files in the git
 * working tree, drop the derived content tables and reconstruct the entire index —
 * pages, versions, taxonomy, links, and FTS — from the files alone.
 *
 * This is what makes the database genuinely *disposable*: the canonical record is
 * the files in git; the relational index is a cache that can be rebuilt at will.
 * The accompanying index-rebuild drill (server/tests) proves equivalence by
 * round-tripping a live store through git and back.
 *
 * Identity is preserved from the embedded `e3_*` keys (id, slug, owner, created_at),
 * so a rebuild reproduces the same item ids — backlinks, engagement, and audit rows
 * keyed on `page_id` stay valid across the rebuild.
 *
 * With `replayHistory`, the per-edit version chain is reconstructed from each file's
 * git commits (one `page_versions` row per commit that touched it), making git
 * history the canonical version store. Without it, only the current state is rebuilt
 * (one version per page). In both cases the derived indexes (taxonomy, links, FTS)
 * reflect the *current* content, exactly as a live write would leave them.
 *
 * Attribution note: replayed `created_by` is the owner embedded in each revision's
 * file (`e3_owner_id`), falling back to the rebuild actor — faithful per-edit
 * *editor* attribution would require recording the editor in each commit, a follow-on.
 */
@Injectable()
export class IndexRebuildService {
  private readonly logger = new Logger(IndexRebuildService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly wiki: WikiService,
  ) {}

  /** Rebuild the derived index from every concept file under a git working tree. */
  async rebuildFromDir(dir: string, opts: RebuildOptions): Promise<RebuildReport> {
    const recovered = conceptFiles(readConceptFiles(dir)).map((f) => ({
      slug: slugFromPath(f.path),
      revisions: opts.replayHistory
        ? gitFileRevisions(dir, f.path, f.content)
        : [{ content: f.content }],
    }));
    return this.load(recovered, opts.actorId);
  }

  /** Rebuild the derived index from an in-memory set of OKF concept files (current state only). */
  async rebuildFromFiles(
    files: { path: string; content: string }[],
    opts: { actorId: string },
  ): Promise<RebuildReport> {
    const recovered = conceptFiles(files).map((f) => ({
      slug: slugFromPath(f.path),
      revisions: [{ content: f.content }],
    }));
    return this.load(recovered, opts.actorId);
  }

  private async load(recovered: RecoveredFile[], actorId: string): Promise<RebuildReport> {
    const userRows = await this.db.selectFrom('users').select(['id', 'email']).execute();
    const knownUsers = new Set(userRows.map((u) => u.id));
    const emailToUser = new Map(
      userRows.filter((u) => u.email).map((u) => [u.email, u.id] as const),
    );
    const report: RebuildReport = { pages: 0, versions: 0, links: 0, reassignedOwners: 0 };

    // SQLite ignores PRAGMA foreign_keys inside a transaction, so toggle it at the
    // connection level around the bulk load — the standard pattern for a restore.
    // The connection-scoped setting persists across the inner transaction.
    await sql`PRAGMA foreign_keys = OFF`.execute(this.db);
    try {
      await this.db.transaction().execute(async (tx) => {
        await wipeDerivedTables(tx);
        for (const file of recovered) {
          const written = await this.reconstructItem(tx, file, actorId, knownUsers, emailToUser);
          report.pages += 1;
          report.versions += written.versions;
          report.links += written.links;
          if (written.reassignedOwner) report.reassignedOwners += 1;
        }
        // Engagement rows for pages no longer present in git would dangle.
        await sql`DELETE FROM page_views WHERE page_id NOT IN (SELECT id FROM pages)`.execute(tx);
      });
    } finally {
      await sql`PRAGMA foreign_keys = ON`.execute(this.db);
    }

    await this.assertReferentialIntegrity();
    this.logger.log(
      `rebuilt index: ${report.pages} page(s), ${report.versions} version(s), ${report.links} link(s)`,
    );
    return report;
  }

  private async reconstructItem(
    tx: Kysely<Database>,
    file: RecoveredFile,
    actorId: string,
    knownUsers: Set<string>,
    emailToUser: Map<string, string>,
  ): Promise<{ versions: number; links: number; reassignedOwner: boolean }> {
    const revisions = file.revisions;
    const latest = revisions[revisions.length - 1]!;
    const latestItem = conceptToImport(latest.content);

    const pageId = latestItem.e3Id ?? newId();
    const slug = latestItem.slug ?? file.slug ?? slugify(latestItem.title);
    const status: 'draft' | 'published' = latestItem.status ?? 'published';

    const versionIds = revisions.map(() => newId());

    // Reconstruct the version chain, oldest → newest.
    for (let i = 0; i < revisions.length; i += 1) {
      const rev = revisions[i]!;
      const revItem = conceptToImport(rev.content);
      const raw = serializeFromParts(toE3Frontmatter(revItem), revItem.body);
      const parsed = parse(raw);
      // created_by is the *editor* — prefer the git commit author, then the
      // owner embedded in the file, then the rebuild actor.
      const createdBy = resolveAuthor(rev, revItem, actorId, knownUsers, emailToUser);
      const createdAt = rev.dateIso ?? revItem.updatedAt ?? revItem.createdAt ?? nowIso();

      await tx
        .insertInto('page_versions')
        .values({
          id: versionIds[i]!,
          page_id: pageId,
          body_markdown: parsed.body,
          raw_markdown: raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: createdAt,
          created_by: createdBy,
          parent_version_id: i > 0 ? versionIds[i - 1]! : null,
        })
        .execute();
    }

    // The page row and every derived index reflect the latest revision. The page
    // *owner* is the owner embedded in the file (not necessarily the last editor).
    const latestParsed = parse(serializeFromParts(toE3Frontmatter(latestItem), latestItem.body));
    const spaceId = await ensureSpaceForFrontmatterInTx(tx, latestParsed.frontmatter);
    const owner = resolveOwner(latestItem, actorId, knownUsers);
    const reassignedOwner = owner.reassigned;
    const createdAt = revisions[0]!.dateIso ?? latestItem.createdAt ?? nowIso();
    const updatedAt = latest.dateIso ?? latestItem.updatedAt ?? createdAt;

    await tx
      .insertInto('pages')
      .values({
        id: pageId,
        slug,
        title: latestItem.title,
        status,
        owner_id: owner.ownerId,
        space_id: spaceId,
        created_at: createdAt,
        updated_at: updatedAt,
        deleted_at: null,
        version_token: revisions.length,
        current_version_id: versionIds[versionIds.length - 1]!,
      })
      .execute();

    const taxonomy = taxonomyFromFrontmatter(latestParsed.frontmatter);
    await syncTaxonomyInTx(tx, pageId, taxonomy);

    const links = extractItemLinks(latestParsed);
    await this.wiki.indexInTx(tx, pageId, links);
    await indexFts(tx, pageId, latestItem.title, latestParsed.body, taxonomy.tags);

    return { versions: revisions.length, links: links.length, reassignedOwner };
  }

  /** A clean rebuild must leave no dangling references. */
  private async assertReferentialIntegrity(): Promise<void> {
    const result = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(this.db);
    if (result.rows.length > 0) {
      throw new Error(
        `index rebuild left ${result.rows.length} dangling reference(s); first: ${JSON.stringify(result.rows[0])}`,
      );
    }
  }
}

/** Resolve a page's owner from its embedded id, falling back to the rebuild actor. */
function resolveOwner(
  item: OkfImportItem,
  actorId: string,
  knownUsers: Set<string>,
): { ownerId: string; reassigned: boolean } {
  if (item.ownerId && knownUsers.has(item.ownerId)) return { ownerId: item.ownerId, reassigned: false };
  return { ownerId: actorId, reassigned: Boolean(item.ownerId) };
}

/**
 * Resolve a version's *editor* (`created_by`): prefer the git commit author
 * mapped to a user, then the owner embedded in the file, then the rebuild actor.
 */
function resolveAuthor(
  rev: Revision,
  item: OkfImportItem,
  actorId: string,
  knownUsers: Set<string>,
  emailToUser: Map<string, string>,
): string {
  if (rev.authorEmail) {
    const uid = emailToUser.get(rev.authorEmail);
    if (uid) return uid;
  }
  return resolveOwner(item, actorId, knownUsers).ownerId;
}

/** Delete every table whose contents are derived from the canonical files. */
async function wipeDerivedTables(tx: Kysely<Database>): Promise<void> {
  await tx.deleteFrom('page_groups').execute();
  await tx.deleteFrom('page_tags').execute();
  await tx.deleteFrom('page_categories').execute();
  await tx.deleteFrom('item_links').execute();
  await tx.deleteFrom('wikilinks').execute();
  await tx.deleteFrom('revision_mirror_state').execute();
  await tx.deleteFrom('page_versions').execute();
  await tx.deleteFrom('pages').execute();
  await tx.deleteFrom('groups').execute();
  await tx.deleteFrom('spaces').where('id', '!=', 'space_default').execute();
  await sql`DELETE FROM pages_fts`.execute(tx);
}

async function indexFts(
  db: Kysely<Database>,
  pageId: string,
  title: string,
  body: string,
  tags: string[],
): Promise<void> {
  await sql`DELETE FROM pages_fts WHERE page_id = ${pageId}`.execute(db);
  await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${pageId}, ${title}, ${body}, ${tags.join(' ')})`.execute(db);
}

/**
 * The ordered revisions of one concept file from git history (oldest → newest).
 * Falls back to the current working-tree content when the file has no commits yet.
 */
function gitFileRevisions(dir: string, relPath: string, currentContent: string): Revision[] {
  let log: string;
  try {
    log = execFileSync(
      'git',
      ['-C', dir, 'log', '--reverse', '--format=%H%x09%aI%x09%ae', '--', relPath],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return [{ content: currentContent }];
  }
  if (log === '') return [{ content: currentContent }];

  const revisions: Revision[] = [];
  for (const line of log.split('\n')) {
    const [sha, dateIso, authorEmail] = line.split('\t');
    if (!sha) continue;
    try {
      const content = execFileSync('git', ['-C', dir, 'show', `${sha}:${relPath}`], {
        encoding: 'utf8',
      });
      revisions.push({ content, dateIso, authorEmail });
    } catch {
      // A revision that can't be materialized (e.g. a delete) is skipped.
    }
  }
  return revisions.length > 0 ? revisions : [{ content: currentContent }];
}

function conceptFiles(files: { path: string; content: string }[]): { path: string; content: string }[] {
  return files.filter((f) => f.path.endsWith('.md') && !RESERVED.has(basename(f.path)));
}

function readConceptFiles(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  walk(dir, dir, out);
  return out;
}

function walk(root: string, current: string, out: { path: string; content: string }[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = abs.slice(root.length + 1).split('\\').join('/');
      out.push({ path: rel, content: readFileSync(abs, 'utf8') });
    }
  }
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function slugFromPath(path: string): string {
  return basename(path).replace(/\.md$/, '');
}
