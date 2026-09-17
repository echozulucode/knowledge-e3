/**
 * Pages service - the heart of v0.1.
 *
 * Owns:
 *  - Create / read / update / soft-delete / restore / list of pages.
 *  - Page versioning: every write produces a `page_versions` row.
 *  - Optimistic concurrency via `version_token` (the application-managed
 *    rowversion equivalent — see schema.ts).
 *  - The AST-aware rename flow from spec section 6.4 — atomic across all
 *    affected pages, with rowversion checks on every page touched.
 *  - Wiki-link indexing inside the same transaction as the page write.
 *  - Audit logging for every write.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Kysely, sql, type Selectable, type Transaction } from 'kysely';
import {
  parse,
  serializeWithBody,
  rewriteWikiLinks,
  extractItemLinks,
  type ParsedPage,
} from '@echozedlabs/codec';
import type { ContentOutboxTable, Database } from '../db/schema.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { KYSELY } from '../db/db.module.js';
import { newId, nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import { AuditService } from '../audit/audit.service.js';
import { WikiService } from '../wiki/wiki.service.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from './taxonomy.js';
import { lifecycleColumnsFrom, reviewRefFrom, sourceRefFrom, type ItemSourceRef, type ReviewRef } from './lifecycle-columns.js';
import { syncImageLinksInTx } from './image-links.js';
import { reindexPageFts } from '../search/fts-index.js';
import { canonicalTypeLabel } from '../content-types/content-types.registry.js';
import { DEFAULT_SPACE_ID } from '../taxonomy/spaces.service.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { enqueueOutboxInTx } from '../content/outbox.service.js';
import { exportSpaceName } from '../storage/render-concept.js';

/**
 * Visibility actor for read endpoints. When provided, `PagesService` enforces
 * the v0.1 draft-visibility rule: non-admin callers see published pages plus
 * their own drafts. Omit `actor` only for trusted internal callers
 * (post-create hydration, internal hooks); never accept undefined at a
 * request entrypoint.
 */
export type ReadActor = Pick<AuthedUser, 'id' | 'role'>;

/** Filters for `PagesService.list` / `count` (the `GET /pages` query). */
export interface PageListOptions {
  q?: string;
  status?: 'draft' | 'published';
  tag?: string;
  /** Any-of tag filter; unions with `tag` and ANDs with `type`/`space`. */
  tags?: string[];
  since?: string;
  limit?: number;
  /** Restrict to a single space (topic), by space id or slug. */
  space?: string;
  /** Restrict to a single concept kind (OKF `type`) — the "section" filter. */
  type?: string;
  /**
   * Ordering. Default `updated` (recently-edited first). `published` powers a
   * chronological blog feed: published items by publish date, newest first,
   * with unpublished drafts after (their published_at is null).
   */
  sort?: 'updated' | 'published' | 'created' | 'title';
}

export interface PageView {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  type: string | null;
  owner_id: string | null;
  space_id: string | null;
  created_at: string;
  updated_at: string;
  /** First-published timestamp; null while a draft. See PagesTable.published_at. */
  published_at: string | null;
  version_token: number;
  current_version_id: string | null;
  body_markdown: string;
  raw_markdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  categories: string[];
  groups: string[];
  /**
   * The change request this item's edits are staged on in a `review` source
   * (plan §8.2), or null. While `state` is `open` the item stays a draft here
   * and its edits live only on `branch`.
   */
  review: ReviewRef | null;
  /**
   * Where this page's canonical file lives (plan §8.3). Null for a row written
   * before the source registry existed. Read-path only: the write path resolves
   * its target through `ContentPathResolver`, never through this.
   */
  source: ItemSourceRef | null;
}

/**
 * The canonical file the write-first path (plan §7.3) already wrote for this
 * version: recorded on the row and as an outbox row in the same transaction.
 */
export interface CanonicalFileRef {
  /** Repo-relative posix path. */
  path: string;
  digest: string;
  /** Source registry id (`main` / `topic:<slug>`). */
  sourceId: string;
  /** `false` for a file that arrived through sync: it is indexed, but there is nothing to push (no outbox row). */
  enqueue?: boolean;
}

export interface CreatePageInput {
  /** Internal stable identity used by trusted restore/import paths. */
  id?: string;
  /** Pre-allocated slug (see `allocateIdentity`); default: allocated from the title. */
  slug?: string;
  /** Timestamp to persist; default: now. The write-first path renders the file with it first. */
  now?: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  status?: 'draft' | 'published';
  tags?: string[];
  /** Optional: the full raw markdown the editor sent. Takes precedence over body+frontmatter. */
  raw?: string;
  file?: CanonicalFileRef;
}

export interface UpdatePageInput {
  body?: string;
  frontmatter?: Record<string, unknown>;
  title?: string;
  status?: 'draft' | 'published';
  tags?: string[];
  /** Optional: the full raw markdown the editor sent. Takes precedence over body+frontmatter. */
  raw?: string;
  /** Timestamp to persist; default: now. The write-first path renders the file with it first. */
  now?: string;
  file?: CanonicalFileRef;
}

/** What a create will persist, computed before any write (pure: same input + `now` → same result). */
export interface PreparedCreate {
  title: string;
  status: 'draft' | 'published';
  raw: string;
  parsed: ParsedPage;
  publishedAt: string | null;
  /** Taxonomy exactly as the row will read back (groups as slugs, all sorted). */
  taxonomy: PersistedTaxonomy;
}

export interface PersistedTaxonomy {
  tags: string[];
  categories: string[];
  groups: string[];
}

/** What an update will persist, computed against the current row before any write. */
export interface PreparedUpdate extends PreparedCreate {
  current: Pick<Database['pages'], 'id' | 'slug' | 'owner_id' | 'created_at' | 'version_token' | 'file_digest' | 'file_path' | 'source_id'>;
  spaceId: string;
  spaceName: string | null;
}

export interface RenameOutcome {
  page: PageView;
  affected_pages: { id: string; slug: string; title: string }[];
}

/**
 * One page a rename rewrites — the subject, or an inbound page whose wiki-links
 * point at the old title. Carries the row as it stood when the plan was made
 * plus the document it becomes, so the write-first caller can render and write
 * the canonical file before the index transaction runs.
 */
