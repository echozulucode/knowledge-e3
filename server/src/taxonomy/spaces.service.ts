import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database, SpaceVisibility } from '../db/schema.js';
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
  /** 'private' = not exposed to anonymous visitors. See SpacesTable.visibility. */
  visibility: SpaceVisibility;
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
  visibility?: SpaceVisibility;
}

export interface UpdateSpaceInput {
  name?: string;
  description?: string | null;
  visibility?: SpaceVisibility;
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

  /**
   * @param opts.anonymousViewer when true, private topics are omitted entirely.
   * A private topic's NAME and description are themselves not public — listing
   * them would advertise exactly what an admin marked as not-for-the-internet.
   */
  async list(opts: { anonymousViewer?: boolean } = {}): Promise<SpaceView[]> {
    let q = this.db.selectFrom('spaces').selectAll().where('archived_at', 'is', null);
    if (opts.anonymousViewer) q = q.where('visibility', '!=', 'private');
    return q.orderBy('slug', 'asc').execute();
  }

  async listWithCounts(opts: { anonymousViewer?: boolean } = {}): Promise<SpaceWithCountsView[]> {
    const anonymousViewer = Boolean(opts.anonymousViewer);
    let rowsQuery = this.db
      .selectFrom('spaces')
      // For anonymous callers the item count must reflect only what they can
      // see; otherwise the count itself reveals how much unpublished work exists.
      .leftJoin('pages', (join) => {
        const j = join.onRef('pages.space_id', '=', 'spaces.id').on('pages.deleted_at', 'is', null);
        return anonymousViewer ? j.on('pages.status', '=', 'published') : j;
      })
      .select(({ fn }) => [
        'spaces.id as id',
        'spaces.slug as slug',
        'spaces.name as name',
        'spaces.description as description',
        'spaces.created_at as created_at',
        'spaces.updated_at as updated_at',
        'spaces.archived_at as archived_at',
        'spaces.visibility as visibility',
        fn.count<number>('pages.id').as('items_count'),
      ])
      .where('spaces.archived_at', 'is', null);
    // A private topic's very existence is not public — omit it entirely.
    if (anonymousViewer) rowsQuery = rowsQuery.where('spaces.visibility', '!=', 'private');
    const rows = await rowsQuery
      .groupBy(['spaces.id', 'spaces.slug', 'spaces.name', 'spaces.description', 'spaces.created_at', 'spaces.updated_at', 'spaces.archived_at', 'spaces.visibility'])
      .orderBy('spaces.slug', 'asc')
      .execute();

    let statusesQuery = this.db
      .selectFrom('pages')
      .select(({ fn }) => ['space_id', 'status', fn.count<number>('id').as('count')])
      .where('deleted_at', 'is', null);
    if (anonymousViewer) statusesQuery = statusesQuery.where('status', '=', 'published');
    const statuses = await statusesQuery.groupBy(['space_id', 'status']).execute();
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
        visibility: row.visibility,
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
          // New topics are public by default — matching the column default and
          // the pre-existing behaviour (any published page was anonymously
          // readable on a public instance). Admins opt a topic out afterwards.
          visibility: input.visibility ?? 'public',
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
        visibility: input.visibility ?? existing.visibility,
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

  /**
   * Page ids an anonymous visitor may see: published, not deleted, and not in a
   * private topic. Used to scope derived vocabulary (tags/categories/groups) so
   * a label that exists ONLY inside private or unpublished content is not
   * advertised — the vocabulary leaks the shape of the content otherwise.
   *
   * Deliberately anonymous-only. Signed-in callers keep the existing counts
   * (which do include drafts and deleted pages); correcting those is a separate
   * change with its own blast radius, tracked in the wave plan.
   */
  private anonymousVisiblePages() {
    return this.db
      .selectFrom('pages')
      .leftJoin('spaces', 'spaces.id', 'pages.space_id')
      .select('pages.id')
      .where('pages.deleted_at', 'is', null)
      .where('pages.status', '=', 'published')
      .where((eb) =>
        eb.or([eb('pages.space_id', 'is', null), eb('spaces.visibility', '!=', 'private')]),
      );
  }

  async listTags(query?: string, opts: { anonymousViewer?: boolean } = {}): Promise<TaxonomyCountView[]> {
    let q = this.db
      .selectFrom('page_tags')
      .select(({ fn }) => ['tag as name', 'tag as slug', fn.count<number>('page_id').as('count')]);
    if (opts.anonymousViewer) {
      q = q.where('page_id', 'in', this.anonymousVisiblePages());
    }
    const rows = await q.groupBy('tag').orderBy('tag', 'asc').execute();
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

  async listCategories(query?: string, opts: { anonymousViewer?: boolean } = {}): Promise<TaxonomyCountView[]> {
    // The catalog (primary_categories) is admin-curated vocabulary, not derived
    // from page content, so it stays visible either way. Only USAGE is scoped:
    // a category used solely inside private/unpublished pages must not surface
    // through its usage row.
    let usageQuery = this.db
      .selectFrom('page_categories')
      .select(({ fn }) => ['category as name', 'category as slug', fn.count<number>('page_id').as('count')]);
    if (opts.anonymousViewer) {
      usageQuery = usageQuery.where('page_id', 'in', this.anonymousVisiblePages());
    }
    const [catalogRows, usageRows] = await Promise.all([
      this.db
        .selectFrom('primary_categories')
        .select(['slug', 'name'])
        .where('archived_at', 'is', null)
        .execute(),
      usageQuery.groupBy('category').orderBy('category', 'asc').execute(),
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

  async listGroups(q?: string, opts: { anonymousViewer?: boolean } = {}): Promise<TaxonomyCountView[]> {
    const anonymousViewer = Boolean(opts.anonymousViewer);
    let query = this.db
      .selectFrom('groups')
      // Count only pages the caller may see (anonymous), so the join itself is
      // narrowed rather than the outer WHERE — a plain WHERE would turn this
      // LEFT JOIN into an inner one and drop empty groups entirely.
      .leftJoin('page_groups', (join) => {
        const j = join.onRef('page_groups.group_id', '=', 'groups.id');
        return anonymousViewer
          ? j.on('page_groups.page_id', 'in', this.anonymousVisiblePages())
          : j;
      })
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
    // A group SCOPED to a private topic is itself private — its name would
    // otherwise advertise the topic it belongs to.
    if (anonymousViewer) {
      query = query.where((eb) =>
        eb.or([eb('groups.space_id', 'is', null), eb('spaces.visibility', '!=', 'private')]),
      );
    }
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
        visibility: 'public',
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


