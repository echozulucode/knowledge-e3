import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';

// Internal storage identifiers intentionally stay `space*`/`spaces` for the demo-scope
// terminology pass; user-facing copy and new API aliases call this concept Topic/Topics.
export const DEFAULT_SPACE_ID = 'space_default';
export const DEFAULT_SPACE_SLUG = 'default';

export interface SpaceView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SpaceWithCountsView extends SpaceView {
  color: string | null;
  icon: string | null;
  counts: {
    items: number;
    published: number;
    draft: number;
  };
}

export interface CreateSpaceInput {
  slug?: string;
  name: string;
  description?: string | null;
}

export interface UpdateSpaceInput {
  name?: string;
  description?: string | null;
}

export interface CreatePrimaryCategoryInput {
  slug?: string;
  name: string;
}

export interface UpdatePrimaryCategoryInput {
  name?: string;
}

export interface CreateGroupInput {
  slug?: string;
  name: string;
  description?: string | null;
  scope?: string;
  space_id?: string | null;
  space_slug?: string | null;
}

export interface TaxonomyCountView {
  id: string;
  name: string;
  slug: string;
  count: number;
  color: string | null;
  icon: string | null;
  scope: {
    type: 'global' | 'space';
    space_id: string | null;
    space_slug: string | null;
  };
}