export interface RenamePageWrite {
  /** The page as it stands today (what `renderConceptFile` needs). */
  page: PageView;
  /** Title after the rename: the new title for the subject, unchanged for a linker. */
  nextTitle: string;
  /** The raw document this page becomes. */
  nextRaw: string;
  /** Topic name for the file's `e3_space` (null for the default topic). */
  spaceName: string | null;
  /** Canonical file the row currently records, for the on-disk digest guard. */
  filePath: string | null;
  fileDigest: string | null;
  sourceId: string | null;
  /** `version_token` the plan was computed against; re-checked in the transaction. */
  versionToken: number;
  subject: boolean;
}

/** A rename computed but not yet persisted (see `prepareRename`). */
export interface PreparedRename {
  /** Timestamp the rendered files and the rows must share. */
  now: string;
  newTitle: string;
  linkAction: 'update_all' | 'skip';
  subjectId: string;
  expectedVersion: number;
  /** Subject first, then every affected page. Empty when `noop`. */
  writes: RenamePageWrite[];
  /** The title is unchanged: nothing to write, nothing to commit. */
  noop: boolean;
}

@Injectable()
export class PagesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly wiki: WikiService,
  ) {}

  /**
   * Everything a create will persist, before anything is written — the
   * write-first path renders the canonical file from this, then calls `create`
   * with the same `now` so the row matches the file byte for byte.
   */
  prepareCreate(input: CreatePageInput, now: string): PreparedCreate {
    const title = input.title.trim();
    if (!title) throw new BadRequestException('title is required');
    if (title.length > 500) throw new BadRequestException('title too long');

    const status = input.status ?? 'draft';
    if (status !== 'draft' && status !== 'published') {
      throw new BadRequestException('invalid status');
    }

    const frontmatter: Record<string, unknown> = {
      ...(input.frontmatter ?? {}),
      title,
      status,
      ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    };
    // Stamp the publish date into frontmatter (git-of-record) before serializing,
    // so it travels with the file and survives a rebuild.
    const stampedPublishedAt = resolvePublishedAt(frontmatter, status, null, now);
    if (stampedPublishedAt) frontmatter['published_at'] = stampedPublishedAt;
    const raw = input.raw ?? serializeFromParts(frontmatter, input.body);
    const parsed = parse(raw);
    const publishedAt = resolvePublishedAt(parsed.frontmatter, status, null, now);
    const taxonomy = persistedTaxonomy(taxonomyFromFrontmatter(parsed.frontmatter, input.tags));
    return { title, status, raw, parsed, publishedAt, taxonomy };
  }

  /**
   * Reserve the identity of a page about to be created: its id, a free slug
   * (same `-2`, `-3` collision rule as `create`), and the space it lands in —
   * created from `spaceRef` (a `space`/`topic` frontmatter value) if new, so
   * the canonical file's location is known before the row exists.
   */
  async allocateIdentity(
    title: string,
    spaceRef: string | undefined,
    explicitId?: string,
  ): Promise<{ id: string; slug: string; spaceId: string; spaceName: string | null }> {
    const trimmed = title.trim();
    if (!trimmed) throw new BadRequestException('title is required');
    const slug = await this.findFreeSlug(trimmed);
    const spaceId = await ensureSpaceForFrontmatterInTx(this.db, { space: spaceRef });
    return { id: explicitId ?? newId(), slug, spaceId, spaceName: await exportSpaceName(this.db, spaceId) };
  }

  async create(actorId: string, input: CreatePageInput): Promise<PageView> {
    const now = input.now ?? nowIso();
    const { title, status, raw, parsed, publishedAt } = this.prepareCreate(input, now);

    const slug = input.slug ?? (await this.findFreeSlug(title));
    const id = input.id ?? newId();
    const versionId = newId();

    await this.db.transaction().execute(async (tx) => {
      const spaceId = await ensureSpaceForFrontmatterInTx(tx, parsed.frontmatter);
      await assertTitleAvailableInSpace(tx, title, spaceId);
      if (input.slug) await assertSlugFree(tx, slug);
      await tx
        .insertInto('pages')
        .values({
          id,
          slug,
          title,
          status,
          type: typeFromFrontmatter(parsed.frontmatter),
          owner_id: actorId,
          space_id: spaceId,
          created_at: now,
          updated_at: now,
          published_at: publishedAt,
          deleted_at: null,
          version_token: 1,
          current_version_id: versionId,
          ...lifecycleColumnsFrom(parsed.frontmatter, status),
          ...fileColumns(input.file),
        })
        .execute();

      await tx
        .insertInto('page_versions')
        .values({
          id: versionId,
          page_id: id,
          body_markdown: parsed.body,
          raw_markdown: raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: now,
          created_by: actorId,
          parent_version_id: null,
        })
        .execute();

      const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, input.tags);
      await syncTaxonomyInTx(tx, id, taxonomy);

      await this.wiki.indexInTx(tx, id, extractItemLinks(parsed));
      await syncImageLinksInTx(tx, id, parsed.body, parsed.frontmatter);
      await reindexPageFts(tx, id);
      if (input.file && input.file.enqueue !== false) await enqueueOutbox(tx, id, input.file, actorId);
    });

    await this.audit.record({
      actor_id: actorId,
      action: 'page.create',
      page_id: id,
      version_id: versionId,
      payload: { title, slug, status },
    });

    return (await this.getById(id))!;
  }

  async getById(
    id: string,
    options: { includeDeleted?: boolean; actor?: ReadActor } = {},
  ): Promise<PageView | null> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!page) return null;
    if (page.deleted_at && !options.includeDeleted) return null;
    if (!isVisibleTo(page, options.actor)) return null;
    if (!(await this.isSpaceVisibleTo(page.space_id, options.actor))) return null;
    return this.hydrate(page);
  }

  async getBySlug(slug: string, actor?: ReadActor): Promise<PageView | null> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!page) return null;
    if (!isVisibleTo(page, actor)) return null;
    if (!(await this.isSpaceVisibleTo(page.space_id, actor))) return null;
    return this.hydrate(page);
  }

  /**
   * Space gate: a `private` space is invisible to ANONYMOUS visitors. Kept
   * orthogonal to isVisibleTo (which rules on status/ownership) — both must
   * pass, and neither subsumes the other. Signed-in users are deliberately
   * unaffected: this control narrows public exposure, it is not a per-user ACL.
   */
  private async isSpaceVisibleTo(spaceId: string | null, actor?: ReadActor): Promise<boolean> {
    if (!actor) return true; // trusted internal caller (hydration, post-write reads)
    if (actor.role === 'admin') return true;
    if (!isAnonymousActor(actor)) return true;
    if (!spaceId) return true; // page belongs to no space; nothing to gate on
    const row = await this.db
      .selectFrom('spaces')
      .select('visibility')
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return row?.visibility !== 'private';
  }

  /**
   * The canonical file a row records, straight from its columns — including a
   * soft-deleted row, which `getById` hides. The write-first delete/restore path
   * needs the file the ROW names (never the one the item's topic resolves to
   * today) and cannot go through `PageView.source`, which is null whenever the
   * source has no `content_sources` entry (an unregistered `main`). Null when
   * there is no such row at all.
   */
  async canonicalFileOf(id: string): Promise<{ path: string | null; digest: string | null; sourceId: string | null } | null> {
    const row = await this.db
      .selectFrom('pages')
      .select(['file_path', 'file_digest', 'source_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return { path: row.file_path, digest: row.file_digest, sourceId: row.source_id };
  }

  /** Topic name for a file's `e3_space` (null for the default topic). */
  spaceNameOf(spaceId: string | null): Promise<string | null> {
    return exportSpaceName(this.db, spaceId);
  }

  /** Lightweight slug list for render-time wiki-link resolution (red-links). */
  async listSlugs(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pages')
      .select('slug')
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((r) => r.slug);
  }

  async getByTitle(title: string, actor?: ReadActor): Promise<PageView | null> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('title', '=', title)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!page) return null;
    if (!isVisibleTo(page, actor)) return null;
    if (!(await this.isSpaceVisibleTo(page.space_id, actor))) return null;
    return this.hydrate(page);
  }

  /**
   * Exact-title lookup constrained to one unambiguous topic. Imports use this
   * instead of the legacy global title lookup so a concept cannot update a
   * same-title page in a different topic.
   *
   * Topic references follow the write path's slug-or-name semantics. An
   * explicit reference must resolve to exactly one active topic; otherwise the
   * caller must fix the destination before any import mutation occurs. With no
   * explicit reference, the seeded default topic is the deterministic target.
   */
  async getByTitleInSpace(
    title: string,
    spaceRef?: string,
    actor?: ReadActor,
  ): Promise<{ page: PageView | null; spaceId: string }> {
    const ref = spaceRef?.trim();
    let spaceId = DEFAULT_SPACE_ID;

    if (ref) {
      const slug = slugify(ref);
      const matches = await this.db
        .selectFrom('spaces')
        .select('id')
        .where((eb) => eb.or([eb('slug', '=', slug), eb('name', '=', ref)]))
        .where('archived_at', 'is', null)
        .limit(2)
        .execute();
      if (matches.length === 0) {
        throw new BadRequestException(`destination topic "${ref}" not found`);
      }
      if (matches.length > 1) {
        throw new ConflictException(`destination topic "${ref}" is ambiguous`);
      }
      spaceId = matches[0]!.id;
    }

    const pages = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('title', '=', title)
      .where('space_id', '=', spaceId)
      .where('deleted_at', 'is', null)
      .limit(2)
      .execute();
    if (pages.length > 1) {
      throw new ConflictException(`multiple items titled "${title}" exist in the destination topic`);
    }
    const page = pages[0];
    if (!page) return { page: null, spaceId };
    if (!isVisibleTo(page, actor)) return { page: null, spaceId };
    if (!(await this.isSpaceVisibleTo(page.space_id, actor))) return { page: null, spaceId };
    return { page: await this.hydrate(page), spaceId };
  }

  async list(opts: PageListOptions = {}, actor?: ReadActor): Promise<PageView[]> {
    let q = (await this.filteredPages(opts, actor)).query.selectAll();
    switch (opts.sort) {
      case 'published':
        // Newest publish date first; NULLs (drafts) sort last in SQLite DESC.
        q = q.orderBy('published_at', 'desc').orderBy('updated_at', 'desc');
        break;
      case 'created':
        q = q.orderBy('created_at', 'desc');
        break;
      case 'title':
        q = q.orderBy('title', 'asc');
        break;
      default:
        q = q.orderBy('updated_at', 'desc');
    }
    q = q.limit(opts.limit ?? 50);
    const rows = await q.execute();
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  /**
   * How many pages match `opts` for this actor, ignoring `limit` and `sort`.
   *
   * `GET /pages` used to answer `total: items.length` — the length of the page
   * it returned, so "total" could never exceed the limit asked for. The
   * Sections admin shows "Matches N items · shows min(N, limit)" and flags a
   * section that matches nothing, which needs the real count; it shares
   * `filteredPages` with `list` so the two cannot disagree about membership.
   */
  async count(opts: PageListOptions = {}, actor?: ReadActor): Promise<number> {
    const row = await (await this.filteredPages(opts, actor)).query
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /**
   * The `pages` query with every membership filter applied — no selection, order
   * or limit. Wrapped in an object because Kysely refuses to let a builder be
   * awaited, which is what returning one from an async function does.
   */
  private async filteredPages(opts: PageListOptions, actor?: ReadActor) {
    let q = this.db
      .selectFrom('pages')
      .where('deleted_at', 'is', null);

    if (opts.type && opts.type.trim()) {
      // Canonicalize the filter the same way the stored column is, so a section
      // defined as `faq` matches items indexed as `FAQ` (and unknown types still
      // match verbatim).
      q = q.where('type', '=', canonicalTypeLabel(opts.type));
    }

    // Space-scoped listing: resolve id-or-slug to a space id and filter.
    if (opts.space && opts.space.trim()) {
      const ref = opts.space.trim();
      const space = await this.db
        .selectFrom('spaces')
        .select('id')
        .where((eb) => eb.or([eb('id', '=', ref), eb('slug', '=', ref)]))
        .executeTakeFirst();
      // Unknown space → match nothing rather than silently returning everything.
      q = q.where('space_id', '=', space?.id ?? '__no_such_space__');
    }

    // Wiki-link autocomplete query: simple substring match on title/slug
    if (opts.q && opts.q.trim()) {
      const searchStr = `%${opts.q.trim()}%`;
      q = q.where((eb) =>
        eb.or([
          eb('pages.title', 'like', searchStr),
          eb('pages.slug', 'like', searchStr),
        ])
      );
    }

    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.since) q = q.where('updated_at', '>=', opts.since);
    // One `exists` over the union of `tag` and `tags`: an item matching ANY of
    // them passes, which is what a curator means by "this section is the news".
    const wantedTags = Array.from(new Set([...(opts.tag ? [opts.tag] : []), ...(opts.tags ?? [])].filter((t) => t.trim())));
    if (wantedTags.length) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('page_tags')
            .select('page_id')
            .whereRef('page_tags.page_id', '=', 'pages.id')
            .where('page_tags.tag', 'in', wantedTags),
        ),
      );
    }

    // Draft visibility: non-admin callers see published pages plus their own
    // drafts. Trusted internal callers (no actor) see everything.
    if (actor && actor.role !== 'admin') {
      q = q.where((eb) =>
        eb.or([
          eb('pages.status', '=', 'published'),
          eb('pages.owner_id', '=', actor.id),
        ]),
      );
    }

    // Space gate (anonymous only): private spaces drop out entirely. Pages with
    // no space are unaffected. Mirrors isSpaceVisibleTo for the list path.
    if (isAnonymousActor(actor)) {
      q = q.where((eb) =>
        eb.or([
          eb('pages.space_id', 'is', null),
          eb.exists(
            eb
              .selectFrom('spaces')
              .select('spaces.id')
              .whereRef('spaces.id', '=', 'pages.space_id')
              .where('spaces.visibility', '!=', 'private'),
          ),
        ]),
      );
    }

    return { query: q };
  }

  /**
   * Everything an update will persist, computed against the current row — the
   * concurrency checks (404/403/409) run here too, so the write-first path
   * fails before it touches the file. Pure given the same current version and
   * `now`, which is what lets `update` recompute it inside its transaction.
   */
  async prepareUpdate(
    actor: ReadActor,
    id: string,
    expectedVersion: number,
    input: UpdatePageInput,
    now: string,
  ): Promise<PreparedUpdate> {
    const c = await computeUpdate(this.db, actor, id, expectedVersion, input, now);
    return {
      title: c.nextTitle,
      status: c.status,
      raw: c.raw,
      parsed: c.parsed,
      publishedAt: c.publishedAt,
      taxonomy: persistedTaxonomy(c.taxonomy),
      current: c.current,
      spaceId: c.spaceId,
      spaceName: await exportSpaceName(this.db, c.spaceId),
    };
  }

  /**
   * Update a page with optimistic concurrency.
   * `expectedVersion` is the version_token the client read; mismatch -> 409.
   */
  async update(
    actor: ReadActor,
    id: string,
    expectedVersion: number,
    input: UpdatePageInput,
  ): Promise<PageView> {
    const actorId = actor.id;
    const newVersionId = newId();
    const now = input.now ?? nowIso();

    await this.db.transaction().execute(async (tx) => {
      const { current, currentVersion, nextTitle, status, raw, parsed, publishedAt, spaceId, taxonomy } =
        await computeUpdate(tx, actor, id, expectedVersion, input, now);
      await assertTitleAvailableInSpace(tx, nextTitle, spaceId, id);

      await tx
        .insertInto('page_versions')
        .values({
          id: newVersionId,
          page_id: id,
          body_markdown: parsed.body,
          raw_markdown: raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: now,
          created_by: actorId,
          parent_version_id: currentVersion?.id ?? null,
        })
        .execute();

      await tx
        .updateTable('pages')
        .set({
          title: nextTitle,
          status,
          type: typeFromFrontmatter(parsed.frontmatter),
          space_id: spaceId,
          updated_at: now,
          published_at: publishedAt,
          version_token: current.version_token + 1,
          current_version_id: newVersionId,
          ...lifecycleColumnsFrom(parsed.frontmatter, status),
          ...fileColumns(input.file),
        })
        .where('id', '=', id)
        .execute();

      await syncTaxonomyInTx(tx, id, taxonomy);

      await this.wiki.indexInTx(tx, id, extractItemLinks(parsed));
      await syncImageLinksInTx(tx, id, parsed.body, parsed.frontmatter);
      await reindexPageFts(tx, id);
      if (input.file && input.file.enqueue !== false) await enqueueOutbox(tx, id, input.file, actorId);
    });

    await this.audit.record({
      actor_id: actorId,
      action: 'page.update',
      page_id: id,
      version_id: newVersionId,
      payload: { expected_version: expectedVersion },
    });
    return (await this.getById(id))!;
  }

  /**
   * Rename, part one (plan §6.4, §7.3): everything the rename will persist,
   * computed against the current rows before anything is written — the
   * validation and rowversion checks (400/403/404/409) all run here, so the
   * write-first caller fails before it touches a file.
   *
   * The plan lists the subject first, then every inbound page whose wiki-links
   * this rename rewrites (`update_all`); with `skip` only the subject is
   * listed. `now` is the timestamp both the rendered files and the rows must
   * carry, so the caller passes the one it will use.
   */
  async prepareRename(
    actor: { id: string; role: 'user' | 'admin' },
    pageId: string,
    expectedVersion: number,
    newTitle: string,
    linkAction: 'update_all' | 'skip',
    expectedAffectedVersions: Record<string, number> = {},
    now: string = nowIso(),
  ): Promise<PreparedRename> {
    const trimmed = newTitle.trim();
    if (!trimmed) throw new BadRequestException('title cannot be empty');
    if (trimmed.length > 500) throw new BadRequestException('title too long');

    // Defensively coerce the expected-versions map: the DTO accepts a free-form
    // Record<string, unknown> via class-validator's @IsOptional, so anything
    // non-numeric reaching us is a bug or a hostile client.
    const sanitizedExpected: Record<string, number> = {};
    for (const [key, value] of Object.entries(expectedAffectedVersions)) {
      if (typeof key !== 'string') continue;
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        throw new BadRequestException(
          `expected_affected_versions[${key}] must be a finite number`,
        );
      }
      sanitizedExpected[key] = numeric;
    }

    const subject = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', pageId)
      .executeTakeFirst();
    if (!subject || subject.deleted_at) throw new NotFoundException('Page not found');
    assertCanMutate(subject, actor);
    if (subject.version_token !== expectedVersion) {
      throw new ConflictException({
        message: 'Page was modified by someone else',
        current_version_token: subject.version_token,
      });
    }
    const oldTitle = subject.title;
    const base = { now, newTitle: trimmed, linkAction, subjectId: pageId, expectedVersion };
    // Nothing to rename: same title in, same title out (and no file to rewrite).
    if (oldTitle === trimmed) return { ...base, writes: [], noop: true };
    await assertTitleAvailableInSpace(this.db, trimmed, subject.space_id, subject.id);

    const subjectVersion = subject.current_version_id
      ? await this.db
          .selectFrom('page_versions')
          .selectAll()
          .where('id', '=', subject.current_version_id)
          .executeTakeFirst()
      : null;
    if (!subjectVersion) throw new NotFoundException('Page version not found');

    // The subject's frontmatter.title is the whole of the rename.
    const oldFrontmatter = JSON.parse(subjectVersion.frontmatter_json) as Record<string, unknown>;
    const subjectRaw = serializeFromParts({ ...oldFrontmatter, title: trimmed }, subjectVersion.body_markdown);
    const writes: RenamePageWrite[] = [await this.renameWrite(subject, trimmed, subjectRaw, true)];

    if (linkAction === 'skip') return { ...base, writes, noop: false };

    // Inbound wiki-links to the old title, in the pages that carry them.
    const inbound = await this.db
      .selectFrom('item_links as l')
      .innerJoin('pages as p', 'p.id', 'l.source_page_id')
      .select(['p.id'])
      .where('l.link_type', '=', 'wiki')
      .where('l.target_ref', '=', oldTitle)
      .where('p.deleted_at', 'is', null)
      .distinct()
      .execute();

    for (const { id } of inbound) {
      const row = await this.db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row || row.deleted_at) continue;
      const expected = sanitizedExpected[row.id];
      if (expected !== undefined && row.version_token !== expected) {
        throw new ConflictException({
          message: `Page ${row.title} was modified by someone else`,
          page_id: row.id,
        });
      }
      const version = row.current_version_id
        ? await this.db
            .selectFrom('page_versions')
            .selectAll()
            .where('id', '=', row.current_version_id)
            .executeTakeFirst()
        : null;
      if (!version) continue;

      const parsedSrc = parse(version.raw_markdown);
      const result = rewriteWikiLinks(parsedSrc, oldTitle, trimmed);
      if (result.count === 0) continue;
      writes.push(await this.renameWrite(row, row.title, serializeWithBody(parsedSrc, result.body), false));
    }
    return { ...base, writes, noop: false };
  }

  /**
   * Rename, part two: persist the plan. One transaction across the subject and
   * every affected page — rows, versions, wiki-link index, FTS, the canonical
   * `file_*` columns and one `content_outbox` row per file the caller wrote.
   *
   * Every rowversion the plan was computed against is re-checked here, so a
   * concurrent edit between the plan and this transaction rolls the whole
   * rename back (and the caller restores the files it wrote).
   */
  async applyRename(
    actor: { id: string; role: 'user' | 'admin' },
    prepared: PreparedRename,
    files: Map<string, CanonicalFileRef> = new Map(),
  ): Promise<RenameOutcome> {
    const actorId = actor.id;
    const { now, newTitle: trimmed, linkAction, subjectId } = prepared;
    const affected: { id: string; slug: string; title: string }[] = [];
    let resultVersionId = '';

    if (!prepared.noop) {
      await this.db.transaction().execute(async (tx) => {
        const subject = await tx
          .selectFrom('pages')
          .selectAll()
          .where('id', '=', subjectId)
          .executeTakeFirst();
        if (!subject || subject.deleted_at) throw new NotFoundException('Page not found');
        assertCanMutate(subject, actor);
        if (subject.version_token !== prepared.expectedVersion) {
          throw new ConflictException({
            message: 'Page was modified by someone else',
            current_version_token: subject.version_token,
          });
        }
        await assertTitleAvailableInSpace(tx, trimmed, subject.space_id, subject.id);

        for (const write of prepared.writes) {
          const row = write.subject
            ? subject
            : await tx.selectFrom('pages').selectAll().where('id', '=', write.page.id).executeTakeFirst();
          if (!row || row.deleted_at) throw new NotFoundException('Page not found');
          if (row.version_token !== write.versionToken) {
            throw new ConflictException({
              message: `Page ${row.title} was modified by someone else`,
              page_id: row.id,
            });
          }

          const parsed = parse(write.nextRaw);
          const versionId = newId();
          await tx
            .insertInto('page_versions')
            .values({
              id: versionId,
              page_id: row.id,
              body_markdown: parsed.body,
              raw_markdown: write.nextRaw,
              frontmatter_json: JSON.stringify(parsed.frontmatter),
              parsed_ast_json: JSON.stringify(parsed.ast),
              created_at: now,
              created_by: actorId,
              parent_version_id: row.current_version_id,
            })
            .execute();

          const file = files.get(row.id);
          await tx
            .updateTable('pages')
            .set({
              title: write.nextTitle,
              updated_at: now,
              version_token: row.version_token + 1,
              current_version_id: versionId,
              ...fileColumns(file),
            })
            .where('id', '=', row.id)
            .execute();

          // The subject's own links did not change (only its frontmatter title);
          // an affected page's did, so its wiki-link index is rebuilt.
          if (!write.subject) await this.wiki.indexInTx(tx, row.id, extractItemLinks(parsed));
          await reindexPageFts(tx, row.id);
          if (file && file.enqueue !== false) await enqueueOutbox(tx, row.id, file, actorId);

          if (write.subject) resultVersionId = versionId;
          affected.push({ id: row.id, slug: row.slug, title: write.nextTitle });
        }
      });
    }

    await this.audit.record({
      actor_id: actorId,
      action: 'page.rename',
      page_id: subjectId,
      version_id: resultVersionId,
      payload: {
        new_title: trimmed,
        link_action: linkAction,
        affected_count: affected.length,
      },
    });
    return { page: (await this.getById(subjectId))!, affected_pages: affected };
  }

  /** One planned rename write: the row as it stands plus the document it becomes. */
  private async renameWrite(
    row: Selectable<Database['pages']>,
    nextTitle: string,
    nextRaw: string,
    subject: boolean,
  ): Promise<RenamePageWrite> {
    return {
      page: await this.hydrate(row),
      nextTitle,
      nextRaw,
      spaceName: await exportSpaceName(this.db, row.space_id),
      filePath: row.file_path,
      fileDigest: row.file_digest,
      sourceId: row.source_id,
      versionToken: row.version_token,
      subject,
    };
  }

  async listVersions(
    pageId: string,
    actor?: ReadActor,
  ): Promise<{ id: string; created_at: string; created_by: string }[]> {
    // Version history is only visible to callers who can see the page itself.
    if (!(await this.getById(pageId, { actor }))) throw new NotFoundException('Page not found');
    return this.db
      .selectFrom('page_versions')
      .select(['id', 'created_at', 'created_by'])
      .where('page_id', '=', pageId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async getVersion(
    pageId: string,
    versionId: string,
    actor?: ReadActor,
  ): Promise<{ id: string; raw_markdown: string; body_markdown: string; frontmatter: Record<string, unknown>; created_at: string; created_by: string } | null> {
    if (!(await this.getById(pageId, { actor }))) throw new NotFoundException('Page not found');
    const row = await this.db
      .selectFrom('page_versions')
      .selectAll()
      .where('id', '=', versionId)
      .where('page_id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      raw_markdown: row.raw_markdown,
      body_markdown: row.body_markdown,
      frontmatter: JSON.parse(row.frontmatter_json) as Record<string, unknown>,
      created_at: row.created_at,
      created_by: row.created_by,
    };
  }

  /**
   * Soft-delete the row. `file` names the canonical file the caller already
   * unlinked from the working tree, so the `delete` outbox row lands in the
   * same transaction as the row update and the FTS removal — the write-first
   * contract (plan §7.3) applied to a removal.
   *
   * It is deliberately OPTIONAL: `InboundIndexService` calls this for a file
   * that was deleted UPSTREAM and has already vanished from the working tree,
   * where there is no file to unlink and nothing to push. Same meaning as
   * `CanonicalFileRef.enqueue: false` — indexed, nothing outstanding.
   *
   * `file_path` / `file_digest` / `source_id` are left on the row: they are what
   * `restore` re-renders the file from, and no live read consults them for a
   * deleted row (`rowByPath` and every list query filter `deleted_at`).
   */
  async softDelete(actor: ReadActor, id: string, file?: CanonicalFileRef): Promise<void> {
    const actorId = actor.id;
    const now = nowIso();
    // The row update and FTS removal must commit together, or a crash between
    // them leaves a deleted page still searchable. Audit stays after the tx,
    // matching create/update/rename.
    await this.db.transaction().execute(async (tx) => {
      const page = await tx
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!page) throw new NotFoundException('Page not found');
      assertCanMutate(page, actor);
      await tx
        .updateTable('pages')
        .set({ deleted_at: now })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .execute();
      // The row is now deleted, so this clears its FTS and author rows.
      await reindexPageFts(tx, id);
      if (file && file.enqueue !== false) await enqueueOutbox(tx, id, file, actorId, 'delete');
    });
    await this.audit.record({ actor_id: actorId, action: 'page.delete', page_id: id });
  }

  /**
   * Bring a soft-deleted row back. `file` names the concept file the caller
   * re-wrote for it (the mirror image of `softDelete`): its columns are
   * re-recorded and an `upsert` outbox row rides the same transaction. Omitted
   * by the inbound path, where the file is already the canonical one.
   */
  async restore(actor: ReadActor, id: string, file?: CanonicalFileRef): Promise<PageView> {
    const actorId = actor.id;
    // Restore the row and rebuild its FTS index atomically, so a crash can't
    // leave a restored page missing from search.
    await this.db.transaction().execute(async (tx) => {
      const page = await tx
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!page) throw new NotFoundException();
      assertCanMutate(page, actor);
      if (!page.deleted_at) throw new BadRequestException('Page is not deleted');
      const deletedAt = new Date(page.deleted_at).getTime();
      if (Date.now() - deletedAt > 30 * 24 * 60 * 60 * 1000) {
        throw new BadRequestException('Restore window (30 days) elapsed');
      }
      await tx
        .updateTable('pages')
        .set({ deleted_at: null, ...fileColumns(file) })
        .where('id', '=', id)
        .execute();
      if (file && file.enqueue !== false) await enqueueOutbox(tx, id, file, actorId);
      // Rebuild FTS for the page — the same routine every write uses.
      await reindexPageFts(tx, id);
    });
    await this.audit.record({ actor_id: actorId, action: 'page.restore', page_id: id });
    return (await this.getById(id))!;
  }

  private async findFreeSlug(title: string): Promise<string> {
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    // Loop bounded by a reasonable cap; collisions in v0.1 are rare.
    while (n < 100) {
      const taken = await this.db
        .selectFrom('pages')
        .select('id')
        .where('slug', '=', candidate)
        .executeTakeFirst();
      if (!taken) return candidate;
      candidate = `${base}-${n}`;
      n++;
    }
    throw new ConflictException('Could not find a free slug after 100 attempts');
  }

  private async hydrate(row: Selectable<Database['pages']>): Promise<PageView> {
    const [tags, categories, groups] = await Promise.all([
      this.tagsForPage(this.db, row.id),
      this.categoriesForPage(this.db, row.id),
      this.groupsForPage(this.db, row.id),
    ]);
    const ver = row.current_version_id
      ? await this.db
          .selectFrom('page_versions')
          .selectAll()
          .where('id', '=', row.current_version_id)
          .executeTakeFirst()
      : null;
    const source = row.source_id
      ? ((await this.db
          .selectFrom('content_sources')
          .select(['role', 'mode', 'remote_url', 'branch', 'host_kind', 'host_base_url'])
          .where('id', '=', row.source_id)
          .executeTakeFirst()) ?? null)
      : null;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      type: row.type,
      owner_id: row.owner_id,
      space_id: row.space_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
      version_token: row.version_token,
      current_version_id: row.current_version_id,
      body_markdown: ver?.body_markdown ?? '',
      raw_markdown: ver?.raw_markdown ?? '',
      frontmatter: ver ? (JSON.parse(ver.frontmatter_json) as Record<string, unknown>) : {},
      tags,
      categories,
      groups,
      review: reviewRefFrom(row),
      source: sourceRefFrom(row.source_id, row.file_path, source),
    };
  }

  private async tagsForPage(db: Kysely<Database>, pageId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('page_tags')
      .select('tag')
      .where('page_id', '=', pageId)
      .orderBy('tag', 'asc')
      .execute();
    return rows.map((r) => r.tag);
  }

  private async categoriesForPage(db: Kysely<Database>, pageId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('page_categories')
      .select('category')
      .where('page_id', '=', pageId)
      .orderBy('category', 'asc')
      .execute();
    return rows.map((r) => r.category);
  }

  private async groupsForPage(db: Kysely<Database>, pageId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('page_groups')
      .innerJoin('groups', 'groups.id', 'page_groups.group_id')
      .select('groups.slug')
      .where('page_groups.page_id', '=', pageId)
      .orderBy('groups.slug', 'asc')
      .execute();
    return rows.map((r) => r.slug);
  }
}

