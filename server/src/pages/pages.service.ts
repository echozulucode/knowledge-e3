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
import { Kysely, sql, type Transaction } from 'kysely';
import {
  parse,
  serializeWithBody,
  rewriteWikiLinks,
  extractItemLinks,
  type ParsedPage,
} from '@echozedlabs/codec';
import type { Database } from '../db/schema.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { KYSELY } from '../db/db.module.js';
import { newId, nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import { AuditService } from '../audit/audit.service.js';
import { WikiService } from '../wiki/wiki.service.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from './taxonomy.js';
import { syncImageLinksInTx } from './image-links.js';
import { canonicalTypeLabel } from '../content-types/content-types.registry.js';
import { DEFAULT_SPACE_ID } from '../taxonomy/spaces.service.js';
import type { AuthedUser } from '../auth/auth.service.js';

/**
 * Visibility actor for read endpoints. When provided, `PagesService` enforces
 * the v0.1 draft-visibility rule: non-admin callers see published pages plus
 * their own drafts. Omit `actor` only for trusted internal callers
 * (post-create hydration, internal hooks); never accept undefined at a
 * request entrypoint.
 */
export type ReadActor = Pick<AuthedUser, 'id' | 'role'>;

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
}

export interface CreatePageInput {
  title: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  status?: 'draft' | 'published';
  tags?: string[];
  /** Optional: the full raw markdown the editor sent. Takes precedence over body+frontmatter. */
  raw?: string;
}

export interface UpdatePageInput {
  body?: string;
  frontmatter?: Record<string, unknown>;
  title?: string;
  status?: 'draft' | 'published';
  tags?: string[];
  /** Optional: the full raw markdown the editor sent. Takes precedence over body+frontmatter. */
  raw?: string;
}

export interface RenameOutcome {
  page: PageView;
  affected_pages: { id: string; slug: string; title: string }[];
}

