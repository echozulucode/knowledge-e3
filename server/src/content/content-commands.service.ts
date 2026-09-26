/**
 * `ContentCommands` (plan §5.1, §7.3, §9.3): the one write path for every door
 * (UI, REST, MCP; git/import join in later phases).
 *
 * Create and update are **write-first** (plan §7.2–7.3): the OKF concept file
 * in the local bundle working tree is written first (atomically, digest-
 * checked), then the SQLite index is updated in one transaction together with
 * a `content_outbox` row, then the git mirror is asked to commit. Git never
 * enters request latency. Every door takes this path; the `ui` door still
 * returns the `/pages` view (with `published_at`) and the others the item view.
 *
 * Every write runs the content-model lint and returns its diagnostics alongside
 * the item. They are warn-only except at one moment: **publication** from an
 * interactive door (`ui`/`rest`/`mcp`) — a draft this actor takes to
 * `published`, or a create that lands published in one call — where an
 * error-severity diagnostic refuses the write (`assertPublishable`) and the
 * refusal is audited (`content.refused`). Every other write stays warn-only:
 * ordinary saves (including of an already-published item) and the inbound
 * doors — see `indexFromFile`.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lint as lintDocument, type LintOptions } from '@echozedlabs/content-model';
import { DigestMismatchError, NotFoundError, slugFromPath, type LocalBundleStore } from '@echozedlabs/content-store';
import type {
  Actor,
  ContentCommands,
  CreateInput,
  Diagnostic,
  ItemView,
  LintContext,
  UpdateInput,
  WriteResult,
  WriteSource,
} from '@echozedlabs/knowledge-types';
import { conceptToImport, normalizeVerified } from '@echozedlabs/okf';
import { AuditService } from '../audit/audit.service.js';
import { nowIso } from '../common/ids.js';
import type { SourceRole, SyncMode } from '../db/schema.js';
import { ItemsService, normalizeCreateInput, normalizeUpdateInput, toItem } from '../items/items.service.js';
import {
  PagesService,
  type CanonicalFileRef,
  type CreatePageInput,
  type PageView,
  type PreparedRename,
  type PreparedUpdate,
  type ReadActor,
  type RenameOutcome,
  type RenamePageWrite,
  type UpdatePageInput,
} from '../pages/pages.service.js';
import { loadServerConfig } from '../config/server-config.js';
import { ContentPathResolver, type ContentTarget } from '../storage/content-path.resolver.js';
import { ContentStoreRegistry } from '../storage/content-store.registry.js';
import type { MovedOutSource } from '../storage/revision-mirror.port.js';
import { OutboxService } from './outbox.service.js';
import { e3FrontmatterFromFile } from '../storage/index-rebuild.service.js';
import { renderConceptFile, type RenderedConceptFile } from '../storage/render-concept.js';
import { importedStatus } from '../sync/import-identity.js';
import { ReviewService, type StageIntent, type StageOptions } from '../sync/review.service.js';
import { SourceRegistryService, gitCredentialOf, type SourceRow } from '../sync/source-registry.service.js';
import { SYNC_PUSH, type SyncPushPort } from '../sync/sync.port.js';
import { SpacesService } from '../taxonomy/spaces.service.js';
import { readActorOf, type ServerActor } from './actor.js';

/**
 * `CreateInput` plus the `raw_markdown` alias the REST/MCP doors accept today.
 * `UpdateCommandInput` also carries `allow_lint_errors` — the explicit,
 * admin-only, audited opt-out of the publish gate (see `assertPublishable`).
 * Never a default: a caller that wants to publish over error-severity
 * diagnostics has to say so.
 */
export type CreateCommandInput = CreateInput & { raw_markdown?: string };
export type UpdateCommandInput = UpdateInput & { raw_markdown?: string; allow_lint_errors?: boolean };

export interface RenameOptions {
  /** Version token the client read; defaults to the current one. */
  ifMatch?: number;
  linkAction?: 'update_all' | 'skip';
  expectedAffectedVersions?: Record<string, number>;
}

export interface RenameResult extends WriteResult {
  affected_pages: { id: string; slug: string; title: string }[];
}

/** An inbound concept file (sync, plan §8.1) to index as it is on disk. */
export interface IndexFromFileInput {
  sourceId: string;
  /** Repo-relative posix path of the file. */
  path: string;
  /** The file's bytes and their digest (what `file_digest` records). */
  raw: string;
  digest: string;
  role: SourceRole;
  /** Force the destination topic (slug or name), e.g. the topic a dedicated source is bound to. */
  topic?: string;
  /** Status for a file that declares none (the source's `default_status`); else the instance fallback. */
  defaultStatus?: 'draft' | 'published';
  /** Row already known to hold this file (a rename matched by its old path). */
  pageId?: string;
  /** Owner/editor to record: the file's `e3_owner_id` when it is a known user, else the system actor. */
  actorId: string;
}

export interface IndexFromFileResult {
  item: PageView;
  action: 'created' | 'updated';
  diagnostics: Diagnostic[];
  /** True when the lint found error-severity diagnostics (a new item then landed as a draft). */
  lintFailed: boolean;
}