/**
 * v0.1 draft-visibility rule. Admins see everything; other actors see
 * published pages and pages they own. When `actor` is omitted, the caller is
 * trusted (internal hydration / post-write reads) and no filtering applies.
 */
function isVisibleTo(
  page: { status: 'draft' | 'published'; owner_id: string | null },
  actor?: ReadActor,
): boolean {
  if (!actor) return true;
  if (actor.role === 'admin') return true;
  if (page.status === 'published') return true;
  return page.owner_id === actor.id;
}

/** The unauthenticated visitor bound by SessionGuard on a public instance. */
export function isAnonymousActor(actor?: ReadActor): boolean {
  return actor?.id === ANONYMOUS_ACTOR.id;
}

/**
 * v0.1 mutation rule: only the page owner or an admin may modify a page
 * (update, rename, soft-delete, restore). When `actor` is omitted the caller is
 * trusted (internal hooks) and the check is bypassed. Throws 403 otherwise.
 */
function assertCanMutate(
  page: { owner_id: string | null },
  actor?: ReadActor,
): void {
  if (!actor) return;
  if (actor.role === 'admin') return;
  if (page.owner_id === actor.id) return;
  throw new ForbiddenException('Only the page owner or an admin can modify this page');
}

/**
 * Build a canonical raw-Markdown document from a frontmatter object + body.
 * Preserve body bytes exactly after the frontmatter fence so an authored leading
 * H1 stays body content instead of being normalized or rewritten as metadata.
 */
