import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parse } from '@echozedlabs/codec';
import type { ItemSourceRef, ReviewRef } from '../pages/lifecycle-columns.js';
import { PagesService, type CreatePageInput, type PageView, type ReadActor, type UpdatePageInput } from '../pages/pages.service.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { REVISION_MIRROR, type MovedOutSource, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';

export interface ItemView {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  type: string | null;
  owner_id: string | null;
  space_id: string | null;
  created_at: string;
  updated_at: string;
  version_token: number;
  current_version_id: string | null;
  body_markdown: string;
  raw_markdown: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  categories: string[];
  groups: string[];
  /** Open/settled change request for this item in a `review` source (plan §8.2); null otherwise. */
  review?: ReviewRef | null;
  /** Where this item's canonical file lives (plan §8.3); null when the row records no source. */
  source?: ItemSourceRef | null;
}

export interface CreateItemInput {
  /** Internal stable identity used by trusted restore/import paths. */
  id?: string;
  title?: string;
  body?: string;
  raw?: string;
  raw_markdown?: string;
  frontmatter?: Record<string, unknown>;
  status?: 'draft' | 'published';
  tags?: string[];
}

export interface UpdateItemInput {
  title?: string;
  body?: string;
  raw?: string;
  raw_markdown?: string;
  frontmatter?: Record<string, unknown>;
  status?: 'draft' | 'published';
  tags?: string[];
}

export interface ListItemsInput {
  q?: string;
  status?: 'draft' | 'published';
  tag?: string;
  since?: string;
  limit?: number;
  /** Restrict to a single space (topic), by space id or slug. */
  space?: string;
  /** Restrict to a single concept kind (OKF `type`) — the "section" filter. */
  type?: string;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly pages: PagesService,
    @Inject(REVISION_MIRROR) private readonly mirror: RevisionMirrorPort,
    private readonly paths: ContentPathResolver,
  ) {}

  /**
   * Index-only create/update: no canonical file, no `content_outbox` row. Not a
   * content door — every door writes through `ContentCommandsService` (issue 70;
   * the OKF import was the last production caller). What remains are test
   * fixtures that deliberately seed rows without files (e.g. the git-mirror
   * adapter suites). Do not call these from `src/`.
   */
  async create(actorId: string, input: CreateItemInput): Promise<ItemView> {
    const pageInput = normalizeCreateInput(input);
    const page = await this.pages.create(actorId, pageInput);
    await this.emitMirror(actorId, page);
    return toItem(page);
  }

  async list(input: ListItemsInput = {}, actor?: ReadActor): Promise<ItemView[]> {
    const pages = await this.pages.list(input, actor);
    return pages.map(toItem);
  }

  async getById(id: string, actor?: ReadActor): Promise<ItemView | null> {
    const page = await this.pages.getById(id, { actor });
    return page ? toItem(page) : null;
  }

  async getBySlug(slug: string, actor?: ReadActor): Promise<ItemView | null> {
    const page = await this.pages.getBySlug(slug, actor);
    return page ? toItem(page) : null;
  }

  async getByTitle(title: string, actor?: ReadActor): Promise<ItemView | null> {
    const page = await this.pages.getByTitle(title, actor);
    return page ? toItem(page) : null;
  }

  async getByTitleInSpace(
    title: string,
    spaceRef?: string,
    actor?: ReadActor,
  ): Promise<{ item: ItemView | null; spaceId: string }> {
    const resolved = await this.pages.getByTitleInSpace(title, spaceRef, actor);
    return { item: resolved.page ? toItem(resolved.page) : null, spaceId: resolved.spaceId };
  }

  async update(actor: ReadActor, id: string, expectedVersion: number, input: UpdateItemInput): Promise<ItemView> {
    const pageInput = normalizeUpdateInput(input);
    const page = await this.pages.update(actor, id, expectedVersion, pageInput);
    await this.emitMirror(actor.id, page);
    return toItem(page);
  }

  /**
   * Re-emit every item in a space to the git mirror and flush — the "Sync now"
   * backfill. Covers content that predates a repo binding (the mirror only fires
   * on writes, so existing items need an explicit push). Returns the count.
   *
   * Issue 80: an item whose source is in `review` mode is **skipped**, not
   * refused. The backfill commits through the debounced committer, which would
   * land on the base branch — exactly what review mode forbids — and opening a
   * change request per item is worse than doing nothing. So those items are
   * counted out and the rest of the repair proceeds; aborting an admin repair
   * because one topic is in review is unhelpful. The caller sees `skipped`.
   */
  async resyncSpace(spaceId: string): Promise<{ items: number; skipped: number }> {
    const pages = await this.pages.list({ space: spaceId, limit: 100_000 });
    // Resolved per distinct topic (in practice one), so a listing that spans
    // topics is never gated on the topic the caller named.
    const reviewMode = new Map<string, boolean>();
    let skipped = 0;
    let emitted = 0;
    for (const page of pages) {
      const key = page.space_id ?? '';
      let inReview = reviewMode.get(key);
      if (inReview === undefined) {
        inReview = (await this.paths.resolve(page.space_id)).mode === 'review';
        reviewMode.set(key, inReview);
      }
      if (inReview) {
        skipped++;
        continue;
      }
      await this.emitMirror(page.owner_id ?? 'system', page);
      emitted++;
    }
    if (emitted > 0) await this.mirror.flush?.();
    return { items: emitted, skipped };
  }

  /**
   * Hand the persisted version to the revision mirror (git commit scheduling,
   * outbox bookkeeping). Best-effort: a mirror failure never fails the write.
   * Public so the write-first command emits the very same event.
   */
  async emitMirror(actorId: string, page: PageView, opts: { movedIn?: boolean } = {}): Promise<void> {
    if (!page.current_version_id) return;
    try {
      await this.mirror.afterItemVersionPersisted(
        {
          itemId: page.id,
          versionId: page.current_version_id,
          versionToken: page.version_token,
          actorId,
          title: page.title,
          slug: page.slug,
          rawMarkdown: page.raw_markdown,
          status: page.status,
          spaceId: page.space_id,
          ownerId: page.owner_id,
          tags: page.tags,
          categories: page.categories,
          groups: page.groups,
          createdAt: page.created_at,
          updatedAt: page.updated_at,
        },
        opts,
      );
    } catch {
      // Storage mirrors are best-effort in the MVP; the database remains the source of truth.
    }
  }

  /**
   * The departure half of a topic move (plan 8.3): ask the repository the item
   * LEFT to commit the removal of the file at `path`. Routed by the source the
   * row recorded rather than by the item's topic, which now points at the repo
   * it arrived in. Best-effort like `emitMirror` — the file is already gone from
   * disk and the index already agrees; only the commit is outstanding, and the
   * pending `move` outbox row is what records that.
   */
  async emitMovedOut(actorId: string, page: PageView, from: MovedOutSource, path: string): Promise<void> {
    try {
      await this.mirror.afterItemMovedOut?.(from, {
        itemId: page.id,
        path,
        actorId,
        versionToken: page.version_token,
      });
    } catch {
      // Best-effort: a mirror failure never fails the write.
    }
  }

  /**
   * A soft delete (issue 76): ask the repository the item's file lived in to
   * commit its removal. Routed by the source the ROW recorded, like a departure
   * — the item may have been filed under a topic that resolves elsewhere today.
   * Best-effort like `emitMirror`: the file is already gone and the index
   * already agrees; only the commit is outstanding, and the pending `delete`
   * outbox row is what records that.
   */
  async emitRemoved(actorId: string, page: PageView, from: MovedOutSource, path: string): Promise<void> {
    try {
      await this.mirror.afterItemRemoved?.(from, {
        itemId: page.id,
        path,
        actorId,
        versionToken: page.version_token,
      });
    } catch {
      // Best-effort: a mirror failure never fails the write.
    }
  }
}