@Injectable()
export class ContentCommandsService implements ContentCommands {
  constructor(
    private readonly items: ItemsService,
    private readonly pages: PagesService,
    private readonly spaces: SpacesService,
    private readonly paths: ContentPathResolver,
    private readonly stores: ContentStoreRegistry,
    private readonly sources: SourceRegistryService,
    private readonly review: ReviewService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async create(actor: ServerActor, input: CreateCommandInput, source: WriteSource): Promise<WriteResult> {
    const ctx = await this.lintContext(input.space);
    const write = foldTaxonomy(input);
    const page = await this.createWriteFirst(
      actor.userId,
      source === 'ui' ? uiCreateInput(write) : normalizeCreateInput(write),
      gateFor(actor, source, ctx, (input as { allow_lint_errors?: boolean }).allow_lint_errors),
    );
    return this.withDiagnostics(source === 'ui' ? page : toItem(page), ctx);
  }

  async update(
    actor: ServerActor,
    id: string,
    input: UpdateCommandInput,
    ifMatch: number,
    source: WriteSource,
  ): Promise<WriteResult> {
    const ctx = await this.lintContext();
    const write = foldTaxonomy(input);
    const page = await this.updateWriteFirst(
      actor,
      id,
      ifMatch,
      source === 'ui' ? write : normalizeUpdateInput(write),
      gateFor(actor, source, ctx, input.allow_lint_errors),
    );
    return this.withDiagnostics(source === 'ui' ? page : toItem(page), ctx);
  }

  /** Publication status → published; with `reviewed`, also records a human verification (OKF `verified[]`). */
  async publish(
    actor: ServerActor,
    id: string,
    opts: { reviewed?: boolean; allowLintErrors?: boolean } = {},
  ): Promise<WriteResult> {
    return this.stamp(actor, id, {
      status: 'published',
      reviewed: opts.reviewed === true,
      allowLintErrors: opts.allowLintErrors === true,
    });
  }

  /** Appends `{ by: actor, at: now }` to OKF `verified[]` without touching publication status. */
  async verify(actor: ServerActor, id: string): Promise<WriteResult> {
    return this.stamp(actor, id, { reviewed: true });
  }

  /**
   * Rename, write-first (plan §8.3): a rename is a content change to the
   * subject **and** to every page whose inbound wiki-links it rewrites, so all
   * of their files are rendered and written before a single row moves.
   *
   * Order — the same one `updateWriteFirst` uses, widened to N pages:
   *  1. plan the whole rename (`prepareRename`): validation, permission and
   *     rowversion checks, plus the on-disk digest guard for every file it will
   *     touch. A 400/403/404/409 here leaves disk and index untouched.
   *  2. write every file. A failure part-way restores the ones already written
   *     and nothing is indexed.
   *  3. one transaction for all N pages (rows, versions, links, FTS, `file_*`
   *     columns, one outbox row per file). It re-checks every rowversion, so a
   *     concurrent edit rolls the whole rename back — and the files go back to
   *     what they held.
   *  4. per page, the mirror (or, in a `review` source, staging on its item
   *     branch). Never before the index: git is not in the request path.
   *
   * The index can therefore never be ahead of the files; a crash between 2 and
   * 3 leaves the files ahead, which a reindex reconciles — exactly the
   * single-page write-first contract.
   */
  async rename(actor: ServerActor, id: string, newTitle: string, opts: RenameOptions = {}): Promise<RenameResult> {
    const ctx = await this.lintContext();
    const readActor = readActorOf(actor);
    const expected = opts.ifMatch ?? (await this.currentVersion(id, actor));
    const prepared = await this.pages.prepareRename(
      readActor,
      id,
      expected,
      newTitle,
      opts.linkAction ?? 'update_all',
      opts.expectedAffectedVersions ?? {},
      nowIso(),
    );

    const planned = await this.planRenameWrites(prepared);
    await this.writeRenameFiles(planned);
    let outcome: RenameOutcome;
    try {
      outcome = await this.pages.applyRename(readActor, prepared, renameFileRefs(planned));
    } catch (err) {
      // Compensation: the index rejected the rename, so every file this attempt
      // rewrote goes back to the bytes the index still describes.
      await restoreRenameFiles(planned);
      throw err;
    }

    for (const write of planned) {
      const page = await this.pages.getById(write.plan.page.id);
      if (!page) continue;
      if (write.review) await this.stageForReview(write.review, page, [write.file.path], actor.userId);
      else await this.items.emitMirror(actor.userId, page);
    }
    const page = (await this.pages.getById(id)) ?? outcome.page;
    return { ...(await this.withDiagnostics(page, ctx)), affected_pages: outcome.affected_pages };
  }

  /**
   * Move an item to another topic (plan 8.3, issue 84) — including into a topic
   * that lives in a **different repository**.
   *
   * A move is a topic change and nothing else, so it is expressed as exactly
   * that: an update whose only input is the new `topic`. Everything that makes a
   * move hard — writing the file at the new path, unlinking it at the old one,
   * the second outbox row, the second repo's commit, the guards on both ends —
   * lives in `updateWriteFirst`, because a topic change arrives through
   * `update` from every other door too (REST, MCP, the editor). Fixing it there
   * rather than here is what stops `update` orphaning the old file; see the
   * relocation block below.
   *
   * The slug is allocated instance-wide and a move never changes it, so
   * `/p/:slug` and `/items/:id` keep resolving with no alias table.
   */
  async move(actor: ServerActor, id: string, targetTopic: string, opts: { ifMatch?: number } = {}): Promise<WriteResult> {
    const ifMatch = opts.ifMatch ?? (await this.currentVersion(id, actor));
    return this.update(actor, id, { frontmatter: { topic: targetTopic } }, ifMatch, actor.via?.kind ?? 'rest');
  }

  /**
   * Soft delete, file first (issue 76) — the same ordering `updateWriteFirst`
   * uses, with the file removed instead of rewritten:
   *  1. resolve the file from the ROW's `file_path`/`source_id`, never by
   *     re-resolving the item's topic (see `planDeparture`: after a move the
   *     topic points at the repository the item arrived in);
   *  2. refuse a `read-only` source (403) and a file that drifted underneath the
   *     index (409 `changed_on_disk`), before anything is touched;
   *  3. unlink the file;
   *  4. soft-delete the row, with the `delete` outbox row in the same
   *     transaction. On failure the file goes back — the index still describes
   *     it. A crash between 3 and 4 leaves the file gone and the row alive,
   *     which is the files-ahead-of-the-index state the whole write path is
   *     built to allow: a reindex reconciles it by dropping the item, which is
   *     the end state this call was asking for anyway;
   *  5. the mirror (or, in a `review` source, the removal staged on the item
   *     branch) commits it.
   */
  async remove(actor: ServerActor, id: string): Promise<void> {
    const readActor = readActorOf(actor);
    const page = await this.pages.getById(id, { actor: readActor });
    const recorded = page ? await this.pages.canonicalFileOf(id) : null;
    const departure = page && recorded ? await this.planRemoval(page, recorded) : null;
    if (!page || !recorded || !departure) {
      // No row (`softDelete` raises the 404), a row that never recorded a file,
      // or a recorded source we cannot locate: there is nothing to unlink, so
      // the index is the whole of this delete — as it was before inversion.
      await this.pages.softDelete(readActor, id);
      return;
    }

    assertWritable(departure.from);
    const review = await this.reviewSourceFor(departure.from);
    // Same carve-out as `updateWriteFirst`: in a `review` source the
    // working-tree copy is deliberately the BASE-branch version (staging
    // restores it), so it never matches the indexed digest and this guard would
    // fire on every delete.
    if (!review && recorded.digest && departure.onDisk && departure.onDisk.digest !== recorded.digest) {
      throw changedOnDisk(departure.path);
    }

    if (departure.onDisk) await departure.store.remove(departure.path);
    try {
      await this.pages.softDelete(readActor, id, {
        path: departure.path,
        digest: recorded.digest ?? departure.onDisk?.digest ?? '',
        sourceId: departure.from.sourceId,
      });
    } catch (err) {
      // Compensation: the index refused, so the bytes it still describes go
      // back where it says they are.
      await restoreFile(departure.store, departure.path, departure.onDisk);
      throw err;
    }

    if (review) {
      // Issue 80: the removal is proposed on the item branch. The item is gone
      // from this index NOW and the change request carries the intent upstream
      // — the same contract create/update have (the index updates now; the
      // change request is what reaches the base branch).
      //
      // If that change request is CLOSED rather than merged, the reviewer has
      // said the item should stay: `ReviewService.reconcile` restores it from
      // the base-branch file (issue 96), because nothing else would — inbound
      // sync only visits the paths that changed between two commits, so an
      // untouched file is never revisited. That restore goes through
      // `indexFromFile`, not through `restore` below: the base-branch copy may
      // have been edited upstream while the change request sat open, and this
      // row is then the stale one.
      await this.stageForReview(review, page, [departure.path], actor.userId, { intent: 'remove' });
      return;
    }
    await this.items.emitRemoved(actor.userId, page, departure.from, departure.path);
  }

  /**
   * Restore, file first — the mirror image of `remove`: the concept file is
   * re-rendered from the deleted row and written before the row comes back, so
   * the index is never ahead of the files.
   *
   * The destination is resolved from the item's TOPIC, not from the source the
   * row recorded: the file is gone, and the item belongs wherever its topic
   * lives today. `pages.restore` therefore re-records `file_*` from what was
   * written here.
   */
  async restore(actor: ServerActor, id: string): Promise<WriteResult> {
    const ctx = await this.lintContext();
    const readActor = readActorOf(actor);
    const deleted = await this.pages.getById(id, { includeDeleted: true, actor: readActor });
    // Unknown item (or one this actor cannot see): let the delegate raise its own 404.
    if (!deleted) return this.withDiagnostics(await this.pages.restore(readActor, id), ctx);

    const target = await this.paths.resolve(deleted.space_id);
    assertWritable(target);
    const file = renderConceptFile(deleted, await this.pages.spaceNameOf(deleted.space_id), target.conceptDir);
    const store = this.stores.forRepo(target.repoDir);
    const onDisk = await readIfExists(store, file.path);
    let digest: string;
    try {
      ({ digest } = await store.write(file.path, file.content, { expectDigest: onDisk?.digest ?? '' }));
    } catch (err) {
      if (err instanceof DigestMismatchError) throw changedOnDisk(file.path);
      throw err;
    }

    let page: PageView;
    try {
      page = await this.pages.restore(readActor, id, { path: file.path, digest, sourceId: target.sourceId });
    } catch (err) {
      await restoreFile(store, file.path, onDisk);
      throw err;
    }
    const review = await this.reviewSourceFor(target);
    if (review) page = await this.stageForReview(review, page, [file.path], actor.userId);
    else await this.items.emitMirror(actor.userId, page);
    return this.withDiagnostics(page, ctx);
  }

  /** The content-model lint with the live vocabularies filled in unless the caller supplied them. */
  async lint(raw: string, ctx: LintOptions = {}): Promise<Diagnostic[]> {
    const live = await this.lintContext(ctx.space);
    return lintDocument(raw, { ...live, ...ctx, known: ctx.known ?? live.known, resolvableSlugs: ctx.resolvableSlugs ?? live.resolvableSlugs });
  }

  // --- inbound (git → index) -----------------------------------------------

  /**
   * Index a concept file that already IS the canonical file (it arrived through
   * a fetch/merge, plan §8.1): nothing is written, `file_digest` is the on-disk
   * digest, and no outbox row is produced (there is nothing to push). The file
   * is mapped as a rebuild maps it (`conceptToImport` → the importer's
   * `toE3Frontmatter`, corrected for `type`/`description` the way
   * `IndexRebuildService` does), then matched by `e3_id`, then by slug within
   * the target topic. Lint runs in warn mode (§12 decision 6) and the publish
   * gate does NOT apply here: a file with error-severity diagnostics still
   * lands — a new item as a `draft`, an existing item with its status unchanged
   * — and the caller records the diagnostics for Content health. Refusing it
   * would break the mirror and silently lose somebody else's content.
   * A new item in an `authoritative` source that carries no id gets one written
   * back into its file through the normal debounced committer.
   */
  async indexFromFile(input: IndexFromFileInput): Promise<IndexFromFileResult> {
    const item = conceptToImport(input.raw);
    const frontmatter = e3FrontmatterFromFile(input.raw, item);
    if (input.topic) frontmatter['topic'] = input.topic;
    const fileStatus: 'draft' | 'published' = importedStatus(item.status, input.defaultStatus);
    const topicRef = spaceRefOf(frontmatter);

    const ctx = await this.lintContext(topicRef);
    const diagnostics = lintDocument(input.raw, { ...ctx, published: fileStatus === 'published' });
    const lintFailed = diagnostics.some((d) => d.severity === 'error');

    const actor: ReadActor = { id: input.actorId, role: 'admin' };
    const file = { path: input.path, digest: input.digest, sourceId: input.sourceId, enqueue: false };
    const identity = await this.pages.allocateIdentity(item.title, topicRef, item.e3Id);

    // Match: a known row (rename), then `e3_id` (restoring a soft-deleted row
    // the file came back for), then the file's slug within the target topic.
    let existing: PageView | null = null;
    for (const id of [input.pageId, item.e3Id]) {
      if (!id || existing) continue;
      existing = await this.pages.getById(id);
      if (!existing && (await this.pages.getById(id, { includeDeleted: true }))) {
        existing = await this.pages.restore(actor, id);
      }
    }
    const fileSlug = slugFromPath(input.path);
    if (!existing) {
      const bySlug = await this.pages.getBySlug(fileSlug);
      if (bySlug && bySlug.space_id === identity.spaceId) existing = bySlug;
    }

    if (existing) {
      const status = lintFailed ? existing.status : fileStatus;
      frontmatter['status'] = status;
      const page = await this.pages.update(actor, existing.id, existing.version_token, {
        title: item.title,
        body: item.body,
        frontmatter,
        status,
        tags: item.tags,
        file,
      });
      return { item: page, action: 'updated', diagnostics, lintFailed };
    }

    const status = lintFailed ? 'draft' : fileStatus;
    frontmatter['status'] = status;
    const create = (slug: string): Promise<PageView> =>
      this.pages.create(input.actorId, {
        id: item.e3Id,
        slug,
        title: item.title,
        body: item.body,
        frontmatter,
        status,
        tags: item.tags,
        file,
      });
    let page: PageView;
    try {
      page = await create(fileSlug);
    } catch (err) {
      // The file's slug belongs to another item (any topic, or a deleted one): take a free one.
      if (!(err instanceof ConflictException) || identity.slug === fileSlug) throw err;
      page = await create(identity.slug);
    }

    // Write the fresh id back into the file (authoritative sources only) —
    // through the mirror, which rewrites the file, reconciles the digest, and
    // schedules the commit. Only when the mirror would land on this very file.
    if (input.role === 'authoritative' && !item.e3Id) {
      const target = await this.paths.resolve(page.space_id);
      const rendered = renderConceptFile(page, identity.spaceName, target.conceptDir);
      if (target.sourceId === input.sourceId && rendered.path === input.path) {
        await this.items.emitMirror(input.actorId, page);
      }
    }
    return { item: page, action: 'created', diagnostics, lintFailed };
  }

  // --- write-first ---------------------------------------------------------

  /**
   * Create, file first:
   *  1. compute what will be persisted (`prepareCreate`) and reserve id/slug/space;
   *  2. render the concept file and write it atomically — it must not exist yet
   *     (an identical file left by an earlier run is accepted as-is);
   *  3. index it: row + version + taxonomy/links/FTS + outbox row, one transaction,
   *     with the same `now` so the row equals the file; on failure remove the file;
   *  4. hand the persisted version to the mirror (it finds the file identical and
   *     only schedules the commit).
   */
  private async createWriteFirst(actorId: string, input: CreatePageInput, gate?: PublishGate): Promise<PageView> {
    const now = nowIso();
    const prepared = this.pages.prepareCreate(input, now);
    // An item created ALREADY published never passes through the draft→published
    // transition the gate watches, so without this any door could publish
    // anything by creating it published in one call and the gate would be
    // advisory — for an agent over MCP, a script over REST, and a Compose
    // "Publish" on an item that was never saved as a draft alike.
    //
    // The lint runs on `prepared.raw` — the document `prepareCreate` assembled,
    // not the caller's `body`. A structured call (`title` + `body` +
    // `categories: [...]`) carries its metadata in fields, and linting the body
    // alone would refuse a perfectly conformant create.
    //
    // Every interactive source, not only `mcp` (issue 98). It was MCP-only
    // until the test fixtures that created non-conformant published items over
    // REST were made conformant — that was fixture work, never a reason for the
    // gate to differ by door. `assertPublishable` itself keeps `git`/`import`
    // out, so there is no source test here to drift from that one.
    if (gate && prepared.status === 'published') {
      await this.assertPublishable(gate, {
        raw: prepared.raw,
        space: spaceRefOf(prepared.parsed.frontmatter),
        pageId: null,
        operation: 'create',
        title: prepared.title,
        slug: null,
      });
    }
    const identity = await this.pages.allocateIdentity(prepared.title, spaceRefOf(prepared.parsed.frontmatter), input.id);
    const target = await this.paths.resolve(identity.spaceId);
    assertWritable(target);
    const file = renderConceptFile(
      {
        id: identity.id,
        slug: identity.slug,
        title: prepared.title,
        raw_markdown: prepared.raw,
        status: prepared.status,
        space_id: identity.spaceId,
        owner_id: actorId,
        ...prepared.taxonomy,
        created_at: now,
        updated_at: now,
        version_token: 1,
        current_version_id: null,
      },
      identity.spaceName,
      target.conceptDir,
    );
    const store = this.stores.forRepo(target.repoDir);
    const written = await writeNewFile(store, file);

    let page: PageView;
    try {
      page = await this.pages.create(actorId, {
        ...input,
        id: identity.id,
        slug: identity.slug,
        now,
        file: { path: file.path, digest: written.digest, sourceId: target.sourceId },
      });
    } catch (err) {
      // Compensation: the index rejected the write, so the file we just added
      // must not stay behind as an orphan the next rebuild would pick up.
      if (written.created) await store.remove(file.path).catch(() => undefined);
      throw err;
    }
    const review = await this.reviewSourceFor(target);
    if (review) return this.stageForReview(review, page, [file.path], actorId);
    await this.items.emitMirror(actorId, page);
    return page;
  }

  /**
   * Update, file first:
   *  1. compute the next version against the current row (404/403/409 run here,
   *     before anything is touched);
   *  1b. run the publish gate when this save is the draft→published transition
   *     (422 `lint_failed`), before the file is touched;
   *  2. if the row tracks a file digest and the file on disk differs, the file
   *     was changed underneath the index → 409 `changed_on_disk` (reindex first);
   *  3. render and write the file, digest-checked against what was on disk;
   *  3b. **relocation** (plan 8.3): when the write lands the item at a different
   *     path — a topic change, possibly into another repository — unlink the
   *     file at the old path before the index records the new one, so the two
   *     never describe two files;
   *  4. index it in one transaction (+ outbox row); on failure put the previous
   *     file content back — at BOTH paths;
   *  5. the departure's own outbox row (`kind: 'move'`), then both mirrors: the
   *     repo the item left commits the removal, the repo it arrived in commits
   *     the file. Each commit carries the item id.
   */
  private async updateWriteFirst(
    actor: ServerActor,
    id: string,
    ifMatch: number,
    input: UpdatePageInput,
    gate: PublishGate,
  ): Promise<PageView> {
    const readActor = readActorOf(actor);
    const now = nowIso();
    const prepared = await this.pages.prepareUpdate(readActor, id, ifMatch, input, now);
    const { current } = prepared;
    // The gate tests the TRANSITION, never the state. An item that is already
    // published is edited and autosaved like any other — much of the existing
    // corpus predates these rules, and refusing every save of it would make the
    // library read-only, which is worse than warn mode. The moment an author
    // chooses to publish is the moment they are asked to satisfy the rules.
    if (prepared.status === 'published' && (await this.statusOf(id)) !== 'published') {
      await this.assertPublishable(gate, {
        raw: prepared.raw,
        space: prepared.spaceId,
        pageId: id,
        // Only the transition reaches here, so from an existing item every
        // refusal is a refused publish, whichever verb carried it.
        operation: 'publish',
        title: prepared.title,
        slug: current.slug,
        topic: prepared.spaceName,
      });
    }
    const target = await this.paths.resolve(prepared.spaceId);
    assertWritable(target);
    const file = renderConceptFile(
      {
        id: current.id,
        slug: current.slug,
        title: prepared.title,
        raw_markdown: prepared.raw,
        status: prepared.status,
        space_id: prepared.spaceId,
        owner_id: current.owner_id,
        ...prepared.taxonomy,
        created_at: current.created_at,
        updated_at: now,
        version_token: current.version_token + 1,
        current_version_id: null,
      },
      prepared.spaceName,
      target.conceptDir,
    );
    // The file is about to land at `file.path` in `target`; if the row records a
    // different file, that one is leaving. Both ends are guarded (read-only,
    // review) and the departure's digest is checked before anything is written.
    const departure = await this.planDeparture(current, target, file.path);
    await this.assertRelocationAllowed(current.source_id, target, departure);
    // The same `changed_on_disk` guard an in-place edit gets, applied to the file
    // the item is LEAVING: if it drifted underneath the index the move would
    // delete an edit nobody indexed. Refuse; a reindex picks the edit up first.
    // (A departure never coexists with review mode — that combination is refused
    // above — so the review exemption below does not apply here.)
    if (departure && current.file_digest && departure.onDisk && departure.onDisk.digest !== current.file_digest) {
      throw changedOnDisk(departure.path);
    }

    const store = this.stores.forRepo(target.repoDir);
    const onDisk = await readIfExists(store, file.path);

    const review = await this.reviewSourceFor(target);
    const samePath = current.file_path === file.path && current.source_id === target.sourceId;
    // In a `review` source the working-tree copy is deliberately the BASE-branch
    // version (staging restores it), so it never matches the indexed digest —
    // the on-disk guard would fire on every second save. The item branch, not
    // the working tree, is where the indexed content lives.
    if (!review && current.file_digest && samePath && onDisk && onDisk.digest !== current.file_digest) {
      throw changedOnDisk(file.path);
    }
    let digest: string;
    try {
      ({ digest } = await store.write(file.path, file.content, { expectDigest: onDisk?.digest ?? '' }));
    } catch (err) {
      if (err instanceof DigestMismatchError) throw changedOnDisk(file.path);
      throw err;
    }

    // The item has arrived at its new path; unlink the old one. Removing before
    // the index transaction keeps the rule the whole write path is built on —
    // the index is never AHEAD of the files. A crash here leaves the files ahead
    // (the item at its new path only, the index still naming the old one), which
    // is what a reindex reconciles; it never leaves two files with one `e3_id`.
    if (departure) {
      try {
        await departure.store.remove(departure.path);
      } catch (err) {
        await restoreFile(store, file.path, onDisk);
        throw err;
      }
    }

    let page: PageView;
    try {
      page = await this.pages.update(readActor, id, ifMatch, {
        ...input,
        now,
        file: { path: file.path, digest, sourceId: target.sourceId },
      });
    } catch (err) {
      // Compensation: restore what was on disk before this attempt — the file
      // the item left first, so the bytes the index still describes are back
      // where it says they are, then the arrival path.
      if (departure) await restoreFile(departure.store, departure.path, departure.onDisk);
      await restoreFile(store, file.path, onDisk);
      throw err;
    }
    if (review) return this.stageForReview(review, page, [file.path], actor.userId);

    if (departure) {
      // The departure's own outbox row, enqueued AFTER the index transaction so
      // that a pending row always implies the index landed. It is what keeps the
      // source repo's commit outstanding while the target repo's `upsert` row
      // settles on its own commit — the two are matched by `file_path`.
      await this.outbox.enqueue({
        kind: 'move',
        page_id: id,
        source_id: departure.from.sourceId,
        file_path: departure.path,
        file_digest: departure.onDisk?.digest ?? null,
        actor_id: actor.userId,
      });
      await this.items.emitMovedOut(actor.userId, page, departure.from, departure.path);
    }
    await this.items.emitMirror(actor.userId, page, { movedIn: departure !== null });
    // Push on publish (plan §12 decision 1): a save that publishes asks the
    // sync engine to push once the debounced commit lands; drafts wait for the timer.
    if (input.status === 'published') this.requestPush(target.sourceId);
    if (departure && departure.from.sourceId !== target.sourceId && input.status === 'published') {
      this.requestPush(departure.from.sourceId);
    }
    return page;
  }

  // --- relocation (topic move), plan 8.3 ------------------------------------

  /**
   * Re-emit the departure half of a move whose commit never landed — the outbox
   * replay's entry point for a pending `move` row. The file is already gone from
   * disk and the index already names the new path; all that is outstanding is
   * the old repo's commit of the removal, which nothing else would ever stage
   * (the committer's `git add` is path-scoped). Best-effort, like the replay of
   * an `upsert` row.
   */
  async replayMovedOut(pageId: string, sourceId: string, path: string, actorId: string): Promise<void> {
    const page = await this.pages.getById(pageId);
    if (!page) return;
    const target = await this.paths.resolve(page.space_id);
    const from = await this.sourceRefOf(sourceId, target);
    if (!from) return;
    await this.items.emitMovedOut(actorId, page, from, path);
  }

  /**
   * Re-emit the removal of a soft-deleted item's file whose commit never landed
   * — the replay's entry point for a pending `delete` row. The file is already
   * gone from disk and the row is already deleted; all that is outstanding is
   * the repo's commit of the removal, which nothing else would ever stage (the
   * committer's `git add` is path-scoped). Best-effort, like `replayMovedOut`.
   *
   * An item that was RESTORED since is skipped: its restore wrote the file back
   * and enqueued its own `upsert` row, so re-emitting the removal here would
   * unlink a file the index legitimately describes.
   */
  async replayRemoved(pageId: string, sourceId: string, path: string, actorId: string): Promise<void> {
    if (await this.pages.getById(pageId)) return;
    const page = await this.pages.getById(pageId, { includeDeleted: true });
    if (!page) return;
    const target = await this.paths.resolve(page.space_id);
    const from = await this.sourceRefOf(sourceId, target);
    if (!from) return;
    await this.items.emitRemoved(actorId, page, from, path);
  }

  /**
   * The file this write leaves behind, if any: the path/source the row records,
   * when the write is landing somewhere else. Resolves the repository from the
   * **row's** `source_id` rather than from the item's topic — after the write
   * the topic points at the repo it moved INTO, so re-resolving would unlink the
   * wrong tree. Returns null when there is nothing to leave (a create, a row
   * that never recorded a file, or an in-place edit), or when the recorded
   * source is not one we can locate.
   */
  private async planDeparture(
    current: PreparedUpdate['current'],
    target: ContentTarget,
    nextPath: string,
  ): Promise<Departure | null> {
    const fromPath = current.file_path;
    if (!fromPath) return null;
    // A row written before source ids existed is assumed to sit in the repo its
    // topic resolves to today; that is the only tree we could look in anyway.
    const fromSourceId = current.source_id ?? target.sourceId;
    if (fromSourceId === target.sourceId && fromPath === nextPath) return null;
    const from = await this.sourceRefOf(fromSourceId, target);
    if (!from) return null;
    const store = this.stores.forRepo(from.repoDir);
    return { from, path: fromPath, store, onDisk: await readIfExists(store, fromPath) };
  }

  /**
   * The file a soft delete unlinks: where the ROW says it is, in the repository
   * that row's `source_id` names. Same rule (and the same reason) as
   * `planDeparture` — re-resolving the item's topic can name a repository the
   * file was never in. Null when the row records no file, or when the recorded
   * source cannot be located.
   */
  private async planRemoval(
    page: PageView,
    recorded: { path: string | null; sourceId: string | null },
  ): Promise<Departure | null> {
    if (!recorded.path) return null;
    const target = await this.paths.resolve(page.space_id);
    const from = await this.sourceRefOf(recorded.sourceId ?? target.sourceId, target);
    if (!from) return null;
    const store = this.stores.forRepo(from.repoDir);
    return { from, path: recorded.path, store, onDisk: await readIfExists(store, recorded.path) };
  }

  /**
   * Where the repo behind a source id lives, with the remote the mirror should
   * push the departure to. Mirrors `ContentPathResolver.resolve`, but keyed by
   * source id (the resolver is keyed by topic).
   */
  private async sourceRefOf(sourceId: string, target: ContentTarget): Promise<SourceRef | null> {
    if (sourceId === target.sourceId) {
      return {
        sourceId,
        repoDir: target.repoDir,
        remoteUrl: target.remoteUrl,
        branch: target.branch,
        credential: target.credential,
        mode: target.mode,
      };
    }
    const row = await this.sources.get(sourceId);
    if (row) {
      return {
        sourceId,
        repoDir: this.paths.dirOf(row),
        remoteUrl: row.enabled === 1 ? row.remote_url : null,
        branch: row.branch,
        credential: gitCredentialOf(row),
        mode: row.mode,
      };
    }
    // Same fallback the resolver uses for an unregistered main repo.
    if (sourceId === 'main') {
      return {
        sourceId,
        repoDir: this.paths.mainDir,
        remoteUrl: loadServerConfig().git.mainRemote ?? null,
        branch: null,
        credential: null,
        mode: 'direct',
      };
    }
    return null;
  }

  /**
   * Both ends of a relocation are guarded, before anything is written:
   *
   *  - **read-only** (plan §8.2): a move OUT of a read-only source is a
   *    `403 source_read_only` just as a move INTO one already was — the write
   *    would delete a file nobody here publishes.
   *  - **review** (issue 80): unchanged for a cross-source move, and now also
   *    refused for a same-source move between two subtrees, because staging
   *    restores the working tree to the base version and has no way to carry the
   *    departure onto the item branch. Same `409 review_unsupported_operation`.
   */
  private async assertRelocationAllowed(
    currentSourceId: string | null,
    target: ContentTarget,
    departure: Departure | null,
  ): Promise<void> {
    if (currentSourceId && currentSourceId !== target.sourceId) {
      assertNotReviewMode(target.mode, target.sourceId, 'topic move');
      const from = await this.sources.get(currentSourceId);
      assertNotReviewMode(from?.mode ?? 'direct', currentSourceId, 'topic move');
    } else if (departure) {
      assertNotReviewMode(target.mode, target.sourceId, 'topic move');
    }
    if (departure) assertWritable(departure.from);
  }

  // --- rename, write-first --------------------------------------------------

  /**
   * Resolve, render and digest-check every file a prepared rename will rewrite,
   * without writing anything. Runs the same guards a single-page update runs —
   * a `read-only` source is refused (403) and a file that drifted underneath
   * the index is refused (409 `changed_on_disk`) — for the subject and for
   * every affected page, so one bad page stops the whole rename before disk is
   * touched.
   */
  private async planRenameWrites(prepared: PreparedRename): Promise<PlannedRenameWrite[]> {
    const planned: PlannedRenameWrite[] = [];
    for (const plan of prepared.writes) {
      const target = await this.paths.resolve(plan.page.space_id);
      assertWritable(target);
      const file = renderConceptFile(
        {
          ...plan.page,
          title: plan.nextTitle,
          raw_markdown: plan.nextRaw,
          updated_at: prepared.now,
          version_token: plan.page.version_token + 1,
          current_version_id: null,
        },
        plan.spaceName,
        target.conceptDir,
      );
      const store = this.stores.forRepo(target.repoDir);
      const onDisk = await readIfExists(store, file.path);
      const review = await this.reviewSourceFor(target);
      const samePath = plan.filePath === file.path && plan.sourceId === target.sourceId;
      // Same rule as `updateWriteFirst`: in a review source the working-tree
      // copy is deliberately the base-branch version, so the guard is skipped.
      if (!review && plan.fileDigest && samePath && onDisk && onDisk.digest !== plan.fileDigest) {
        throw changedOnDisk(file.path);
      }
      planned.push({ plan, store, file, onDisk, review, sourceId: target.sourceId, digest: '', written: false });
    }
    return planned;
  }

  /**
   * Write every planned file. On the first failure the files already written
   * are put back, so a partial rename never reaches disk and the index — which
   * has not been touched yet — still describes what is there.
   */
  private async writeRenameFiles(planned: PlannedRenameWrite[]): Promise<void> {
    for (const write of planned) {
      try {
        const { digest } = await write.store.write(write.file.path, write.file.content, {
          expectDigest: write.onDisk?.digest ?? '',
        });
        write.digest = digest;
        write.written = true;
      } catch (err) {
        await restoreRenameFiles(planned);
        if (err instanceof DigestMismatchError) throw changedOnDisk(write.file.path);
        throw err;
      }
    }
  }

  // --- review policy (plan §8.2) -------------------------------------------

  /**
   * The registry row when this target stages writes for review; null for
   * `direct`/`read-only`. Keyed on policy alone, so it answers for a source
   * reached through `ContentPathResolver` (where a write is going) as well as
   * for one reached through the registry (where a delete's file actually is).
   */
  private async reviewSourceFor(target: {
    mode: SyncMode;
    remoteUrl: string | null;
    sourceId: string;
  }): Promise<SourceRow | null> {
    if (target.mode !== 'review' || !target.remoteUrl) return null;
    return this.sources.get(target.sourceId);
  }

  /**
   * The file and the index are written; hand the file to the change request
   * instead of the debounced committer, then read the row back — staging turns
   * the item into a draft with an open review and restores the working-tree
   * copy to the base-branch version.
   */
  private async stageForReview(
    source: SourceRow,
    page: PageView,
    paths: string[],
    actorId: string,
    opts: { intent?: StageIntent } = {},
  ): Promise<PageView> {
    // A removal has nothing to lint (the file is gone) and its change request is
    // titled from the intent rather than from the item.
    const options: StageOptions =
      opts.intent === 'remove'
        ? { intent: 'remove' }
        : { title: page.title, summary: await this.lintSummary(page) };
    await this.review.stage(source, page, paths, { id: actorId }, options);
    // Null after a staged removal (the row is soft-deleted): the pre-delete view
    // is the only one there is, and `remove` discards the result anyway.
    return (await this.pages.getById(page.id)) ?? page;
  }

  /** One line for the change-request body; never fails the write. */
  private async lintSummary(page: PageView): Promise<string> {
    try {
      const diagnostics = await this.lint(page.raw_markdown, {
        space: page.space_id ?? undefined,
        published: page.status === 'published',
      });
      const errors = diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
      return `Content lint: ${errors} error(s), ${warnings} warning(s).`;
    } catch {
      return 'Content lint: not run.';
    }
  }

  /** Best-effort, in the background: the engine (if one manages the source) flushes the commit and pushes. */
  private requestPush(sourceId: string): void {
    let sync: SyncPushPort | undefined;
    try {
      sync = this.moduleRef.get<SyncPushPort>(SYNC_PUSH, { strict: false });
    } catch {
      return;
    }
    void sync?.requestPush(sourceId, 'publish').catch(() => undefined);
  }

  // --- shared --------------------------------------------------------------

  /**
   * The publish gate (Eric's decision, 2026-09-11; supersedes plan §12 decision
   * 6 for this one moment). Error-severity lint diagnostics refuse the
   * **publish transition** from an interactive door; every other save, and every
   * inbound one, stays warn-only.
   *
   * Scope is deliberately the transition rather than the published state: the
   * measured corpus is 100% non-conformant (no `type`, no `description`), so
   * gating ordinary saves would brick it, while gating the transition costs
   * nothing — `validateForPublish` in Compose already refuses the same rule set
   * client-side, so for `ui` this is a backstop and for `rest`/`mcp` it is the
   * real gate. A create that lands published in one call is a publication too,
   * and is judged here the same way (issue 98).
   *
   * Every refusal is recorded as `content.refused` (plan B2) before it is
   * thrown — see `recordRefusal` for what the row carries and, deliberately,
   * what it does not.
   */
  private async assertPublishable(gate: PublishGate, next: PublishCandidate): Promise<void> {
    // Inbound stays warn-only: rejecting a file that arrived from somebody
    // else's repository would break the mirror and lose their content, which an
    // author here cannot fix the way they can fix their own document.
    if (!INTERACTIVE_SOURCES.has(gate.source)) return;
    const diagnostics = lintDocument(next.raw, { ...gate.ctx, space: next.space ?? gate.ctx.space, published: true });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length === 0) return;

    if (gate.allowLintErrors) {
      // Admin-only, on purpose. The gate's premise is that an author can fix
      // their own document, so the escape hatch is not theirs to reach for; it
      // exists for an operator publishing known-imperfect legacy content. It
      // also keeps an MCP agent — which writes as the user it is signed in as
      // (decision 4) — from waving its own diagnostics through.
      if (gate.actor.role !== 'admin') {
        await this.recordRefusal(gate, next, 'lint_override_forbidden', errors);
        throw new ForbiddenException({
          message: 'Only an admin may publish over error-severity lint diagnostics (allow_lint_errors)',
          reason: 'lint_override_forbidden',
          diagnostics: errors,
        });
      }
      await this.audit.record({
        actor_id: gate.actor.userId,
        action: 'content.publish_lint_override',
        page_id: next.pageId,
        payload: { source: gate.source, diagnostics: errors },
      });
      return;
    }
    await this.recordRefusal(gate, next, 'lint_failed', errors);
    throw lintRefusal(errors);
  }