/**
 * The OKF concept kind, mirrored from frontmatter into the derived `type`
 * column. Known types are canonicalized to their registry label (so `faq`/`FAQ`
 * collapse to `FAQ` for reliable section/filter matching); unknown types pass
 * through trimmed — the stored frontmatter (file bytes) is left as authored.
 */
function typeFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  return canonicalTypeLabel(frontmatter['type'] as string | undefined);
}

/** An explicit publish date from frontmatter (`published_at`, then OKF `timestamp`), or null. */
export function explicitPublishedAt(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter['published_at'] ?? frontmatter['date'];
  const iso = coerceIso(raw);
  if (iso) return iso;
  return null;
}

/**
 * Resolve an item's publish date (ADR: git-of-record blog dates).
 *
 * Precedence: an explicit frontmatter date always wins; otherwise stamp `now` on
 * the first draft->published transition; once set it is never auto-rewritten
 * (editing a published post must not re-date it). Unpublishing keeps the date so
 * re-publishing preserves the original — matching how blogs behave.
 */
export function resolvePublishedAt(
  frontmatter: Record<string, unknown>,
  status: 'draft' | 'published',
  current: string | null,
  now: string,
): string | null {
  const explicit = explicitPublishedAt(frontmatter);
  if (explicit) return explicit;
  if (current) return current;
  return status === 'published' ? now : null;
}

