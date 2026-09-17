/**
 * Review policy (plan §8.2 `review`, §12): in a source whose mode is `review`
 * nobody writes to the base branch. Every save still takes the write-first path
 * — the OKF concept file is written and the index updated first — but instead of
 * handing the version to the debounced committer it is **staged**:
 *
 *  1. commit the item's file(s) onto a per-item branch `e3/<slug>-<shortId>`
 *     with `commitToBranch` (plumbing: the shared working tree never leaves the
 *     base branch, so other authors' in-progress files are untouched),
 *  2. push that branch,
 *  3. open a change request through the source's `ChangeRequestHost` — **once**;
 *     later saves add commits to the same branch,
 *  4. restore the working-tree copy to the base-branch version (or delete it
 *     when the file is new), so the `direct` committer and the sync merge can
 *     never sweep an in-review edit onto the base branch. The *index* keeps the
 *     edited content: the author sees their draft, the base branch does not.
 *
 * The item therefore stays a `draft` with `review_state = 'open'` until the
 * change request merges; `reconcile` asks the host on every sync cycle and,
 * on `merged`, brings the base branch up to date (`ReviewFlow.onMerged`) and
 * hands the merged files to the inbound indexer — which is what finally
 * publishes the item, because the staged file carries the publish intent.
 */
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import type { ChangeRef, ChangeRequestHost, Diagnostic, PathChange } from '@echozedlabs/knowledge-types';
import {
  LocalGitRepo,
  ReviewFlow,
  createHost,
  itemBranchName,
  type FetchImpl,
  type GitIdentity,
} from '@echozedlabs/repo-sync';
import { nowIso } from '../common/ids.js';
import { KYSELY } from '../db/db.module.js';
import type { Database, ReviewState } from '../db/schema.js';
import type { PageView } from '../pages/pages.service.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { prepareRepo } from './prepare-repo.js';
import { SourceRegistryService, type SourceRow } from './source-registry.service.js';

/** One item's change request, as Admin → Repos → Reviews lists it. */
export interface ReviewRecord {
  page_id: string;
  slug: string;
  title: string;
  state: ReviewState;
  url: string | null;
  branch: string | null;
  change_id: string | null;
  opened_at: string | null;
  closed_at: string | null;
  file_path: string | null;
  source_id: string;
  /**
   * The item is already soft-deleted here and this change request PROPOSES the
   * removal of its file (issue 76). The reader has nothing to open — the item
   * is gone from this index — so the surfaces render the title without a link.
   */
  deleted: boolean;
}

export interface StageOptions {
  /** Change-request title; defaults to the item title (or `Remove <title>`). */
  title?: string;
  /** One-line lint summary for the change-request body. */
  summary?: string;
  /**
   * What the staged paths mean. Stated by the caller rather than inferred from
   * whether the file is on disk: `commitToBranch` runs `update-index --add
   * --remove`, so an absent file becomes a deletion either way, and an absent
   * file could equally be a bug. It decides the commit message, the
   * change-request title and its body — a reviewer must be able to tell a
   * proposed removal from a proposed edit at a glance.
   */
  intent?: StageIntent;
}

/** An edit to the item's file, or its removal (issue 80 + issue 76). */
export type StageIntent = 'update' | 'remove';

/** Who is staging: the E3 user id (the git *author* of the item-branch commit). */
export interface StageActor {
  id: string;
}

/** Re-index callback: the merged files a `reconcile` brought onto the base branch. */
export type IndexChanges = (changes: PathChange[]) => Promise<void>;

type PageRow = Selectable<Database['pages']>;

