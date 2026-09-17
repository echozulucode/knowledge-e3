import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import {
  conceptToImport,
  e3OwnerToActor,
  parseBundleIndex,
  type BundleIndexInfo,
  type OkfImportItem,
} from '@echozedlabs/okf';
import { digestOf, isImportedPath, type ItemSelection } from '@echozedlabs/content-store';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import { canonicalTypeLabel } from '../content-types/content-types.registry.js';
import {
  ensureSpaceForFrontmatterInTx,
  serializeFromParts,
  explicitPublishedAt,
} from '../pages/pages.service.js';
import { toE3Frontmatter } from '../okf/okf-frontmatter.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from '../pages/taxonomy.js';
import { lifecycleColumnsFrom } from '../pages/lifecycle-columns.js';
import { syncImageLinksInTx } from '../pages/image-links.js';
import { reindexPageFts } from '../search/fts-index.js';
import { importCarries, importedStatus, readIdMap, stampImportFrontmatter } from '../sync/import-identity.js';
import { WikiService } from '../wiki/wiki.service.js';
import { AssetsService } from '../images/assets.service.js';
import type { AssetDescriptor } from '../images/asset-descriptor.js';
import { ContentStoreRegistry } from './content-store.registry.js';

const RESERVED = new Set(['index.md', 'log.md']);
const DEFAULT_TOPIC_SLUG = 'default';

/** One revision of a concept file: its content and (if known) commit time + author. */
interface Revision {
  /**
   * The bytes as they are on disk (or in the commit) — what `file_digest`
   * hashes, so the write-first `changed_on_disk` guard compares against the
   * real file and not against an in-memory import stamp.
   */
  raw: string;
  /**
   * What the index derives from: `raw` for a canonical concept file; `raw` plus
   * the in-memory import frontmatter (`e3_id` / `type` / `title`) for a file a
   * source's `include_globs` brought in.
   */
  content: string;
  dateIso?: string;
  authorEmail?: string;
}

interface RecoveredFile {
  slug: string;
  /** Repo-relative posix path of the concept file (recorded on the row as the canonical file). */
  path: string;
  /** Oldest → newest. At least one entry (current working-tree content). */
  revisions: Revision[];
  /** Source registry id of the repo the file came from (`main` / `topic:<slug>`), or null. */
  sourceId: string | null;
  /**
   * Set for a glob-imported file (plan §8.3). A plain Markdown file names no
   * topic and often no status, so the source supplies both — exactly as
   * `InboundIndexService` does on the sync path.
   */
  imported?: { topic?: string; defaultStatus?: 'draft' | 'published' | null };
}

/** A repo's `index.md` presentation and the topic slug it belongs to. */
interface TopicPresentation {
  slug: string;
  info: BundleIndexInfo;
}

/**
 * One repository working tree to rebuild from, plus everything about its
 * registry row (`content_sources`) that decides **which** of its files are
 * items and **how** an imported one is identified. A row with no globs leaves
 * every field here unset and rebuilds exactly as it always has.
 */
export interface RebuildRepo {
  dir: string;
  /** Source registry id (`main` / `topic:<slug>`), recorded as `pages.source_id`. */
  sourceId?: string;
  /** `content_sources.include_globs`, decoded. Empty/absent = the canonical `concepts/` layout only. */
  include?: readonly string[];
  /** `content_sources.exclude_globs`, decoded. */
  exclude?: readonly string[];
  /** `content_sources.default_type`: the type an imported file that names none is given. */
  defaultType?: string | null;
  /** `content_sources.default_status`: the status an imported file that declares none is given. */
  defaultStatus?: 'draft' | 'published' | null;
  /**
   * `content_sources.role`. Not needed to *recover* an id — the file and
   * `.e3/ids.json` are both consulted whatever the role — but it makes the
   * warning for a file with no recoverable id say the right thing: for a
   * `reference` source that means the id map is missing or stale.
   */
  role?: 'authoritative' | 'reference';
  /**
   * Display name of the topic this source is bound to, when the registry knows
   * it. Imported files carry no topic of their own, so this is what files them;
   * without it the topic slug from `sourceId` is used and a rebuild that has to
   * recreate the topic names it after its slug.
   */
  topicName?: string | null;
}

export interface RebuildReport {
  pages: number;
  /** Total page_versions rows reconstructed (> pages when history is replayed). */
  versions: number;
  links: number;
  /** Media assets reindexed from git-tracked sidecar descriptors. */
  images: number;
  /** Of `pages`, how many came from a source's `include_globs` rather than the canonical layout. */
  imported: number;
  /** Files that referenced an owner who no longer exists; reassigned to the rebuild actor. */
  reassignedOwners: number;
}