/** Coerce a YAML date value to an ISO string; YAML may parse a bare date to a Date. */
function coerceIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function serializeFromParts(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter);
  const block = `---\n${yaml}---\n`;
  return block + body;
}

function shallowEqualRecords(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a).filter((key) => a[key] !== undefined).sort();
  const bKeys = Object.keys(b).filter((key) => b[key] !== undefined).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

export async function ensureSpaceForFrontmatterInTx(
  db: Kysely<Database>,
  frontmatter: Record<string, unknown>,
): Promise<string> {
  const rawSpace = frontmatter['space'] ?? frontmatter['topic'];
  if (typeof rawSpace !== 'string' || rawSpace.trim().length === 0) return DEFAULT_SPACE_ID;

  const name = rawSpace.trim();
  const slug = slugify(name);
  if (!slug) return DEFAULT_SPACE_ID;

  const existing = await db
    .selectFrom('spaces')
    .select(['id'])
    .where((eb) => eb.or([eb('slug', '=', slug), eb('name', '=', name)]))
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (existing) return existing.id;

  const now = nowIso();
  const id = `space_${slug}`;
  await db
    .insertInto('spaces')
    .values({
      id,
      slug,
      name,
      description: null,
      created_at: now,
      updated_at: now,
      archived_at: null,
      // Auto-created from frontmatter (`space`/`topic`), which includes the
      // repo-pull path. Public by default, matching the column default and the
      // behaviour before this column existed. NOTE: that means pulling a repo
      // into a brand-new topic makes its PUBLISHED items anonymously readable on
      // a public instance as soon as the pull lands — set the topic to private
      // first if that is not wanted.
      visibility: 'public',
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  const row = await db.selectFrom('spaces').select(['id']).where('slug', '=', slug).executeTakeFirst();
  return row?.id ?? DEFAULT_SPACE_ID;
}

/**
 * The computation shared by `prepareUpdate` (before the canonical file is
 * written) and `update` (inside its transaction): loads the current row and
 * version, runs the mutation/concurrency checks, and derives the next raw
 * document. `ensureSpace` is idempotent, so running this twice is safe.
 */
async function computeUpdate(
  db: Kysely<Database> | Transaction<Database>,
  actor: ReadActor,
  id: string,
  expectedVersion: number,
  input: UpdatePageInput,
  now: string,
): Promise<{
  current: Selectable<Database['pages']>;
  currentVersion: Database['page_versions'] | null;
  nextTitle: string;
  status: 'draft' | 'published';
  raw: string;
  parsed: ParsedPage;
  publishedAt: string | null;
  spaceId: string;
  taxonomy: ReturnType<typeof taxonomyFromFrontmatter>;
}> {
  const current = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!current || current.deleted_at) throw new NotFoundException('Page not found');
  assertCanMutate(current, actor);
  if (current.version_token !== expectedVersion) {
    throw new ConflictException({
      message: 'Page was modified by someone else',
      current_version_token: current.version_token,
    });
  }

  const currentVersion = current.current_version_id
    ? ((await db
        .selectFrom('page_versions')
        .selectAll()
        .where('id', '=', current.current_version_id)
        .executeTakeFirst()) ?? null)
    : null;

  const currentFrontmatter = currentVersion
    ? (JSON.parse(currentVersion.frontmatter_json) as Record<string, unknown>)
    : {};

  const nextFrontmatter = {
    ...currentFrontmatter,
    ...(input.frontmatter ?? {}),
  };
  if (input.title !== undefined) nextFrontmatter['title'] = input.title.trim();
  if (input.status !== undefined) nextFrontmatter['status'] = input.status;

  const nextTitle = (nextFrontmatter['title'] as string | undefined)?.trim() ?? current.title;
  if (!nextTitle) throw new BadRequestException('title cannot be empty');
  if (nextTitle.length > 500) throw new BadRequestException('title too long');

  const status = (nextFrontmatter['status'] as 'draft' | 'published' | undefined) ?? current.status;
  if (status !== 'draft' && status !== 'published') {
    throw new BadRequestException('invalid status');
  }

  // Stamp/carry the publish date into frontmatter before the raw is built, so
  // the shouldRewriteRaw check below sees it and the file stays authoritative.
  const stampedPublishedAt = resolvePublishedAt(nextFrontmatter, status, current.published_at, now);
  if (stampedPublishedAt) nextFrontmatter['published_at'] = stampedPublishedAt;

  let raw: string;
  if (input.raw !== undefined) {
    const rawParsed = parse(input.raw);
    const body = rawParsed.body;
    const rawHasFrontmatter = input.raw.trimStart().startsWith('---') || Object.keys(rawParsed.frontmatter).length > 0;
    const metadataChanged = input.title !== undefined || input.status !== undefined || input.frontmatter !== undefined;
    const shouldRewriteRaw = (rawHasFrontmatter && !shallowEqualRecords(nextFrontmatter, rawParsed.frontmatter)) || (!rawHasFrontmatter && metadataChanged);
    raw = shouldRewriteRaw ? serializeFromParts(nextFrontmatter, body) : input.raw;
  } else {
    const body = input.body ?? (currentVersion?.body_markdown ?? '');
    raw = serializeFromParts(nextFrontmatter, body);
  }

  const parsed = parse(raw);
  const publishedAt = resolvePublishedAt(parsed.frontmatter, status, current.published_at, now);
  const spaceId = await ensureSpaceForFrontmatterInTx(db, parsed.frontmatter);
  const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, input.tags);
  return { current, currentVersion, nextTitle, status, raw, parsed, publishedAt, spaceId, taxonomy };
}