  /**
   * One `content.refused` audit row per refused interactive publish (plan B2).
   *
   * Before this, a refusal existed only as a 422 in the caller's face: the
   * author saw it, the administrator never could. The row answers the
   * administrator's questions — who, through which door, which item, which
   * rules — and nothing else:
   *  - `rules` is the rule id and the frontmatter key, never the diagnostic
   *    `message`, which quotes the document back (`Unknown category "…"`);
   *  - never the body or the raw document: it is user-supplied text of unbounded
   *    size and unknown sensitivity, the same reason `okf.import_rejected`
   *    leaves the bundle out.
   * `page_id` is null for a refused create — no item exists, and the refusal is
   * the reason one never will — so `title` is what names it.
   *
   * Awaited before the throw, like every other audit write here: a failed insert
   * surfaces as an error rather than a refusal nobody can find later.
   */
  private async recordRefusal(
    gate: PublishGate,
    next: PublishCandidate,
    reason: 'lint_failed' | 'lint_override_forbidden',
    errors: Diagnostic[],
  ): Promise<void> {
    await this.audit.record({
      actor_id: gate.actor.userId,
      action: CONTENT_REFUSED_ACTION,
      page_id: next.pageId,
      payload: {
        reason,
        source: gate.source,
        operation: next.operation,
        title: next.title,
        slug: next.slug,
        topic: next.topic ?? next.space ?? null,
        rules: errors.map((d) => ({ code: d.code, path: d.path ?? null })),
      },
    });
  }

