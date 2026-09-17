/**
 * Inbound indexing (plan §8.1): the files a fetch/merge changed are re-indexed
 * through `ContentCommandsService.indexFromFile` — the file already is the
 * canonical one, so nothing is written back (except a fresh id for a new item
 * in an authoritative source). Reserved files: a bundle `index.md` applies its
 * presentation to the topic it belongs to (root → the source's topic;
 * `<sub>/index.md` in the main repo → that subtree's topic).
 *
 * Which files are indexed (plan §8.3, "import an existing repository of
 * Markdown"): by default the canonical OKF layout, `concepts/*.md` at any
 * depth. A source that sets `include_globs` instead indexes exactly the `.md`
 * files those globs select, minus `exclude_globs` — that is the non-OKF import
 * path, and it never changes anything for a source with no globs. Such an
 * imported file usually carries no `e3_id`: one is assigned on the first sync
 * and kept stable afterwards, written back into the file for an `authoritative`
 * source and recorded in `.e3/ids.json` beside the clone for a `reference` one,
 * whose working tree must stay clean. The moment it was first indexed
 * (`e3_created_at`) is recorded the same way and in the same place, because a
 * plain Markdown file has no creation date and a rebuild would otherwise date
 * the item at the rebuild — see `import-identity.ts`, which the rebuild path
 * shares so the two cannot drift.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { PathChange } from '@echozedlabs/knowledge-types';
import {
  NotFoundError,
  toPosix,
  isIndexablePath as isIndexableBundlePath,
  isImportedPath as isImportedBundlePath,
  type ItemSelection,
  type LocalBundleStore,
} from '@echozedlabs/content-store';
import { conceptToImport, parseBundleIndex } from '@echozedlabs/okf';
import { LocalGitRepo, SYSTEM_COMMITTER } from '@echozedlabs/repo-sync';
import { AuthService } from '../auth/auth.service.js';
import { newId, nowIso } from '../common/ids.js';
import { ContentCommandsService, type IndexFromFileResult } from '../content/content-commands.service.js';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { PagesService } from '../pages/pages.service.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { ContentStoreRegistry } from '../storage/content-store.registry.js';
import {
  E3_DIR,
  IDS_FILE,
  identityStampEntries,
  importCarries,
  readIdMap,
  serializeIdMap,
  stampFrontmatter,
  stampImportFrontmatter,
  type ImportIds,
} from './import-identity.js';
import { ReviewService } from './review.service.js';
import { globList, type SourceRow } from './source-registry.service.js';

const DEFAULT_TOPIC_SLUG = 'default';

@Injectable()
export class InboundIndexService {
  private readonly logger = new Logger(InboundIndexService.name);
  /** `.e3/ids.json` per source dir; this process owns the file, so one read is enough. */
  private readonly idMaps = new Map<string, ImportIds>();

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly commands: ContentCommandsService,
    private readonly pages: PagesService,
    private readonly paths: ContentPathResolver,
    private readonly stores: ContentStoreRegistry,
    private readonly auth: AuthService,
    private readonly reviews: ReviewService,
  ) {}

  /** Index every change; one file's failure is logged and does not stop the rest. */
  async applyChanges(source: SourceRow, changes: PathChange[]): Promise<void> {
    const stamped: string[] = [];
    for (const change of changes) {
      try {
        await this.indexPath(source, change, stamped);
      } catch (err) {
        this.logger.warn(`[sync:${source.id}] could not index ${change.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.commitIdStamps(source, stamped);
  }

  /**
   * Index one changed path. `stamped` collects the files an id was written back
   * into, so a whole inbound batch commits once; omit it and this call commits
   * its own (the conflict queue re-indexes a single resolved file this way).
   */
  async indexPath(source: SourceRow, change: PathChange, stamped?: string[]): Promise<IndexFromFileResult | null> {
    if (stamped) return this.indexOne(source, change, stamped);
    const own: string[] = [];
    const result = await this.indexOne(source, change, own);
    await this.commitIdStamps(source, own);
    return result;
  }

  // ---------------------------------------------------------------- internals

  private async indexOne(source: SourceRow, change: PathChange, stamped: string[]): Promise<IndexFromFileResult | null> {
    const path = toPosix(change.path);
    const store = this.stores.forRepo(this.paths.dirOf(source));
    if (basename(path) === 'index.md') {
      if (change.change !== 'deleted') await this.applyBundleIndex(source, path, store);
      return null;
    }
    if (!isIndexablePath(source, path)) return null;

    switch (change.change) {
      case 'deleted':
        await this.softDelete(source, path);
        return null;
      case 'renamed': {
        const from = change.from ? toPosix(change.from) : null;
        const row = from ? await this.rowByPath(source.id, from) : null;
        if (row) {
          await this.db.updateTable('pages').set({ file_path: path }).where('id', '=', row.id).execute();
          await this.clearDiagnostics(source.id, from!);
        }
        if (from) this.moveImportedId(source, from, path);
        return this.upsertFromDisk(source, path, store, stamped, row?.id);
      }
      default:
        return this.upsertFromDisk(source, path, store, stamped);
    }
  }

  private async upsertFromDisk(
    source: SourceRow,
    path: string,
    store: LocalBundleStore,
    stamped: string[],
    pageId?: string,
  ): Promise<IndexFromFileResult | null> {
    let file;
    try {
      file = await store.read(path);
    } catch (err) {
      if (err instanceof NotFoundError) {
        await this.softDelete(source, path);
        return null;
      }
      throw err;
    }
    // A file matched by `include_globs` rather than by the canonical concept
    // layout is an import (§8.3): it may carry no id, no type and no title.
    const imported = isImportedPath(source, path);
    const prepared = imported ? await this.prepareImport(source, path, file.raw) : null;
    const raw = prepared?.raw ?? file.raw;
    const result = await this.commands.indexFromFile({
      sourceId: source.id,
      path,
      raw,
      digest: file.digest,
      role: source.role,
      topic: await this.topicFor(source, path),
      defaultStatus: source.default_status ?? undefined,
      pageId,
      actorId: await this.actorFor(raw),
    });
    // The lint stays in warn mode for imported files: they land (as drafts when
    // an error fired) with a diagnostic, exactly like any other inbound file.
    if (prepared?.assign) {
      await this.persistImportedId(source, path, store, file.raw, result.item, stamped);
    }
    if (result.lintFailed) await this.recordDiagnostics(source, path, result);
    else await this.clearDiagnostics(source.id, path);
    return result;
  }

  // ------------------------------------------------------------------ import

  /**
   * What an imported file is indexed as: its own bytes plus, in memory only,
   * the frontmatter a plain Markdown file does not have —
   *
   *  - `e3_id`: the id this path already owns (from `.e3/ids.json`, or from the
   *    row indexed under this path), so re-syncing never mints a second id. A
   *    path with no id yet gets one from `indexFromFile` and `assign` records it.
   *  - `e3_created_at`: when the path was first indexed, recorded the same way
   *    and for the same reason (a rebuild has nowhere else to read it from).
   *  - `type`: the source's `default_type`, when the file names none.
   *  - `title`: the first `# heading`, else the file name — otherwise every
   *    untitled import indexes as "Untitled".
   *
   * Only the two `e3_*` keys are ever recorded (`persistImportedId`); type and
   * title are derived the same way on every sync, so the file stays the
   * author's. The stamping itself lives in `import-identity.ts`, which the
   * rebuild path calls too — the two must agree or a rebuild would re-mint ids.
   */
  private async prepareImport(source: SourceRow, path: string, raw: string): Promise<{ raw: string; assign: boolean }> {
    const carries = importCarries(raw);
    let id: string | undefined;
    let createdAt: string | undefined;
    if (!carries.id || !carries.createdAt) {
      const map = this.idMapFor(source);
      id = map.ids[path];
      createdAt = map.created[path];
      if (!id) {
        const row = await this.rowByPath(source.id, path);
        if (row) {
          id = row.id;
          createdAt ??= row.created_at;
        }
      }
    }
    const stamped = stampImportFrontmatter(raw, path, { id, createdAt, defaultType: source.default_type });
    // Something still has to be recorded when the file names neither key and
    // the map has not caught up: `persistImportedId` writes only what is missing.
    return { raw: stamped.raw, assign: !carries.id || !carries.createdAt };
  }

  /**
   * Keep the identity this path was indexed under — its `e3_id` and the moment
   * it was first indexed (`e3_created_at`, which a rebuild has no other way to
   * know, and without which an imported item is re-dated by every rebuild and
   * jumps to the front of the feed).
   *
   * An `authoritative` source takes both in the file (a follow-up commit, plan
   * §5.5); a `reference` source must keep its working tree clean, so they go to
   * `.e3/ids.json` beside the clone, with `.git/info/exclude` hiding it from git
   * without touching a tracked file.
   */
  private async persistImportedId(
    source: SourceRow,
    path: string,
    store: LocalBundleStore,
    diskRaw: string,
    item: { id: string; created_at: string },
    stamped: string[],
  ): Promise<void> {
    if (source.role === 'authoritative') {
      const entries = identityStampEntries(diskRaw, item.id, item.created_at);
      if (entries.length === 0) return;
      try {
        const { digest } = await store.write(path, stampFrontmatter(diskRaw, entries));
        await this.db.updateTable('pages').set({ file_digest: digest }).where('id', '=', item.id).execute();
        stamped.push(path);
        return;
      } catch (err) {
        // Read-only checkout, permissions, a racing writer: fall back to the
        // side map rather than losing the id (and so re-minting it next sync).
        this.logger.warn(`[sync:${source.id}] could not write e3_id into ${path}: ${errMessage(err)}`);
      }
    }
    this.recordImportedId(source, path, item.id, item.created_at);
  }

  private recordImportedId(source: SourceRow, path: string, id: string, createdAt: string): void {
    const map = this.idMapFor(source);
    if (map.ids[path] === id && map.created[path] === createdAt) return;
    map.ids[path] = id;
    map.created[path] = createdAt;
    this.writeIdMap(source, map);
  }

  /** A renamed import keeps its identity: move the entries so the new path resolves to it. */
  private moveImportedId(source: SourceRow, from: string, to: string): void {
    const map = this.idMapFor(source);
    const id = map.ids[from];
    if (!id || map.ids[to] === id) return;
    delete map.ids[from];
    map.ids[to] = id;
    const createdAt = map.created[from];
    delete map.created[from];
    if (createdAt) map.created[to] = createdAt;
    this.writeIdMap(source, map);
  }

  /** `.e3/ids.json`, tolerantly: absent, empty or malformed all read as "no ids yet". */
  private idMapFor(source: SourceRow): ImportIds {
    const dir = this.paths.dirOf(source);
    const cached = this.idMaps.get(dir);
    if (cached) return cached;
    const map = readIdMap(dir, (message) => this.logger.warn(`[sync:${source.id}] ${message}`));
    this.idMaps.set(dir, map);
    return map;
  }

  private writeIdMap(source: SourceRow, map: ImportIds): void {
    const dir = this.paths.dirOf(source);
    try {
      mkdirSync(join(dir, E3_DIR), { recursive: true });
      writeFileSync(join(dir, E3_DIR, IDS_FILE), serializeIdMap(source.id, map), 'utf8');
      this.ignoreE3Dir(dir);
    } catch (err) {
      this.logger.warn(`[sync:${source.id}] could not write ${E3_DIR}/${IDS_FILE}: ${errMessage(err)}`);
    }
  }

  /** `.git/info/exclude` (never a tracked `.gitignore`) so the map cannot dirty the tree. */
  private ignoreE3Dir(dir: string): void {
    try {
      const info = join(dir, '.git', 'info');
      if (!existsSync(join(dir, '.git'))) return;
      mkdirSync(info, { recursive: true });
      const file = join(info, 'exclude');
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (/^\/?\.e3\/?\s*$/m.test(current)) return;
      writeFileSync(file, current === '' || current.endsWith('\n') ? `${current}/${E3_DIR}/\n` : `${current}\n/${E3_DIR}/\n`, 'utf8');
    } catch {
      // A worktree/gitfile checkout or a read-only .git: the map still works,
      // the tree just shows it as untracked.
    }
  }

  /** One follow-up commit for the ids written back into an authoritative source's files. */
  private async commitIdStamps(source: SourceRow, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const dir = this.paths.dirOf(source);
    if (!existsSync(join(dir, '.git'))) return;
    try {
      const repo = new LocalGitRepo(dir);
      const status = (await repo.git(['status', '--porcelain', '--', ...paths])).trim();
      if (!status) return;
      await repo.commit(paths, `knowledge-e3: assign ids to ${paths.length} imported file(s)`, SYSTEM_COMMITTER);
    } catch (err) {
      this.logger.warn(`[sync:${source.id}] could not commit assigned ids: ${errMessage(err)}`);
    }
  }

  // ----------------------------------------------------------------- indexing

  private async softDelete(source: SourceRow, path: string): Promise<void> {
    const row = await this.rowByPath(source.id, path);
    if (row) await this.pages.softDelete({ id: await this.systemActorId(), role: 'admin' }, row.id);
    await this.clearDiagnostics(source.id, path);
  }

  private async applyBundleIndex(source: SourceRow, path: string, store: LocalBundleStore): Promise<void> {
    const info = parseBundleIndex((await store.read(path)).raw);
    if (!info.presentation && !info.start_here && !info.landing_markdown) return;
    const slug = path === 'index.md' ? await this.sourceTopicSlug(source) : subtreeOf(path);
    if (!slug) return;
    await this.db
      .updateTable('spaces')
      .set({
        ...(info.presentation ? { presentation: info.presentation } : {}),
        ...(info.start_here ? { start_here: info.start_here } : {}),
        ...(info.landing_markdown ? { landing_markdown: info.landing_markdown } : {}),
        updated_at: nowIso(),
      })
      .where('slug', '=', slug)
      .where('archived_at', 'is', null)
      .execute();
  }

  /**
   * The topic a file is filed under: a dedicated source forces its bound topic
   * (the file's own `space` is ignored, as a repo pull does); in the main repo
   * the subtree is the topic (`<slug>/concepts/x.md` → `<slug>`).
   */
  private async topicFor(source: SourceRow, path: string): Promise<string | undefined> {
    if (source.id !== 'main') return (await this.sourceTopicSlug(source)) ?? undefined;
    return subtreeOf(path) ?? undefined;
  }

  private async sourceTopicSlug(source: SourceRow): Promise<string | null> {
    if (source.id === 'main') return DEFAULT_TOPIC_SLUG;
    if (source.space_id) {
      const row = await this.db.selectFrom('spaces').select('slug').where('id', '=', source.space_id).executeTakeFirst();
      if (row) return row.slug;
    }
    return source.id.startsWith('topic:') ? source.id.slice('topic:'.length) : null;
  }

  /** The file's `e3_owner_id` when it names a user here; otherwise the local system actor. */
  private async actorFor(raw: string): Promise<string> {
    const ownerId = conceptToImport(raw).ownerId;
    if (ownerId) {
      const user = await this.db.selectFrom('users').select('id').where('id', '=', ownerId).where('deleted_at', 'is', null).executeTakeFirst();
      if (user) return user.id;
    }
    return this.systemActorId();
  }

  private async systemActorId(): Promise<string> {
    return (await this.auth.ensureLocalSystemActor()).id;
  }

  private async rowByPath(sourceId: string, path: string): Promise<{ id: string; created_at: string } | null> {
    const row = await this.db
      .selectFrom('pages')
      .select(['id', 'created_at'])
      .where('source_id', '=', sourceId)
      .where('file_path', '=', path)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ?? null;
  }

  private async recordDiagnostics(source: SourceRow, path: string, result: IndexFromFileResult): Promise<void> {
    const now = nowIso();
    const id = newId();
    await this.clearDiagnostics(source.id, path, now);
    await this.db
      .insertInto('sync_diagnostics')
      .values({
        id,
        source_id: source.id,
        path,
        page_id: result.item.id,
        diagnostics_json: JSON.stringify(result.diagnostics),
        detected_at: now,
        cleared_at: null,
        commented_at: null,
      })
      .execute();
    // The file came in through a change request this instance opened: report the
    // failure there, once, so the reviewer sees why the item is held back.
    await this.reviews.commentOnLintFailure({
      source,
      path,
      pageId: result.item.id,
      diagnosticsId: id,
      diagnostics: result.diagnostics,
    });
  }

  private async clearDiagnostics(sourceId: string, path: string, at = nowIso()): Promise<void> {
    await this.db
      .updateTable('sync_diagnostics')
      .set({ cleared_at: at })
      .where('source_id', '=', sourceId)
      .where('path', '=', path)
      .where('cleared_at', 'is', null)
      .execute();
  }
}

/**
 * The paths this source indexes, as `@echozedlabs/content-store` understands
 * them: the decoded `include_globs` / `exclude_globs`.
 */
export function selectionOf(source: Pick<SourceRow, 'include_globs' | 'exclude_globs'>): ItemSelection {
  return { include: globList(source.include_globs), exclude: globList(source.exclude_globs) };
}

/**
 * Whether this source indexes this file (plan section 8.3).
 *
 * With no `include_globs` the answer is exactly what it has always been: the
 * canonical concept layout. With globs it is the `.md` files they select, minus
 * `exclude_globs`. Reserved basenames (`index.md`, `log.md`) and anything under
 * an `assets/` directory are never items, whatever the globs say.
 *
 * The rule itself lives in the content-store package, so the rebuild - which
 * enumerates a working tree through `LocalBundleStore.list()` rather than
 * through a git diff - selects exactly the same files (issue 94).
 */
export function isIndexablePath(source: Pick<SourceRow, 'include_globs' | 'exclude_globs'>, path: string): boolean {
  return isIndexableBundlePath(path, selectionOf(source));
}

/** An indexed file that is *not* in the canonical layout - i.e. one the globs brought in. */
export function isImportedPath(source: Pick<SourceRow, 'include_globs' | 'exclude_globs'>, path: string): boolean {
  return isImportedBundlePath(path, selectionOf(source));
}

/** `<topic>/concepts/x.md` or `<topic>/index.md` → `topic`; null at the root. */
function subtreeOf(path: string): string | null {
  const m = /^([^/]+)\/(?:concepts\/[^/]+|index\.md)$/.exec(path);
  return m ? m[1]! : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-exported under their historical names from `import-identity.ts` and
 * `@echozedlabs/content-store`, where they now live so that the rebuild path
 * shares exactly this logic (issue 94).
 */
export { stampFrontmatter, titleFrom } from './import-identity.js';
export { matchesGlob } from '@echozedlabs/content-store';