/** Taxonomy as `hydrate` reads it back: groups by slug, every list sorted. */
function persistedTaxonomy(t: ReturnType<typeof taxonomyFromFrontmatter>): PersistedTaxonomy {
  return {
    tags: t.tags,
    categories: t.categories,
    groups: Array.from(new Set(t.groups.map((g) => slugify(g)).filter(Boolean))).sort(),
  };
}

function fileColumns(file: CanonicalFileRef | undefined): Partial<Pick<Database['pages'], 'file_digest' | 'file_path' | 'source_id'>> {
  if (!file) return {};
  return { file_digest: file.digest, file_path: file.path, source_id: file.sourceId };
}

function enqueueOutbox(
  tx: Transaction<Database>,
  pageId: string,
  file: CanonicalFileRef,
  actorId: string,
  kind: ContentOutboxTable['kind'] = 'upsert',
): Promise<void> {
  return enqueueOutboxInTx(tx, {
    kind,
    page_id: pageId,
    source_id: file.sourceId,
    file_path: file.path,
    file_digest: file.digest,
    actor_id: actorId,
  });
}

/** A pre-allocated slug must still be free when the row lands (two creates racing for it). */
async function assertSlugFree(db: Transaction<Database>, slug: string): Promise<void> {
  const taken = await db.selectFrom('pages').select('id').where('slug', '=', slug).executeTakeFirst();
  if (taken) throw new ConflictException(`slug "${slug}" was taken concurrently; retry`);
}