  /** Publication status of the row as it stands, for the transition test. */
  private async statusOf(id: string): Promise<'draft' | 'published' | null> {
    const current = await this.pages.getById(id);
    return current ? current.status : null;
  }

  private async stamp(
    actor: ServerActor,
    id: string,
    opts: { status?: 'published'; reviewed: boolean; allowLintErrors?: boolean },
  ): Promise<WriteResult> {
    const current = await this.pages.getById(id, { actor: readActorOf(actor) });
    if (!current) throw new NotFoundException('Page not found');
    const input: UpdateCommandInput = {};
    if (opts.status) input.status = opts.status;
    if (opts.allowLintErrors) input.allow_lint_errors = true;
    if (opts.reviewed) {
      input.frontmatter = {
        verified: [...normalizeVerified(current.frontmatter['verified']), { by: actor.okfActor, at: nowIso() }],
      };
    }
    return this.update(actor, id, input, current.version_token, actor.via?.kind ?? 'rest');
  }

  private async currentVersion(id: string, actor: ServerActor): Promise<number> {
    const current = await this.pages.getById(id, { actor: readActorOf(actor) });
    if (!current) throw new NotFoundException('Page not found');
    return current.version_token;
  }

  /**
   * Vocabularies as they stood BEFORE the write, so a tag or category that
   * exists only because of this very write still reads as new.
   *
   * Categories come from the CURATED catalog (`listCuratedCategories`), not the
   * union `listCategories` returns. Primary categories are curated, not
   * emergent (Eric, 2026-09-11 — issues 97/106): under the union, saving a
   * draft with `categories: [anything]` registered `anything` as usage, so
   * `category.unknown` — an error — could never fire on the publish that
   * followed. Tags stay usage-derived on purpose; `tag.unknown` is a warning
   * and tags ARE emergent vocabulary.
   *
   * Both the catalog slug and its display name are accepted, because a document
   * may name its category either way: the Publish drawer writes the slug
   * (`research-notes`), while hand-written and imported frontmatter often
   * carries the human label (`Research notes`). The lint compares
   * case-insensitively, so listing both is the whole of the leniency — an
   * invented term is still unknown.
   */
  private async lintContext(space?: string): Promise<LintContext & { known: NonNullable<LintContext['known']>; resolvableSlugs: Set<string> }> {
    const [tags, categories, groups, archivedGroups, slugs] = await Promise.all([
      this.spaces.listTags(),
      this.spaces.listCuratedCategories(),
      this.spaces.listGroups(),
      this.spaces.listArchivedGroupSlugs(),
      this.pages.listSlugs(),
    ]);
    return {
      space,
      known: {
        tags: tags.map((t) => t.slug),
        categories: categories.flatMap((c) => (c.name && c.name !== c.slug ? [c.slug, c.name] : [c.slug])),
        groups: groups.map((g) => g.slug),
        // Issue 117: an archived group named in frontmatter is linked, not restored — warn.
        archivedGroups,
      },
      resolvableSlugs: new Set(slugs),
    };
  }