@Injectable()
export class SpacesService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async list(): Promise<SpaceView[]> {
    return this.db
      .selectFrom('spaces')
      .selectAll()
      .where('archived_at', 'is', null)
      .orderBy('slug', 'asc')
      .execute();
  }

  async listWithCounts(): Promise<SpaceWithCountsView[]> {
    const rows = await this.db
      .selectFrom('spaces')
      .leftJoin('pages', (join) => join.onRef('pages.space_id', '=', 'spaces.id').on('pages.deleted_at', 'is', null))
      .select(({ fn }) => [
        'spaces.id as id',
        'spaces.slug as slug',
        'spaces.name as name',
        'spaces.description as description',
        'spaces.created_at as created_at',
        'spaces.updated_at as updated_at',
        'spaces.archived_at as archived_at',
        fn.count<number>('pages.id').as('items_count'),
      ])
      .where('spaces.archived_at', 'is', null)
      .groupBy(['spaces.id', 'spaces.slug', 'spaces.name', 'spaces.description', 'spaces.created_at', 'spaces.updated_at', 'spaces.archived_at'])
      .orderBy('spaces.slug', 'asc')
      .execute();

    const statuses = await this.db
      .selectFrom('pages')
      .select(({ fn }) => ['space_id', 'status', fn.count<number>('id').as('count')])
      .where('deleted_at', 'is', null)
      .groupBy(['space_id', 'status'])
      .execute();
    const statusCounts = new Map<string, { published: number; draft: number }>();
    for (const row of statuses) {
      const key = row.space_id ?? '';
      const current = statusCounts.get(key) ?? { published: 0, draft: 0 };
      current[row.status] = Number(row.count);
      statusCounts.set(key, current);
    }

    return rows.map((row) => {
      const counts = statusCounts.get(row.id) ?? { published: 0, draft: 0 };
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
        color: null,
        icon: null,
        counts: { items: Number(row.items_count), published: counts.published, draft: counts.draft },
      };
    });
  }

  async create(input: CreateSpaceInput): Promise<SpaceView> {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('topic name is required');
    const slug = slugify(input.slug?.trim() || name);
    if (!slug) throw new BadRequestException('topic slug is required');
    const now = nowIso();
    const id = `space_${slug}`;

    try {
      await this.db
        .insertInto('spaces')
        .values({
          id,
          slug,
          name,
          description: input.description ?? null,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })
        .execute();
    } catch (err) {
      throw new ConflictException('topic slug already exists');
    }

    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateSpaceInput): Promise<SpaceView> {
    const existing = await this.getById(id);
    if (!existing || existing.archived_at) throw new NotFoundException('topic not found');
    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    if (!nextName) throw new BadRequestException('topic name is required');
    await this.db
      .updateTable('spaces')
      .set({
        name: nextName,
        description: input.description !== undefined ? input.description : existing.description,
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return (await this.getById(id))!;
  }

  async archive(id: string): Promise<SpaceView> {
    if (id === DEFAULT_SPACE_ID) throw new ConflictException('default topic cannot be archived');
    const existing = await this.getById(id);
    if (!existing || existing.archived_at) throw new NotFoundException('topic not found');
    const count = await this.db
      .selectFrom('pages')
      .select(({ fn }) => fn.count<number>('id').as('count'))
      .where('space_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(count?.count ?? 0) > 0) throw new ConflictException('topic has assigned items');
    await this.db.updateTable('spaces').set({ archived_at: nowIso(), updated_at: nowIso() }).where('id', '=', id).executeTakeFirst();
    return (await this.getById(id))!;
  }

  async listTags(query?: string): Promise<TaxonomyCountView[]> {
    const rows = await this.db
      .selectFrom('page_tags')
      .select(({ fn }) => ['tag as name', 'tag as slug', fn.count<number>('page_id').as('count')])
      .groupBy('tag')
      .orderBy('tag', 'asc')
      .execute();
    return this.filterTaxonomy(rows.map((row) => ({
      id: `tag_${slugify(row.slug)}`,
      name: row.name,
      slug: row.slug,
      count: Number(row.count),
      color: null,
      icon: null,
      scope: { type: 'global', space_id: null, space_slug: null },
    })), query);
  }

  async listCategories(query?: string): Promise<TaxonomyCountView[]> {
    const [catalogRows, usageRows] = await Promise.all([
      this.db
        .selectFrom('primary_categories')
        .select(['slug', 'name'])
        .where('archived_at', 'is', null)
        .execute(),
      this.db
        .selectFrom('page_categories')
        .select(({ fn }) => ['category as name', 'category as slug', fn.count<number>('page_id').as('count')])
        .groupBy('category')
        .orderBy('category', 'asc')
        .execute(),
    ]);
    const categories = new Map<string, TaxonomyCountView>();
    for (const row of catalogRows) {
      categories.set(row.slug, {
        id: `category_${slugify(row.slug)}`,
        name: row.name,
        slug: row.slug,
        count: 0,
        color: null,
        icon: null,
        scope: { type: 'global', space_id: null, space_slug: null },
      });
    }
    for (const row of usageRows) {
      const existing = categories.get(row.slug);
      categories.set(row.slug, {
        id: `category_${slugify(row.slug)}`,
        name: existing?.name ?? row.name,
        slug: row.slug,
        count: Number(row.count),
        color: existing?.color ?? null,
        icon: existing?.icon ?? null,
        scope: { type: 'global', space_id: null, space_slug: null },
      });
    }
    return this.filterTaxonomy(Array.from(categories.values()).sort((a, b) => a.slug.localeCompare(b.slug)), query);
  }

  async createCategory(input: CreatePrimaryCategoryInput): Promise<TaxonomyCountView> {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('primary category name is required');
    const slug = slugify(input.slug?.trim() || name);
    if (!slug) throw new BadRequestException('primary category slug is required');
    const now = nowIso();

    try {
      await this.db
        .insertInto('primary_categories')
        .values({ slug, name, created_at: now, updated_at: now, archived_at: null })
        .execute();
    } catch (err) {
      throw new ConflictException('primary category slug already exists');
    }

    return {
      id: `category_${slug}`,
      name,
      slug,
      count: 0,
      color: null,
      icon: null,
      scope: { type: 'global', space_id: null, space_slug: null },
    };
  }

  async updateCategory(slug: string, input: UpdatePrimaryCategoryInput): Promise<TaxonomyCountView> {
    const existing = await this.getCategoryCatalogRow(slug);
    if (!existing) throw new NotFoundException('primary category not found');
    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) throw new BadRequestException('primary category name is required');
    await this.db.updateTable('primary_categories').set({ name, updated_at: nowIso() }).where('slug', '=', slug).executeTakeFirst();
    return this.getCategoryView(slug);
  }

  async archiveCategory(slug: string): Promise<TaxonomyCountView> {
    const existing = await this.getCategoryCatalogRow(slug);
    if (!existing) throw new NotFoundException('primary category not found');
    await this.db.updateTable('primary_categories').set({ archived_at: nowIso(), updated_at: nowIso() }).where('slug', '=', slug).executeTakeFirst();
    return { id: `category_${slugify(slug)}`, name: existing.name, slug, count: await this.categoryUsageCount(slug), color: null, icon: null, scope: { type: 'global', space_id: null, space_slug: null } };
  }

  async listGroups(q?: string): Promise<TaxonomyCountView[]> {
    let query = this.db
      .selectFrom('groups')
      .leftJoin('page_groups', 'page_groups.group_id', 'groups.id')
      .leftJoin('spaces', 'spaces.id', 'groups.space_id')
      .select(({ fn }) => [
        'groups.id as id',
        'groups.name as name',
        'groups.slug as slug',
        'groups.space_id as space_id',
        'spaces.slug as space_slug',
        fn.count<number>('page_groups.page_id').as('count'),
      ])
      .where('groups.archived_at', 'is', null);
    if (q?.trim()) {
      const term = `%${q.trim()}%`;
      query = query.where((eb) =>
        eb.or([
          eb('groups.slug', 'like', term),
          eb('groups.name', 'like', term),
          eb('spaces.slug', 'like', term),
          eb('spaces.name', 'like', term),
        ]),
      );
    }
    const rows = await query
      .groupBy(['groups.id', 'groups.name', 'groups.slug', 'groups.space_id', 'spaces.slug'])
      .orderBy('groups.slug', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      count: Number(row.count),
      color: null,
      icon: null,
      scope: { type: row.space_id ? 'space' : 'global', space_id: row.space_id, space_slug: row.space_slug },
    }));
  }

  async createGroup(input: CreateGroupInput): Promise<TaxonomyCountView> {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('group name is required');
    const slug = slugify(input.slug?.trim() || name);
    if (!slug) throw new BadRequestException('group slug is required');
    const wantsGlobal = input.scope === 'global' || (!input.space_id?.trim() && !input.space_slug?.trim());
    const space = wantsGlobal ? null : await this.resolveSpace(input.space_id?.trim() || null, input.space_slug?.trim() || null);
    if (!wantsGlobal && (!space || space.archived_at)) throw new NotFoundException('topic not found');
    const spaceId = space?.id ?? null;
    const spaceSlug = space?.slug ?? null;
    const now = nowIso();
    const id = spaceId ? `group_${slugify(spaceId.replace(/^space_/, ''))}_${slug}` : `group_${slug}`;
    try {
      await this.db
        .insertInto('groups')
        .values({ id, slug, name, description: input.description ?? null, space_id: spaceId, created_at: now, updated_at: now, archived_at: null })
        .execute();
    } catch {
      throw new ConflictException('group slug already exists');
    }
    return { id, name, slug, count: 0, color: null, icon: null, scope: { type: spaceId ? 'space' : 'global', space_id: spaceId, space_slug: spaceSlug } };
  }

  async getDefaultSpace(): Promise<SpaceView> {
    const existing = await this.getById(DEFAULT_SPACE_ID);
    if (existing) return existing;
    const now = nowIso();
    await this.db
      .insertInto('spaces')
      .values({
        id: DEFAULT_SPACE_ID,
        slug: DEFAULT_SPACE_SLUG,
        name: 'Default',
        description: 'Default local knowledge topic',
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return (await this.getById(DEFAULT_SPACE_ID))!;
  }

  private async getCategoryCatalogRow(slug: string): Promise<{ slug: string; name: string } | null> {
    const row = await this.db
      .selectFrom('primary_categories')
      .select(['slug', 'name'])
      .where('slug', '=', slug)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row ?? null;
  }

  private async categoryUsageCount(slug: string): Promise<number> {
    const row = await this.db
      .selectFrom('page_categories')
      .select(({ fn }) => fn.count<number>('page_id').as('count'))
      .where('category', '=', slug)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  private async getCategoryView(slug: string): Promise<TaxonomyCountView> {
    const existing = await this.getCategoryCatalogRow(slug);
    if (!existing) throw new NotFoundException('primary category not found');
    return {
      id: `category_${slugify(slug)}`,
      name: existing.name,
      slug: existing.slug,
      count: await this.categoryUsageCount(slug),
      color: null,
      icon: null,
      scope: { type: 'global', space_id: null, space_slug: null },
    };
  }

  private async getById(id: string): Promise<SpaceView | null> {
    const row = await this.db.selectFrom('spaces').selectAll().where('id', '=', id).executeTakeFirst();
    return row ?? null;
  }

  private async resolveSpace(id: string | null, slug: string | null): Promise<SpaceView | null> {
    if (id) return this.getById(id);
    if (!slug) return null;
    const row = await this.db.selectFrom('spaces').selectAll().where('slug', '=', slug).where('archived_at', 'is', null).executeTakeFirst();
    return row ?? null;
  }

  private filterTaxonomy(values: TaxonomyCountView[], query?: string): TaxonomyCountView[] {
    const q = query?.trim().toLowerCase();
    if (!q) return values;
    return values.filter((value) =>
      value.name.toLowerCase().includes(q) ||
      value.slug.toLowerCase().includes(q) ||
      Boolean(value.scope.space_slug?.toLowerCase().includes(q)),
    );
  }
}


