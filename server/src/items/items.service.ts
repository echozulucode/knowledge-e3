import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { parse } from '@echozedlabs/codec';
import { PagesService, type CreatePageInput, type PageView, type ReadActor, type UpdatePageInput } from '../pages/pages.service.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';

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
}

export interface CreateItemInput {
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
  ) {}

  async create(actorId: string, input: CreateItemInput): Promise<ItemView> {
    const pageInput = normalizeCreateInput(input);
    const page = await this.pages.create(actorId, pageInput);
    await this.tryMirror(actorId, page);
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

  async update(actor: ReadActor, id: string, expectedVersion: number, input: UpdateItemInput): Promise<ItemView> {
    const pageInput = normalizeUpdateInput(input);
    const page = await this.pages.update(actor, id, expectedVersion, pageInput);
    await this.tryMirror(actor.id, page);
    return toItem(page);
  }

  /**
   * Re-emit every item in a space to the git mirror and flush — the "Sync now"
   * backfill. Covers content that predates a repo binding (the mirror only fires
   * on writes, so existing items need an explicit push). Returns the count.
   */
  async resyncSpace(spaceId: string): Promise<{ items: number }> {
    const pages = await this.pages.list({ space: spaceId, limit: 100_000 });
    for (const page of pages) {
      await this.tryMirror(page.owner_id ?? 'system', page);
    }
    await this.mirror.flush?.();
    return { items: pages.length };
  }

  private async tryMirror(actorId: string, page: PageView): Promise<void> {
    if (!page.current_version_id) return;
    try {
      await this.mirror.afterItemVersionPersisted({
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
      });
    } catch {
      // Storage mirrors are best-effort in the MVP; the database remains the source of truth.
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
  };
}

function normalizeCreateInput(input: CreateItemInput): CreatePageInput {
  const raw = input.raw_markdown ?? input.raw;
  if (raw !== undefined) {
    const parsed = parse(raw);
    const title = input.title ?? titleFromFrontmatter(parsed.frontmatter);
    if (!title) throw new BadRequestException('title is required when raw markdown frontmatter has no title');
    const status = normalizeStatus(input.status ?? statusFromFrontmatter(parsed.frontmatter));
    return {
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
    title: input.title,
    body: input.body ?? '',
    frontmatter: input.frontmatter,
    status: input.status,
    tags: input.tags,
  };
}

function normalizeUpdateInput(input: UpdateItemInput): UpdatePageInput {
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