  private async withDiagnostics(item: ItemView, ctx: LintContext & { resolvableSlugs: Set<string> }): Promise<WriteResult> {
    ctx.resolvableSlugs.add(item.slug);
    const diagnostics = lintDocument(item.raw_markdown, {
      ...ctx,
      space: ctx.space ?? item.space_id ?? undefined,
      published: item.status === 'published',
    });
    return { item, diagnostics };
  }
}

/**
 * The doors an author writes through, where a refusal is actionable: they can
 * fix the document in front of them. `git` and `import` are deliberately absent
 * — see `assertPublishable`.
 */
const INTERACTIVE_SOURCES: ReadonlySet<WriteSource> = new Set<WriteSource>(['ui', 'rest', 'mcp']);

/**
 * The audit action for a publish the gate refused (plan B2). Exported so the
 * tests and anything that filters on it name the one string.
 */
export const CONTENT_REFUSED_ACTION = 'content.refused';

/** The document a publish would land, and enough about it to name a refusal. */
interface PublishCandidate {
  raw: string;
  /** The topic ref the lint resolves against (a slug/name on create, the space id on update). */
  space?: string;
  /** Null for a create: nothing exists yet. */
  pageId: string | null;
  operation: 'create' | 'publish';
  title: string;
  slug: string | null;
  /** The topic's display name when known; `space` stands in for it otherwise. */
  topic?: string | null;
}