export interface RebuildOptions extends Omit<RebuildRepo, 'dir' | 'sourceId'> {
  /** User id used as author/owner when a file's embedded owner is missing or unknown. */
  actorId: string;
  /**
   * Replay each concept's full version history from its git commits, so
   * `page_versions` is reconstructed from git — not just the current state.
   * Requires the directory to be a git repository. Default false (current state).
   */
  replayHistory?: boolean;
  /** Source registry id the files come from (`main` / `topic:<slug>`), recorded as `pages.source_id`. */
  sourceId?: string;
}

/**
 * Phase B of the git-of-record pivot (see ADR-0001): the **rebuild-from-git
 * path**. Given the OKF-conformant Markdown files in the git working tree, drop
 * the derived content tables and reconstruct the entire index — pages, versions,
 * taxonomy, links, and FTS — from the files alone.
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
    private readonly assets: AssetsService,
    private readonly stores: ContentStoreRegistry,
  ) {}

  /**
   * Rebuild the derived index from one git working tree. The source's registry
   * fields (`include`/`exclude` globs and the import defaults) pass through, so
   * a single-tree rebuild of an imported repository sees the same files a
   * multi-tree one does.
   */
  async rebuildFromDir(dir: string, opts: RebuildOptions): Promise<RebuildReport> {
    const { actorId, replayHistory, sourceId, ...repo } = opts;
    return this.rebuildFromRepos([{ ...repo, dir, sourceId }], { actorId, replayHistory });
  }

  /**
   * Rebuild the derived index from several repository working trees at once —
   * the main repo (topic subtrees) plus each dedicated topic repo. One wipe,
   * one load, so no repo's rows survive from before and none are dropped by a
   * later repo's rebuild. Each repo's root `index.md` presentation is applied
   * to its topic afterwards.
   *
   * Files are enumerated through the content store, which is given the repo's
   * `include`/`exclude` globs so it selects **exactly** what
   * `InboundIndexService` selects for the same source — one rule, one matcher
   * (`@echozedlabs/content-store` `item-paths.ts`). Before that the enumeration
   * knew only the canonical bundle layout, so a drop-and-rebuild silently
   * dropped every glob-imported file from the index (issue 94). Reserved files
   * (`index.md`, `log.md`) and `assets/**` stay excluded regardless of globs,
   * and a repo with no globs enumerates precisely what it always did.
   *
   * A glob-imported file is *identified* the way the inbound indexer identifies
   * it, through the same shared helpers (`sync/import-identity.ts`): its
   * `e3_id` if it carries one, else the id recorded for its path in
   * `.e3/ids.json` beside the clone, else a fresh one; the source's
   * `default_type` when it names no type; the derived title when it names none.
   * Nothing is written back — a rebuild must not dirty a `reference` source's
   * working tree, which is the whole reason `.e3/ids.json` exists.
   */
  async rebuildFromRepos(repos: RebuildRepo[], opts: Omit<RebuildOptions, 'sourceId'>): Promise<RebuildReport> {
    const recovered: RecoveredFile[] = [];
    const descriptors: AssetDescriptor[] = [];
    const presentations: TopicPresentation[] = [];
    for (const repo of repos) {
      const store = this.stores.forRepo(repo.dir);
      const sourceId = repo.sourceId ?? null;
      const selection: ItemSelection = { include: repo.include ?? [], exclude: repo.exclude ?? [] };
      const globbed = (selection.include ?? []).length > 0;
      // Read once per repo, never written: this is where a `reference` source's
      // ids live, since its working tree must stay clean.
      const ids = globbed
        ? readIdMap(repo.dir, (m) => this.logger.warn(`[rebuild:${sourceId ?? repo.dir}] ${m}`))
        : { ids: {}, created: {} };
      const subtrees = new Set<string>();
      for (const ref of await store.list(selection)) {
        const { raw } = await store.read(ref.path);
        const imported = globbed && isImportedPath(ref.path, selection);
        const stamp = imported
          ? (content: string): string =>
              stampImportFrontmatter(content, ref.path, {
                id: ids.ids[ref.path],
                createdAt: ids.created[ref.path],
                defaultType: repo.defaultType,
              }).raw
          : (content: string): string => content;
        if (imported && !ids.ids[ref.path] && !importCarries(raw).id) {
          this.logger.warn(
            `[rebuild:${sourceId ?? repo.dir}] ${ref.path} carries no e3_id and none is recorded in ` +
              `.e3/ids.json; minting a new one` +
              (repo.role === 'reference' ? ' (a reference source keeps its ids there, so the map is missing or stale)' : ''),
          );
        }
        const history = opts.replayHistory ? gitFileRevisions(repo.dir, ref.path, raw) : [{ raw }];
        recovered.push({
          slug: ref.slug,
          path: ref.path,
          revisions: history.map((rev) => ({ ...rev, content: stamp(rev.raw) })),
          sourceId,
          ...(imported
            ? { imported: { topic: importTopicFor(repo, ref.path), defaultStatus: repo.defaultStatus } }
            : {}),
        });
        const subtree = subtreeOf(ref.path);
        if (subtree) subtrees.add(subtree);
      }
      // Media descriptors live in the working tree's assets dir, beside concepts.
      descriptors.push(...this.assets.readDescriptors(join(repo.dir, 'assets')));
      // The root index carries the repo's own topic; a subtree may carry its own.
      presentations.push({ slug: repoTopicSlug(repo), info: await store.readBundleIndex() });
      for (const slug of subtrees) {
        const abs = join(repo.dir, slug, 'index.md');
        if (existsSync(abs)) presentations.push({ slug, info: parseBundleIndex(readFileSync(abs, 'utf8')) });
      }
    }
    return this.load(recovered, opts.actorId, descriptors, presentations);
  }

  /** Rebuild the derived index from an in-memory set of OKF concept files (current state only). */
  async rebuildFromFiles(
    files: { path: string; content: string }[],
    opts: { actorId: string },
  ): Promise<RebuildReport> {
    const recovered = conceptFiles(files).map((f) => ({
      slug: slugFromPath(f.path),
      path: f.path,
      revisions: [{ raw: f.content, content: f.content }],
      sourceId: null,
    }));
    // No working tree here; reindex from the instance's own assets dir.
    return this.load(recovered, opts.actorId, this.assets.readDescriptors(), []);
  }

  private async load(
    recovered: RecoveredFile[],
    actorId: string,
    descriptors: AssetDescriptor[],
    presentations: TopicPresentation[],
  ): Promise<RebuildReport> {
    const userRows = await this.db.selectFrom('users').select(['id', 'email']).execute();
    const knownUsers = new Set(userRows.map((u) => u.id));
    const emailToUser = new Map(
      userRows.filter((u) => u.email).map((u) => [u.email, u.id] as const),
    );
    const report: RebuildReport = { pages: 0, versions: 0, links: 0, images: 0, imported: 0, reassignedOwners: 0 };

    // SQLite ignores PRAGMA foreign_keys inside a transaction, so toggle it at the
    // connection level around the bulk load — the standard pattern for a restore.
    // The connection-scoped setting persists across the inner transaction.
    await sql`PRAGMA foreign_keys = OFF`.execute(this.db);
    try {
      await this.db.transaction().execute(async (tx) => {
        await wipeDerivedTables(tx);
        // Repopulate the media index from the git-tracked sidecar descriptors
        // BEFORE reconstructing pages, so per-page image_links can resolve
        // against it (ADR-0003; closes the rebuild-reindex gap).
        report.images = await reindexImages(tx, descriptors, actorId, knownUsers);
        for (const file of recovered) {
          const written = await this.reconstructItem(tx, file, actorId, knownUsers, emailToUser);
          report.pages += 1;
          if (file.imported) report.imported += 1;
          report.versions += written.versions;
          report.links += written.links;
          if (written.reassignedOwner) report.reassignedOwners += 1;
        }
        // Topics exist now (recreated from the concepts' frontmatter), so the
        // per-repo index.md presentation can land on them.
        for (const p of presentations) await applyPresentation(tx, p);
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

    /**
     * The frontmatter one revision is indexed with. For an imported file the
     * source decides the topic, since a plain Markdown file names none — the
     * same override, at the same point in the pipeline, as
     * `ContentCommandsService.indexFromFile` applies on the sync path.
     */
    const frontmatterOf = (content: string, item: OkfImportItem): Record<string, unknown> => {
      const fm = e3FrontmatterOf(fileFrontmatterOf(content), item, content);
      if (file.imported?.topic) fm['topic'] = file.imported.topic;
      return fm;
    };

    const pageId = latestItem.e3Id ?? newId();
    const slug = latestItem.slug ?? file.slug ?? slugify(latestItem.title);
    // An imported file that declares no status takes the source's
    // `default_status` (then the instance default), as the sync path does;
    // a canonical concept file always carries one and falls back to published.
    const status: 'draft' | 'published' = file.imported
      ? importedStatus(latestItem.status, file.imported.defaultStatus)
      : (latestItem.status ?? 'published');

    const versionIds = revisions.map(() => newId());

    // Reconstruct the version chain, oldest → newest.
    for (let i = 0; i < revisions.length; i += 1) {
      const rev = revisions[i]!;
      const revItem = conceptToImport(rev.content);
      const revFile = fileFrontmatterOf(rev.content);
      const raw = serializeFromParts(frontmatterOf(rev.content, revItem), bodyOf(revItem));
      const parsed = parse(raw);
      // created_by is the *editor* — prefer the git commit author, then the
      // owner embedded in the file, then the rebuild actor.
      const createdBy = resolveAuthor(rev, revItem, actorId, knownUsers, emailToUser);
      const createdAt =
        rev.dateIso ?? isoOf(revFile['timestamp']) ?? revItem.updatedAt ?? revItem.createdAt ?? nowIso();

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
    const latestFile = fileFrontmatterOf(latest.content);
    const latestParsed = parse(serializeFromParts(frontmatterOf(latest.content, latestItem), bodyOf(latestItem)));
    const spaceId = await ensureSpaceForFrontmatterInTx(tx, latestParsed.frontmatter);
    const owner = resolveOwner(latestItem, actorId, knownUsers);
    const reassignedOwner = owner.reassigned;
    const createdAt = revisions[0]!.dateIso ?? latestItem.createdAt ?? nowIso();
    // The file's `timestamp` is the exporter's last-change time; the importer
    // prefers an authored `generated.at` (when the content was produced), which
    // is not when the row last changed.
    const updatedAt = latest.dateIso ?? isoOf(latestFile['timestamp']) ?? latestItem.updatedAt ?? createdAt;
    // Publish date from the file's frontmatter; for a published item that predates
    // the field, fall back to its creation time so the feed still orders sensibly.
    const publishedAt =
      explicitPublishedAt(latestParsed.frontmatter) ?? (status === 'published' ? createdAt : null);

    await tx
      .insertInto('pages')
      .values({
        id: pageId,
        slug,
        title: latestItem.title,
        status,
        // Same derivation as a live write: the frontmatter `type`, canonicalized.
        type: canonicalTypeLabel(latestParsed.frontmatter['type'] as string | undefined),
        owner_id: owner.ownerId,
        space_id: spaceId,
        created_at: createdAt,
        updated_at: updatedAt,
        published_at: publishedAt,
        deleted_at: null,
        version_token: revisions.length,
        current_version_id: versionIds[versionIds.length - 1]!,
        ...lifecycleColumnsFrom(latestParsed.frontmatter, status),
        // The file this row derives from (plan §7.2): the write-first path
        // checks the next edit against this digest.
        file_path: file.path,
        // The bytes on disk, NOT the import-stamped ones the index derives
        // from: the next write compares this digest against the real file.
        file_digest: digestOf(latest.raw),
        source_id: file.sourceId,
      })
      .execute();

    const taxonomy = taxonomyFromFrontmatter(latestParsed.frontmatter);
    await syncTaxonomyInTx(tx, pageId, taxonomy);

    const links = extractItemLinks(latestParsed);
    await this.wiki.indexInTx(tx, pageId, links);
    // The same routine a live write uses, so a rebuild reproduces the FTS row
    // (Topic, category and group names, aliases included) byte for byte.
    await reindexPageFts(tx, pageId);
    // Rebuild this page's image references from its body (`![](/assets/<file>)`)
    // AND its frontmatter cover keys, matching a live save exactly — a rebuild
    // that linked fewer assets than a save would silently un-publish every cover
    // on the instance. Resolves against the images reindexed above; a reference
    // to an asset with no descriptor is simply not linked (no dangling row),
    // which the integrity check then tolerates.
    await syncImageLinksInTx(tx, pageId, latestParsed.body, latestParsed.frontmatter);

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

/** `e3FrontmatterOf` for a file's content: what the inbound sync indexes (same mapping as a rebuild). */
export function e3FrontmatterFromFile(content: string, item: OkfImportItem): Record<string, unknown> {
  return e3FrontmatterOf(fileFrontmatterOf(content), item, content);
}

/** The OKF file's own frontmatter (as exported), before the import mapping. */
function fileFrontmatterOf(content: string): Record<string, unknown> {
  return (parse(content).frontmatter ?? {}) as Record<string, unknown>;
}

/**
 * E3 frontmatter for a recovered concept: the importer's mapping, corrected
 * where a live write and the import mapping disagree, so the rebuilt row reads
 * the same as the live one (the conformance suite pins this):
 *  - `type`: an OKF-standard key the importer strips; the `type` column and
 *    section/feed filters derive from it.
 *  - `description`: the importer re-emits it as `summary`; when the file has
 *    only `description`, keep the author's key (`ItemSummary.description` reads it).
 *  - `stale_after`: as authored in the file text. The exporter writes a stored
 *    `Date` as a full ISO timestamp and a stored string as plain `YYYY-MM-DD`,
 *    but the YAML parser reads both back as a `Date`; a date-only text therefore
 *    stays the `YYYY-MM-DD` string (what the JSON doors store, and the importer's
 *    own form) and a full timestamp stays ISO (what the raw-Markdown door stores).
 *  - `generated`: the exporter synthesizes `{ by: <owner actor>, at: <timestamp> }`
 *    for a page that has none; that exact stamp is dropped again, since the live
 *    row had no provenance (`generated_by` null). Anything else is kept.
 */
function e3FrontmatterOf(file: Record<string, unknown>, item: OkfImportItem, content: string): Record<string, unknown> {
  const fm = toE3Frontmatter(item);
  if (typeof file['type'] === 'string' && file['type'].trim()) fm['type'] = file['type'];
  if (file['description'] !== undefined && file['summary'] === undefined) {
    delete fm['summary'];
    fm['description'] = file['description'];
  }
  if (file['stale_after'] !== undefined) fm['stale_after'] = staleAfterAsAuthored(content, file['stale_after']);
  if (isSynthesizedProvenance(file)) delete fm['generated'];
  // As stored: YAML dates arrive as `Date`s but the live row persists them as
  // ISO strings (and `serializeFromParts` cannot render a `Date` at all).
  return JSON.parse(JSON.stringify(fm)) as Record<string, unknown>;
}

/** A `Date`-parsed `stale_after` whose frontmatter text is date-only → that `YYYY-MM-DD` string. */
function staleAfterAsAuthored(content: string, parsed: unknown): unknown {
  if (!(parsed instanceof Date) || !content.startsWith('---')) return parsed;
  const end = content.indexOf('\n---', 3);
  const block = end < 0 ? content : content.slice(0, end);
  const m = /^stale_after:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m.exec(block);
  return m ? m[1] : parsed;
}

/** True when the file's `generated` is exactly what `pageToConcept` stamps on a page without one. */
function isSynthesizedProvenance(file: Record<string, unknown>): boolean {
  const g = file['generated'];
  if (!g || typeof g !== 'object' || Array.isArray(g)) return false;
  const { by, at } = g as Record<string, unknown>;
  const owner = typeof file['e3_owner_id'] === 'string' ? file['e3_owner_id'] : undefined;
  return by === e3OwnerToActor(owner) && isoOf(at) === isoOf(file['timestamp']);
}

/**
 * The body as a live write stored it: the renderer emits one blank line after
 * the frontmatter fence (`---\n\n`), which `parse` keeps as a leading newline.
 */
export function bodyOf(item: OkfImportItem): string {
  return item.body.replace(/^\n+/, '');
}

/** A YAML date (parsed to `Date`) or ISO string as an ISO string; undefined otherwise. */
function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Apply a repo's `index.md` presentation to its topic (no-op when the index has none). */
async function applyPresentation(tx: Kysely<Database>, p: TopicPresentation): Promise<void> {
  const { info } = p;
  if (!info.presentation && !info.start_here && !info.landing_markdown) return;
  await tx
    .updateTable('spaces')
    .set({
      ...(info.presentation ? { presentation: info.presentation } : {}),
      ...(info.start_here ? { start_here: info.start_here } : {}),
      ...(info.landing_markdown ? { landing_markdown: info.landing_markdown } : {}),
      updated_at: nowIso(),
    })
    .where('slug', '=', p.slug)
    .where('archived_at', 'is', null)
    .execute();
}

/**
 * The topic a repo's root `index.md` belongs to, mirroring the git adapter's
 * `indexTopic`: a dedicated repo (`topic:<slug>`, or a flat `concepts/` root
 * named after its topic) carries that topic; the main repo carries the default.
 */
function repoTopicSlug(repo: RebuildRepo): string {
  if (repo.sourceId?.startsWith('topic:')) return repo.sourceId.slice('topic:'.length);
  if (repo.sourceId !== 'main' && existsSync(join(repo.dir, 'concepts'))) return basename(repo.dir.split('\\').join('/'));
  return DEFAULT_TOPIC_SLUG;
}

/**
 * The topic an imported file is filed under — the rebuild's mirror of
 * `InboundIndexService.topicFor`: a dedicated source forces its own topic (a
 * plain Markdown file names none), while in the main repo the subtree is the
 * topic and a file outside any subtree lands in the default topic.
 *
 * `topicName` is preferred over the slug so that a rebuild which has to
 * recreate the topic gives it the name it had; without it the topic comes back
 * named after its slug (topic names for a glob-imported source are not in git —
 * see the git storage notes, "Topic metadata not in git").
 */
function importTopicFor(repo: RebuildRepo, path: string): string | undefined {
  if (repo.sourceId === 'main' || (!repo.sourceId && !repo.topicName)) return subtreeOf(path) ?? undefined;
  return repo.topicName?.trim() || repoTopicSlug(repo);
}

/** `<topic>/concepts/x.md` → `topic`; null for a flat `concepts/x.md`. */
function subtreeOf(path: string): string | null {
  const m = /^([^/]+)\/concepts\/[^/]+$/.exec(path);
  return m ? m[1]! : null;
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

/**
 * Repopulate the `images` index from the git-tracked sidecar descriptors — the
 * media half of "the database is disposable" (ADR-0003). Bytes are addressed by
 * the descriptor; this only reconstructs the derived rows.
 *
 * `created_by` carries an FK to users.id. On a foreign instance the descriptor's
 * author may not exist, so it is resolved to a known user (else the rebuild
 * actor) — otherwise the post-rebuild foreign_key_check would fail.
 */
async function reindexImages(
  tx: Kysely<Database>,
  descriptors: AssetDescriptor[],
  actorId: string,
  knownUsers: Set<string>,
): Promise<number> {
  let count = 0;
  for (const d of descriptors) {
    const createdBy = knownUsers.has(d.created_by) ? d.created_by : actorId;
    const result = await tx
      .insertInto('images')
      .values({
        id: newId(),
        file: d.file,
        mime: d.mime,
        byte_size: d.byte_size,
        sha256: d.sha256,
        alt: d.alt,
        original_filename: d.original_filename,
        created_at: d.created_at,
        created_by: createdBy,
      })
      // `file` and `sha256` are unique; a duplicated descriptor is a no-op.
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(result?.numInsertedOrUpdatedRows ?? 0) > 0) count += 1;
  }
  return count;
}

/** Delete every table whose contents are derived from the canonical files. */
async function wipeDerivedTables(tx: Kysely<Database>): Promise<void> {
  await tx.deleteFrom('image_links').execute();
  await tx.deleteFrom('images').execute();
  await tx.deleteFrom('page_groups').execute();
  await tx.deleteFrom('page_tags').execute();
  await tx.deleteFrom('page_authors').execute();
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


/**
 * The ordered revisions of one concept file from git history (oldest → newest).
 * Falls back to the current working-tree content when the file has no commits yet.
 */
function gitFileRevisions(dir: string, relPath: string, currentContent: string): Omit<Revision, 'content'>[] {
  let log: string;
  try {
    log = execFileSync(
      'git',
      ['-C', dir, 'log', '--reverse', '--format=%H%x09%aI%x09%ae', '--', relPath],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return [{ raw: currentContent }];
  }
  if (log === '') return [{ raw: currentContent }];

  const revisions: Omit<Revision, 'content'>[] = [];
  for (const line of log.split('\n')) {
    const [sha, dateIso, authorEmail] = line.split('\t');
    if (!sha) continue;
    try {
      const content = execFileSync('git', ['-C', dir, 'show', `${sha}:${relPath}`], {
        encoding: 'utf8',
      });
      revisions.push({ raw: content, dateIso, authorEmail });
    } catch {
      // A revision that can't be materialized (e.g. a delete) is skipped.
    }
  }
  return revisions.length > 0 ? revisions : [{ raw: currentContent }];
}

function conceptFiles(files: { path: string; content: string }[]): { path: string; content: string }[] {
  return files.filter((f) => f.path.endsWith('.md') && !RESERVED.has(basename(f.path)));
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function slugFromPath(path: string): string {
  return basename(path).replace(/\.md$/, '');
}