const SYSTEM_IDENTITY: GitIdentity = { name: 'Knowledge E3', email: 'knowledge-e3@localhost' };

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);
  private readonly flow = new ReviewFlow();

  /**
   * HTTP transport for the change-request hosts. Injectable so tests can drive
   * a host without a network (same seam `GitHubHost`/`BitbucketDcHost` expose).
   */
  fetchImpl?: FetchImpl;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly registry: SourceRegistryService,
    private readonly paths: ContentPathResolver,
  ) {}

  // ------------------------------------------------------------------ staging

  /**
   * Stage the just-written file(s) of `page` on the item branch and make sure a
   * change request is open for it. The caller has already written the file and
   * updated the index — a failure here never unwrites either.
   */
  async stage(
    source: SourceRow,
    page: PageView,
    paths: string[],
    actor: StageActor,
    opts: StageOptions = {},
  ): Promise<void> {
    // Publication is the change request's job: the row goes back to `draft`
    // whatever the caller asked for. The *file* keeps the requested status, so
    // merging the change request is what finally publishes the item.
    await this.db.updateTable('pages').set({ status: 'draft' }).where('id', '=', page.id).execute();

    const host = this.hostFor(source);
    if (!host) {
      throw new ServiceUnavailableException({
        message: `Source ${source.id} is in review mode but has no usable change-request host; set host_kind and the token named by host_token_env`,
        reason: 'review_host_unconfigured',
        source_id: source.id,
      });
    }

    const repo = new LocalGitRepo(this.paths.dirOf(source));
    await prepareRepo(repo, source);
    const base = source.branch ?? (await repo.currentBranch()) ?? 'main';
    await this.ensureBase(repo, base);

    const current = await this.rowOf(page.id);
    const reopen = current?.review_state === 'open' && Boolean(current.review_change_id);
    const branch =
      (reopen ? current?.review_branch : null) ??
      itemBranchName(source.branch_prefix ?? undefined, page.slug, shortIdFor(page.id, current?.review_state ?? null));
    const author = await this.identityOf(actor.id);
    const at = nowIso();
    const removing = opts.intent === 'remove';

    if (reopen) {
      // The change request already exists: another commit on the same branch.
      const message = removing ? `Remove ${page.title}` : `Update ${page.title}`;
      await repo.commitToBranch(branch, paths, message, author, { from: `refs/heads/${base}` });
      const pushed = await repo.push(branch);
      if (!pushed.ok) throw new Error(`push of ${branch} failed: ${pushed.error ?? 'rejected'}`);
    } else {
      const ref = await this.flow.openForItem({
        repo,
        base,
        branch,
        paths,
        message: removing ? `Remove ${page.title}` : `Propose ${page.title}`,
        author,
        host,
        source: this.registry.toSourceRef(source, this.paths.root),
        title: opts.title ?? (removing ? `Remove ${page.title}` : page.title),
        body: this.changeBody(page, base, opts.summary, opts.intent ?? 'update'),
      });
      await this.db
        .updateTable('pages')
        .set({
          review_state: 'open',
          review_url: ref.url,
          review_branch: branch,
          review_change_id: ref.id,
          review_opened_at: at,
          review_closed_at: null,
        })
        .where('id', '=', page.id)
        .execute();
    }

    await this.markOutboxProcessed(page.id, paths, at);
    // The base branch must not carry the in-review edit: put the working-tree
    // copy back to what `base` holds (deleting a file that is new there).
    await repo.discardPaths(paths).catch((err) => {
      this.logger.warn(`[review:${source.id}] could not restore ${paths.join(', ')}: ${errMessage(err)}`);
    });
  }

  // --------------------------------------------------------------- reconciling

  /**
   * Ask the host about every open change request of this source. `merged` runs
   * `ReviewFlow.onMerged` (fast-forward the base branch, drop the item branch)
   * and hands the merged files to `index` — the inbound indexer, which is what
   * flips the item to `published` when the staged file said so. `closed` leaves
   * the item a draft; the next save opens a new change request on a new branch
   * — unless the item is soft-deleted, in which case the change request was a
   * proposed removal the reviewer declined and the item is restored from the
   * base-branch file (`restoreDeclinedRemoval`, issue 96).
   */
  async reconcile(
    source: SourceRow,
    repo: LocalGitRepo,
    index: IndexChanges,
    opts: { pageId?: string } = {},
  ): Promise<ReviewRecord[]> {
    const rows = await this.openRows(source.id, opts.pageId);
    if (!rows.length) return [];
    const host = this.hostFor(source);
    if (!host) return rows.map((r) => toRecord(r, source.id));

    const base = source.branch ?? (await repo.currentBranch()) ?? 'main';
    const before = await repo.headSha();
    const merged: PageRow[] = [];
    const out: ReviewRecord[] = [];

    for (const row of rows) {
      let state: 'open' | 'merged' | 'closed';
      try {
        state = await host.status(refOf(source, row)!);
      } catch (err) {
        this.logger.warn(`[review:${source.id}] status of ${row.review_change_id} failed: ${errMessage(err)}`);
        out.push(toRecord(row, source.id));
        continue;
      }
      if (state === 'open') {
        out.push(toRecord(row, source.id));
        continue;
      }
      if (state === 'closed') {
        const at = nowIso();
        await this.settle(row.id, 'closed', at);
        // A declined REMOVAL is the one closed change request that leaves this
        // instance disagreeing with its own git history (issue 96): the row is
        // already deleted here, the file is still on the base branch, and
        // nothing else ever revisits it — inbound sync only walks the paths a
        // commit changed, so an untouched file is never seen again. A declined
        // EDIT needs none of this and is deliberately untouched: the item is
        // still here as a draft and the next save opens a fresh change request.
        const restored = row.deleted_at ? await this.restoreDeclinedRemoval(source, row, index) : false;
        out.push({ ...toRecord(row, source.id), state: 'closed', closed_at: at, deleted: Boolean(row.deleted_at) && !restored });
        continue;
      }
      try {
        await this.flow.onMerged({
          repo,
          branch: row.review_branch ?? '',
          base,
          // `onMerged` snapshots these paths and puts back any the merge did not
          // bring along, so an edit the host wrote locally is never lost. For a
          // merged REMOVAL that is exactly wrong: the merge deletes the file and
          // the snapshot would write it straight back as an untracked leftover
          // the next rebuild would re-index. A deleted row has no file to
          // preserve, so it passes none.
          paths: row.deleted_at || !row.file_path ? [] : [row.file_path],
        });
        merged.push(row);
      } catch (err) {
        this.logger.warn(`[review:${source.id}] merge follow-up for ${row.slug} failed: ${errMessage(err)}`);
        out.push(toRecord(row, source.id));
      }
    }

    if (merged.length) {
      // Index BEFORE the rows settle: a lint failure on a merged file is still
      // reported on the change request it came from (`commentOnLintFailure`).
      const after = await repo.headSha();
      if (before && after && before !== after) {
        const changes = await repo.changedPaths(before, after);
        if (changes.length) await index(changes);
      }
      const at = nowIso();
      for (const row of merged) {
        await this.settle(row.id, 'merged', at);
        out.push({ ...toRecord(row, source.id), state: 'merged', closed_at: at });
      }
    }
    return out;
  }

  /** Merge one item's change request through the host, then reconcile it. */
  async merge(source: SourceRow, repo: LocalGitRepo, pageId: string, index: IndexChanges): Promise<ReviewRecord> {
    const row = (await this.openRows(source.id, pageId))[0];
    if (!row) throw new NotFoundException(`No open review for item ${pageId} in source ${source.id}`);
    const host = this.hostFor(source);
    if (!host) {
      throw new ServiceUnavailableException({
        message: `Source ${source.id} has no usable change-request host`,
        reason: 'review_host_unconfigured',
        source_id: source.id,
      });
    }
    if (!host.merge) throw new BadRequestException(`${source.host_kind} cannot be merged from Knowledge E3`);
    await host.merge(refOf(source, row)!);
    const records = await this.reconcile(source, repo, index, { pageId });
    return records[0] ?? toRecord(row, source.id);
  }

  /** Every item of this source that has a change request, open ones first. */
  /**
   * Every change request of this source, open and settled — soft-deleted items
   * INCLUDED, for the same reason `openRows` includes them: a staged removal
   * deletes the row immediately, so filtering `deleted_at` would hide exactly
   * the change requests that most need a reviewer's attention, and leave an
   * admin no way to merge or refresh one from this surface. `deleted` on the
   * record is how a caller tells the two apart.
   */
  async list(sourceId: string): Promise<ReviewRecord[]> {
    const rows = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('source_id', '=', sourceId)
      .where('review_state', 'is not', null)
      .execute();
    return rows
      .map((r) => toRecord(r, sourceId))
      .sort((a, b) => rank(a.state) - rank(b.state) || (b.opened_at ?? '').localeCompare(a.opened_at ?? ''));
  }

  // ------------------------------------------------------------------ comments

  /**
   * An inbound file failed the lint and it arrived through a change request
   * this instance opened: say so on the change request, once per review.
   * Best-effort — indexing never fails because a host call did.
   */
  async commentOnLintFailure(input: {
    source: SourceRow;
    path: string;
    pageId: string;
    diagnosticsId: string;
    diagnostics: Diagnostic[];
  }): Promise<void> {
    try {
      const row = await this.rowOf(input.pageId);
      if (!row || row.review_state !== 'open' || !row.review_change_id) return;
      if (await this.alreadyCommented(input.source.id, input.path, row.review_opened_at ?? '')) return;
      const host = this.hostFor(input.source);
      if (!host?.comment) return;
      await host.comment(refOf(input.source, row)!, lintComment(input.path, input.diagnostics));
      await this.db
        .updateTable('sync_diagnostics')
        .set({ commented_at: nowIso() })
        .where('id', '=', input.diagnosticsId)
        .execute();
    } catch (err) {
      this.logger.warn(`[review:${input.source.id}] could not comment on ${input.path}: ${errMessage(err)}`);
    }
  }

  // ----------------------------------------------------------------- internals

  /** The host adapter for this source, or null when it is not configured (no kind, or no token in the env). */
  private hostFor(source: SourceRow): ChangeRequestHost | null {
    if (!source.host_kind) return null;
    const token = source.host_token_env ? process.env[source.host_token_env] : undefined;
    if (!token) return null;
    return createHost(source.host_kind, {
      token,
      baseUrl: source.host_base_url ?? '',
      ...(source.host_base_url ? { apiBase: source.host_base_url } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(source.branch ? { defaultBranch: source.branch } : {}),
    });
  }

  /**
   * The item branch is cut from `base`, so `base` must exist. A working tree the
   * sync engine has not visited yet is brought up to the remote; a repository
   * with no history at all gets an empty root commit so the first item branch
   * has a parent.
   */
  private async ensureBase(repo: LocalGitRepo, base: string): Promise<void> {
    if (await repo.headSha()) return;
    await repo.fetch().catch(() => undefined);
    const upstream = `${repo.remoteName}/${base}`;
    try {
      await repo.git(['rev-parse', '--verify', '-q', `refs/remotes/${upstream}`]);
      await repo.git(['reset', '--hard', upstream]);
    } catch {
      // No upstream history yet.
    }
    if (await repo.headSha()) return;
    await repo.git([
      '-c',
      `user.name=${SYSTEM_IDENTITY.name}`,
      '-c',
      `user.email=${SYSTEM_IDENTITY.email}`,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      `Initialise ${base}`,
    ]);
  }

  private async rowOf(pageId: string): Promise<PageRow | null> {
    const row = await this.db.selectFrom('pages').selectAll().where('id', '=', pageId).executeTakeFirst();
    return row ?? null;
  }

  /**
   * Every item of this source with an open change request — soft-deleted ones
   * INCLUDED. A staged removal (issue 76) deletes the row here immediately and
   * proposes the deletion upstream, so filtering `deleted_at` out would strand
   * that change request: nobody would ever ask the host about it, the base
   * branch would never be fast-forwarded past the merge, and `review_state`
   * would read `open` forever.
   */
  private async openRows(sourceId: string, pageId?: string): Promise<PageRow[]> {
    let q = this.db
      .selectFrom('pages')
      .selectAll()
      .where('source_id', '=', sourceId)
      .where('review_state', '=', 'open')
      .where('review_change_id', 'is not', null);
    if (pageId) q = q.where('id', '=', pageId);
    return q.execute();
  }

  /**
   * The reviewer declined a proposed removal (issue 96), so the item comes
   * back. Returns whether it actually did.
   *
   * The restore goes through the INBOUND indexer — the same `index` callback a
   * merge uses — and not through `ContentCommandsService.restore`, because the
   * two answer different questions. `restore` re-renders the concept file from
   * the deleted row and writes it; that is right for a `direct` source, where
   * the file is gone and the row is the only copy left. Here the file never
   * left the base branch and may have been edited upstream while the change
   * request sat open, so the row is the STALE copy: re-rendering it would
   * commit somebody else's work away. `indexFromFile` (which the callback
   * reaches through `InboundIndexService.applyChanges`) means "this file IS the
   * canonical file" — it writes nothing, takes the file's current bytes as the
   * truth, and restores the soft-deleted row by its `e3_id`, which is exactly
   * the operation a declined removal calls for.
   *
   * Best-effort throughout: `reconcile` runs inside `SyncService.runNow`, and a
   * failure here must leave the cycle — and the rest of this source's change
   * requests — running. What it must NOT do is fail silently, so a row still
   * deleted with `review_state = 'closed'` is what Content health's
   * `declined_removal_still_deleted` queue reports.
   */
  private async restoreDeclinedRemoval(source: SourceRow, row: PageRow, index: IndexChanges): Promise<boolean> {
    if (!row.file_path) return false;
    try {
      // The working-tree copy IS the base-branch copy: staging restored it
      // (`discardPaths`) precisely so the in-review edit could never reach base.
      // An upstream edit that has not been fetched yet is not lost — the engine
      // cycle that follows this reconcile merges it and re-indexes the path.
      await index([{ path: row.file_path, change: 'modified' }]);
    } catch (err) {
      this.logger.warn(`[review:${source.id}] restore of declined removal ${row.slug} failed: ${errMessage(err)}`);
      return false;
    }
    const after = await this.rowOf(row.id);
    if (after && !after.deleted_at) return true;
    // The file is gone from the base branch too, or the source no longer
    // resolves to a working tree: there is nothing to restore the item from.
    this.logger.warn(
      `[review:${source.id}] declined removal of ${row.slug} could not be restored from ${row.file_path}; the item stays deleted`,
    );
    return false;
  }

  private async settle(pageId: string, state: 'merged' | 'closed', at: string): Promise<void> {
    await this.db
      .updateTable('pages')
      .set({ review_state: state, review_closed_at: at })
      .where('id', '=', pageId)
      .execute();
  }

  /**
   * The branch push carried these files: the outbox rows the index wrote for
   * them are done.
   *
   * Scoped to `paths`, not just the page: since a topic move enqueues a `move`
   * row against the **departure** path in the source repo, settling by page id
   * alone would let a later staging in the arrival source prematurely mark that
   * still-pending row processed, and the source tree would keep the file
   * forever. Only the paths this push actually carried are settled.
   */
  private async markOutboxProcessed(pageId: string, paths: string[], at: string): Promise<void> {
    if (paths.length === 0) return;
    await this.db
      .updateTable('content_outbox')
      .set({ processed_at: at })
      .where('page_id', '=', pageId)
      .where('file_path', 'in', paths)
      .where('processed_at', 'is', null)
      .where('created_at', '<=', at)
      .execute();
  }

  /** Git author for the item-branch commit: the acting user (the committer stays the instance). */
  private async identityOf(actorId: string): Promise<GitIdentity> {
    const user = await this.db
      .selectFrom('users')
      .select(['username', 'email'])
      .where('id', '=', actorId)
      .executeTakeFirst();
    if (!user) return SYSTEM_IDENTITY;
    return { name: user.username, email: user.email };
  }

  private async alreadyCommented(sourceId: string, path: string, since: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('sync_diagnostics')
      .select('id')
      .where('source_id', '=', sourceId)
      .where('path', '=', path)
      .where('commented_at', 'is not', null)
      .where('commented_at', '>=', since)
      .executeTakeFirst();
    return Boolean(row);
  }

  private changeBody(page: PageView, base: string, summary?: string, intent: StageIntent = 'update'): string {
    const link = `${publicBaseUrl()}/p/${page.slug}`;
    if (intent === 'remove') {
      return [
        `“${page.title}” was deleted in Knowledge E3 and its removal is proposed here for review. Merging this change request deletes the item's OKF concept file from \`${base}\`; until then the file on the base branch is untouched. The item is already gone from this instance's index — the change request is what carries the intent upstream.`,
        `Deleted in Knowledge E3: ${link}`,
      ].join('\n\n');
    }
    return [
      `“${page.title}” was edited in Knowledge E3 and is proposed here for review. Merging this change request lands the item's OKF concept file on \`${base}\`; until then the item stays a draft in Knowledge E3 and the base branch is untouched.`,
      summary ?? 'Lint: not run.',
      `View in Knowledge E3: ${link}`,
    ].join('\n\n');
  }
}