@Injectable()
export class PagesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly wiki: WikiService,
  ) {}

  async create(actorId: string, input: CreatePageInput): Promise<PageView> {
    const title = input.title.trim();
    if (!title) throw new BadRequestException('title is required');
    if (title.length > 500) throw new BadRequestException('title too long');

    const status = input.status ?? 'draft';
    if (status !== 'draft' && status !== 'published') {
      throw new BadRequestException('invalid status');
    }

    const slug = await this.findFreeSlug(title);
    const id = newId();
    const versionId = newId();
    const now = nowIso();
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

    await this.db.transaction().execute(async (tx) => {
      const spaceId = await ensureSpaceForFrontmatterInTx(tx, parsed.frontmatter);
      await assertTitleAvailableInSpace(tx, title, spaceId);
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
      await syncImageLinksInTx(tx, id, parsed.body);
      await indexFts(tx, id, title, parsed.body, taxonomy.tags);
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

  async list(
    opts: {
      q?: string;
      status?: 'draft' | 'published';
      tag?: string;
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
    } = {},
    actor?: ReadActor,
  ): Promise<PageView[]> {
    let q = this.db
      .selectFrom('pages')
      .selectAll()
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
    if (opts.tag) {
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('page_tags')
            .select('page_id')
            .whereRef('page_tags.page_id', '=', 'pages.id')
            .where('page_tags.tag', '=', opts.tag!),
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
    const now = nowIso();

    await this.db.transaction().execute(async (tx) => {
      const current = await tx
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
        ? await tx
            .selectFrom('page_versions')
            .selectAll()
            .where('id', '=', current.current_version_id)
            .executeTakeFirst()
        : null;

      const currentRaw = currentVersion?.raw_markdown ?? '';
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
      const spaceId = await ensureSpaceForFrontmatterInTx(tx, parsed.frontmatter);
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
        })
        .where('id', '=', id)
        .execute();

      const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, input.tags);
      await syncTaxonomyInTx(tx, id, taxonomy);

      await this.wiki.indexInTx(tx, id, extractItemLinks(parsed));
      await syncImageLinksInTx(tx, id, parsed.body);
      await indexFts(tx, id, nextTitle, parsed.body, taxonomy.tags);
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
   * Rename flow from spec section 6.4. Atomic across all affected pages with
   * rowversion checks. The caller passes a `link_action` to resolve the
   * dialog: 'update_all' rewrites inbound wiki-links; 'skip' leaves them broken.
   */
  async rename(
    actor: { id: string; role: 'user' | 'admin' },
    pageId: string,
    expectedVersion: number,
    newTitle: string,
    linkAction: 'update_all' | 'skip',
    expectedAffectedVersions: Record<string, number> = {},
  ): Promise<RenameOutcome> {
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
    const actorId = actor.id;

    const affected: { id: string; slug: string; title: string }[] = [];
    let resultVersionId = '';
    const now = nowIso();

    await this.db.transaction().execute(async (tx) => {
      const subject = await tx
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
      if (oldTitle === trimmed) return;
      await assertTitleAvailableInSpace(tx, trimmed, subject.space_id, subject.id);

      const subjectVersion = subject.current_version_id
        ? await tx
            .selectFrom('page_versions')
            .selectAll()
            .where('id', '=', subject.current_version_id)
            .executeTakeFirst()
        : null;
      if (!subjectVersion) throw new NotFoundException('Page version not found');

      // Update the subject's frontmatter.title.
      const oldFrontmatter = JSON.parse(subjectVersion.frontmatter_json) as Record<string, unknown>;
      const nextFrontmatter = { ...oldFrontmatter, title: trimmed };
      const subjectRaw = serializeFromParts(nextFrontmatter, subjectVersion.body_markdown);
      const subjectParsed = parse(subjectRaw);
      const subjectVersionId = newId();

      await tx
        .insertInto('page_versions')
        .values({
          id: subjectVersionId,
          page_id: subject.id,
          body_markdown: subjectParsed.body,
          raw_markdown: subjectRaw,
          frontmatter_json: JSON.stringify(subjectParsed.frontmatter),
          parsed_ast_json: JSON.stringify(subjectParsed.ast),
          created_at: now,
          created_by: actorId,
          parent_version_id: subjectVersion.id,
        })
        .execute();

      await tx
        .updateTable('pages')
        .set({
          title: trimmed,
          updated_at: now,
          version_token: subject.version_token + 1,
          current_version_id: subjectVersionId,
        })
        .where('id', '=', subject.id)
        .execute();
      resultVersionId = subjectVersionId;
      affected.push({ id: subject.id, slug: subject.slug, title: trimmed });

      const tagsForSubject = await this.tagsForPage(tx, subject.id);
      await indexFts(tx, subject.id, trimmed, subjectParsed.body, tagsForSubject);

      if (linkAction === 'skip') return;

      // Rewrite inbound links.
      const inbound = await tx
        .selectFrom('item_links as l')
        .innerJoin('pages as p', 'p.id', 'l.source_page_id')
        .select(['p.id', 'p.slug', 'p.title', 'p.version_token', 'p.current_version_id'])
        .where('l.link_type', '=', 'wiki')
        .where('l.target_ref', '=', oldTitle)
        .where('p.deleted_at', 'is', null)
        .distinct()
        .execute();

      for (const inb of inbound) {
        const expected = sanitizedExpected[inb.id];
        if (expected !== undefined && inb.version_token !== expected) {
          throw new ConflictException({
            message: `Page ${inb.title} was modified by someone else`,
            page_id: inb.id,
          });
        }
        const inbVersion = inb.current_version_id
          ? await tx
              .selectFrom('page_versions')
              .selectAll()
              .where('id', '=', inb.current_version_id)
              .executeTakeFirst()
          : null;
        if (!inbVersion) continue;

        const parsedSrc = parse(inbVersion.raw_markdown);
        const result = rewriteWikiLinks(parsedSrc, oldTitle, trimmed);
        if (result.count === 0) continue;
        const newBody = result.body;
        const newRaw = serializeWithBody(parsedSrc, newBody);
        const newParsed = parse(newRaw);
        const newVid = newId();
        await tx
          .insertInto('page_versions')
          .values({
            id: newVid,
            page_id: inb.id,
            body_markdown: newParsed.body,
            raw_markdown: newRaw,
            frontmatter_json: JSON.stringify(newParsed.frontmatter),
            parsed_ast_json: JSON.stringify(newParsed.ast),
            created_at: now,
            created_by: actorId,
            parent_version_id: inbVersion.id,
          })
          .execute();
        await tx
          .updateTable('pages')
          .set({
            updated_at: now,
            version_token: inb.version_token + 1,
            current_version_id: newVid,
          })
          .where('id', '=', inb.id)
          .execute();

        await this.wiki.indexInTx(tx, inb.id, extractItemLinks(newParsed));
        const inbTags = await this.tagsForPage(tx, inb.id);
        await indexFts(tx, inb.id, inb.title, newParsed.body, inbTags);
        affected.push({ id: inb.id, slug: inb.slug, title: inb.title });
      }
    });

    await this.audit.record({
      actor_id: actorId,
      action: 'page.rename',
      page_id: pageId,
      version_id: resultVersionId,
      payload: {
        new_title: trimmed,
        link_action: linkAction,
        affected_count: affected.length,
      },
    });
    return { page: (await this.getById(pageId))!, affected_pages: affected };
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

  async softDelete(actor: ReadActor, id: string): Promise<void> {
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
      await sql`DELETE FROM pages_fts WHERE page_id = ${id}`.execute(tx);
    });
    await this.audit.record({ actor_id: actorId, action: 'page.delete', page_id: id });
  }

  async restore(actor: ReadActor, id: string): Promise<PageView> {
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
        .set({ deleted_at: null })
        .where('id', '=', id)
        .execute();
      // Rebuild FTS for the page.
      const ver = page.current_version_id
        ? await tx
            .selectFrom('page_versions')
            .selectAll()
            .where('id', '=', page.current_version_id)
            .executeTakeFirst()
        : null;
      if (ver) {
        const tags = await this.tagsForPage(tx, id);
        await indexFts(tx, id, page.title, ver.body_markdown, tags);
      }
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

  private async hydrate(row: Database['pages']): Promise<PageView> {
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