/** What the publish gate needs to judge a write before anything reaches disk. */
interface PublishGate {
  actor: ServerActor;
  source: WriteSource;
  /** Vocabularies as they stood BEFORE the write — the same context the diagnostics are built from. */
  ctx: LintContext & { resolvableSlugs: Set<string> };
  /** The caller explicitly asked to publish over error-severity diagnostics (admin only, audited). */
  allowLintErrors: boolean;
}

function gateFor(
  actor: ServerActor,
  source: WriteSource,
  ctx: LintContext & { resolvableSlugs: Set<string> },
  allowLintErrors: boolean | undefined,
): PublishGate {
  return { actor, source, ctx, allowLintErrors: allowLintErrors === true };
}

/**
 * 422, not 409 or 403: the request is well-formed and the caller is allowed to
 * make it — the *document* is semantically wrong for publication. 409 in this
 * codebase means two writers disagree about state (`changed_on_disk`, a stale
 * version token) and 403 means policy forbids the caller (`source_read_only`);
 * neither describes "your frontmatter is missing a description". The body
 * carries the diagnostics so the caller can fix them rather than guess.
 */
function lintRefusal(diagnostics: Diagnostic[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `This item cannot be published until ${diagnostics.length} content-model error(s) are fixed`,
    reason: 'lint_failed',
    diagnostics,
  });
}