async function assertTitleAvailableInSpace(
  db: Kysely<Database> | Transaction<Database>,
  title: string,
  spaceId: string | null,
  excludePageId?: string,
): Promise<void> {
  let query = db
    .selectFrom('pages')
    .select('id')
    .where('title', '=', title)
    .where('deleted_at', 'is', null);

  query = spaceId === null ? query.where('space_id', 'is', null) : query.where('space_id', '=', spaceId);
  if (excludePageId) query = query.where('id', '!=', excludePageId);

  const duplicate = await query.executeTakeFirst();
  if (duplicate) {
    throw new ConflictException(`An item titled "${title}" already exists in this topic`);
  }
}

/**
 * Lightweight deterministic YAML emitter for v0.1 page frontmatter.
 *
 * Supports the small set of types our frontmatter uses (string, number, bool,
 * array of primitives, plain object, null). Strings are quoted only if they
 * contain characters that would otherwise mis-parse. We do not aim for full
 * YAML 1.2 — gray-matter handles parsing, and the reverse direction is only
 * exercised when we synthesise a doc from an object (create + body-update paths).
 */
function stringifyYaml(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${pad}${key}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (value.every((v) => isScalar(v))) {
        lines.push(`${pad}${key}: [${value.map((v) => formatScalar(v)).join(', ')}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const v of value) {
          if (isScalar(v)) {
            lines.push(`${pad}  - ${formatScalar(v)}`);
          } else if (typeof v === 'object' && v !== null) {
            const nested = stringifyYaml(v as Record<string, unknown>, indent + 4).split('\n').filter(Boolean);
            if (nested.length === 0) lines.push(`${pad}  - {}`);
            else {
              const [first, ...rest] = nested;
              lines.push(`${pad}  - ${first!.trimStart()}`);
              for (const r of rest) lines.push(r);
            }
          }
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(stringifyYaml(value as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (v === '') return '""';
    if (/^[\w\-./@:+]+$/.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) && !/^-?\d/.test(v)) {
      return v;
    }
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