/** `ChangeRef` rebuilt from the row plus the source's host kind. */
function refOf(source: SourceRow, row: PageRow): ChangeRef | null {
  if (!row.review_change_id || !source.host_kind) return null;
  return { host: source.host_kind, id: row.review_change_id, url: row.review_url ?? '' };
}

function toRecord(row: PageRow, sourceId: string): ReviewRecord {
  return {
    page_id: row.id,
    slug: row.slug,
    title: row.title,
    state: (row.review_state ?? 'open') as ReviewState,
    url: row.review_url ?? null,
    branch: row.review_branch ?? null,
    change_id: row.review_change_id ?? null,
    opened_at: row.review_opened_at ?? null,
    closed_at: row.review_closed_at ?? null,
    file_path: row.file_path,
    source_id: sourceId,
    deleted: Boolean(row.deleted_at),
  };
}

function rank(state: ReviewState): number {
  return state === 'open' ? 0 : state === 'merged' ? 1 : 2;
}

/**
 * The branch suffix. The first review of an item uses a stable short id derived
 * from its id; a review that was closed or merged is over, so the next save
 * gets a fresh suffix and therefore a brand-new branch and change request.
 */
function shortIdFor(pageId: string, state: ReviewState | null): string {
  if (state) return randomBytes(3).toString('hex');
  const compact = pageId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return compact.slice(0, 6) || randomBytes(3).toString('hex');
}

function lintComment(path: string, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const shown = errors.slice(0, 10).map((d) => `- ${d.code}: ${d.message}`);
  const more = errors.length > shown.length ? [`- …and ${errors.length - shown.length} more.`] : [];
  return [
    `Knowledge E3 indexed \`${path}\` from this change request and its content lint reported ${errors.length} error(s). The item landed, but it is held back as a draft until a clean version arrives.`,
    [...shown, ...more].join('\n'),
  ].join('\n\n');
}

/** Absolute base for links in change-request bodies; empty (relative link) when unset. */
function publicBaseUrl(): string {
  return (process.env['KNOWLEDGE_E3_PUBLIC_URL'] ?? '').replace(/\/+$/, '');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