/** The `/pages` door's mapping onto `PagesService.create` (unchanged from before write-first). */
function uiCreateInput(write: CreateCommandInput): CreatePageInput {
  return {
    id: write.id,
    title: write.title ?? '',
    body: write.body ?? '',
    raw: write.raw,
    frontmatter: write.frontmatter,
    status: write.status,
    tags: write.tags,
  };
}

/** The `space`/`topic` frontmatter value that decides the item's topic (same rule as `ensureSpace`). */
function spaceRefOf(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter['space'] ?? frontmatter['topic'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Write a brand-new concept file. If one already exists at the path it must be
 * the same content (modulo whitespace noise) — e.g. left by an earlier attempt
 * whose index transaction failed after the process died — in which case it is
 * kept as-is; anything else is a conflict the caller must resolve on disk.
 */
async function writeNewFile(store: LocalBundleStore, file: RenderedConceptFile): Promise<{ digest: string; created: boolean }> {
  try {
    const { digest } = await store.write(file.path, file.content, { expectDigest: '' });
    return { digest, created: true };
  } catch (err) {
    if (err instanceof DigestMismatchError && (await store.unchanged(file.path, file.content))) {
      return { digest: err.actual, created: false };
    }
    if (err instanceof DigestMismatchError) {
      throw new ConflictException({
        message: `A different file already exists at ${file.path}; reindex or remove it first`,
        reason: 'exists_on_disk',
        file_path: file.path,
      });
    }
    throw err;
  }
}

async function readIfExists(store: LocalBundleStore, path: string): Promise<{ raw: string; digest: string } | null> {
  try {
    const item = await store.read(path);
    return { raw: item.raw, digest: item.digest };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** A source the mirror can be pointed at, plus the policy that governs writes to it. */
interface SourceRef extends MovedOutSource {
  mode: SyncMode;
}

/** The file a relocating write leaves behind (plan 8.3): where it is, and what it holds. */
interface Departure {
  from: SourceRef;
  /** Repo-relative path in `from`'s working tree. */
  path: string;
  store: LocalBundleStore;
  /** Bytes at that path before the write — the compensation copy. */
  onDisk: { raw: string; digest: string } | null;
}

/** Put a file back to what it held before an attempt (removing it when it had none). */
async function restoreFile(
  store: LocalBundleStore,
  path: string,
  onDisk: { raw: string; digest: string } | null,
): Promise<void> {
  await (onDisk ? store.write(path, onDisk.raw) : store.remove(path)).catch(() => undefined);
}

/** One file a rename will rewrite, resolved and rendered but not yet written. */
interface PlannedRenameWrite {
  plan: RenamePageWrite;
  store: LocalBundleStore;
  file: RenderedConceptFile;
  /** What the file held before this rename (null when there was none) — the compensation copy. */
  onDisk: { raw: string; digest: string } | null;
  /** The registry row when this page's source stages for review; null for `direct`. */
  review: SourceRow | null;
  sourceId: string;
  /** Digest of the bytes written; empty until `writeRenameFiles` runs. */
  digest: string;
  written: boolean;
}

/** The canonical-file reference each rewritten page records (and enqueues an outbox row for). */
function renameFileRefs(planned: PlannedRenameWrite[]): Map<string, CanonicalFileRef> {
  const out = new Map<string, CanonicalFileRef>();
  for (const write of planned) {
    out.set(write.plan.page.id, { path: write.file.path, digest: write.digest, sourceId: write.sourceId });
  }
  return out;
}

/**
 * Put every file a failed rename rewrote back to what it held — the bytes the
 * index still describes, so no page is left with a digest mismatch (which the
 * next edit would report as a spurious `changed_on_disk`). A file that did not
 * exist before is removed again.
 */
async function restoreRenameFiles(planned: PlannedRenameWrite[]): Promise<void> {
  for (const write of planned) {
    if (!write.written) continue;
    await (write.onDisk
      ? write.store.write(write.file.path, write.onDisk.raw)
      : write.store.remove(write.file.path)
    ).catch(() => undefined);
    write.written = false;
  }
}

/**
 * Issue 80: a `review` source's base branch is written by nobody — every edit
 * goes onto the item branch. The operations that cannot do that yet are
 * refused here with one machine-readable reason, in the style of
 * `changed_on_disk` / `source_read_only`.
 */
function assertNotReviewMode(mode: SyncMode, sourceId: string, operation: string): void {
  if (mode !== 'review') return;
  throw new ConflictException({
    message: `${operation} is not yet supported in a review-mode source (${sourceId}); it would write to the base branch instead of the change request`,
    reason: 'review_unsupported_operation',
    operation,
    source_id: sourceId,
  });
}

/** Writes to a `read-only` source (plan §8.2) are refused: nobody publishes here. */
function assertWritable(target: { mode: SyncMode; sourceId: string }): void {
  if (target.mode !== 'read-only') return;
  throw new ForbiddenException({
    message: `Source ${target.sourceId} is read-only; edits belong upstream`,
    reason: 'source_read_only',
    source_id: target.sourceId,
  });
}

function changedOnDisk(path: string): ConflictException {
  return new ConflictException({
    message: `The file for this item changed on disk since it was last indexed (${path}); reindex it before editing`,
    reason: 'changed_on_disk',
    file_path: path,
  });
}

/**
 * The shared input carries `space`/`categories`/`groups` as top-level fields;
 * today's services read them from frontmatter (as the MCP create tool already
 * does), so fold them in. Untouched when none is given.
 */
function foldTaxonomy<T extends { frontmatter?: Record<string, unknown>; space?: string; categories?: string[]; groups?: string[] }>(
  input: T,
): T {
  const { space, categories, groups } = input;
  if (space === undefined && categories === undefined && groups === undefined) return input;
  return {
    ...input,
    frontmatter: {
      ...(input.frontmatter ?? {}),
      ...(space !== undefined ? { space } : {}),
      ...(categories !== undefined ? { categories } : {}),
      ...(groups !== undefined ? { groups } : {}),
    },
  };
}