export function toItem(page: PageView): ItemView {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    type: page.type,
    owner_id: page.owner_id,
    space_id: page.space_id,
    created_at: page.created_at,
    updated_at: page.updated_at,
    version_token: page.version_token,
    current_version_id: page.current_version_id,
    body_markdown: page.body_markdown,
    raw_markdown: page.raw_markdown,
    frontmatter: page.frontmatter,
    tags: tagsFromFrontmatter(page.frontmatter) ?? page.tags,
    categories: stringArrayFromFrontmatter(page.frontmatter, 'categories') ?? page.categories,
    groups: stringArrayFromFrontmatter(page.frontmatter, 'groups') ?? page.groups,
    review: page.review,
    source: page.source,
  };
}

export function normalizeCreateInput(input: CreateItemInput): CreatePageInput {
  const raw = input.raw_markdown ?? input.raw;
  if (raw !== undefined) {
    const parsed = parse(raw);
    const title = input.title ?? titleFromFrontmatter(parsed.frontmatter);
    if (!title) throw new BadRequestException('title is required when raw markdown frontmatter has no title');
    const status = normalizeStatus(input.status ?? statusFromFrontmatter(parsed.frontmatter));
    return {
      id: input.id,
      title,
      body: parsed.body,
      raw,
      frontmatter: { ...parsed.frontmatter, ...(input.frontmatter ?? {}) },
      status,
      tags: input.tags ?? tagsFromFrontmatter(parsed.frontmatter),
    };
  }

  if (!input.title) throw new BadRequestException('title is required');
  return {
    id: input.id,
    title: input.title,
    body: input.body ?? '',
    frontmatter: input.frontmatter,
    status: input.status,
    tags: input.tags,
  };
}

export function normalizeUpdateInput(input: UpdateItemInput): UpdatePageInput {
  const raw = input.raw_markdown ?? input.raw;
  if (raw !== undefined) {
    const parsed = parse(raw);
    const parsedFrontmatter = parsed.frontmatter as Record<string, unknown>;
    const frontmatter = { ...parsedFrontmatter, ...(input.frontmatter ?? {}) };
    return {
      raw,
      title: input.title ?? titleFromFrontmatter(frontmatter),
      frontmatter,
      status: input.status ?? statusFromFrontmatter(frontmatter),
      tags: input.tags ?? tagsFromFrontmatter(frontmatter),
    };
  }
  return {
    title: input.title,
    body: input.body,
    frontmatter: input.frontmatter,
    status: input.status,
    tags: input.tags,
  };
}

function titleFromFrontmatter(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter['title'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function statusFromFrontmatter(frontmatter: Record<string, unknown>): 'draft' | 'published' | undefined {
  return normalizeStatus(frontmatter['status']);
}

function normalizeStatus(value: unknown): 'draft' | 'published' | undefined {
  return value === 'draft' || value === 'published' ? value : undefined;
}

function tagsFromFrontmatter(frontmatter: Record<string, unknown>): string[] | undefined {
  return stringArrayFromFrontmatter(frontmatter, 'tags');
}

function stringArrayFromFrontmatter(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}
