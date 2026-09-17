import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database, SpacePresentation, SpaceVisibility } from '../db/schema.js';
import { nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import { reindexPagesFtsWhere } from '../search/fts-index.js';

// Internal storage identifiers intentionally stay `space*`/`spaces` for the demo-scope
// terminology pass; user-facing copy and new API aliases call this concept Topic/Topics.
export const DEFAULT_SPACE_ID = 'space_default';
export const DEFAULT_SPACE_SLUG = 'default';

/** "1 item" / "15 items" — for the in-use refusals an admin reads verbatim. */
function pluralItems(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

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
  /** Landing-page presentation profile (plan §3.1). See SpacesTable.presentation. */
  presentation: SpacePresentation;
  landing_markdown: string | null;
  start_here: string | null;
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
  presentation?: SpacePresentation;
  landing_markdown?: string | null;
  start_here?: string | null;
}

export interface UpdateSpaceInput {
  name?: string;
  description?: string | null;
  visibility?: SpaceVisibility;
  presentation?: SpacePresentation;
  landing_markdown?: string | null;
  start_here?: string | null;
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

export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
  /**
   * Where the group is offered. Omit scope, space_id and space_slug together to
   * keep the current scope; `'global'` makes it available in all topics; a
   * space_id or space_slug narrows it to that topic.
   */
  scope?: 'global' | 'space';
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
  /** Groups only: the admin-written description. */
  description?: string | null;
  /** Archived catalog listings only (`GET /taxonomy/categories/archived`). */
  archived_at?: string | null;
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
        'spaces.presentation as presentation',
        'spaces.landing_markdown as landing_markdown',
        'spaces.start_here as start_here',
        fn.count<number>('pages.id').as('items_count'),
      ])
      .where('spaces.archived_at', 'is', null);
    // A private topic's very existence is not public — omit it entirely.
    if (anonymousViewer) rowsQuery = rowsQuery.where('spaces.visibility', '!=', 'private');
    const rows = await rowsQuery
      .groupBy(['spaces.id', 'spaces.slug', 'spaces.name', 'spaces.description', 'spaces.created_at', 'spaces.updated_at', 'spaces.archived_at', 'spaces.visibility', 'spaces.presentation', 'spaces.landing_markdown', 'spaces.start_here'])
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
        presentation: row.presentation,
        landing_markdown: row.landing_markdown,
        start_here: row.start_here,
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
          presentation: input.presentation ?? 'wiki',
          landing_markdown: input.landing_markdown ?? null,
          start_here: input.start_here ?? null,
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
    // The rename and the reindex commit together: Topic names are FTS text
    // (reader UX plan §5.4), so a renamed Topic must be findable by its new
    // name — and no longer by its old one — the moment the rename is visible.
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('spaces')
        .set({
          name: nextName,
          description: input.description !== undefined ? input.description : existing.description,
          visibility: input.visibility ?? existing.visibility,
          presentation: input.presentation ?? existing.presentation,
          landing_markdown: input.landing_markdown !== undefined ? input.landing_markdown : existing.landing_markdown,
          start_here: input.start_here !== undefined ? input.start_here : existing.start_here,
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .executeTakeFirst();
      if (nextName !== existing.name) await reindexPagesFtsWhere(tx, sql<boolean>`p.space_id = ${id}`);
    });
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

  /**
   * WHAT EXISTS: the curated catalog UNIONed with the categories pages actually
   * carry. Browse, the facets, and the taxonomy admin all want this — a legacy
   * item filed under a category nobody has curated yet must still be findable,
   * and the admin has to see the stray term before it can be curated or
   * retired.
   *
   * This is NOT the publishable vocabulary. Primary categories are CURATED, not
   * emergent (Eric, 2026-09-11 — issues 97/106): "what may I publish into" is
   * `listCuratedCategories` below, and the union here would silently re-admit
   * every stray term as publishable vocabulary. The two accessors look
   * mergeable and are not; keep them apart.
   */
  async listCategories(query?: string, opts: { anonymousViewer?: boolean } = {}): Promise<TaxonomyCountView[]> {
    // The catalog (primary_categories) is admin-curated vocabulary, not derived
    // from page content, so it stays visible either way. Only USAGE is scoped:
    // a category used solely inside private/unpublished pages must not surface
    // through its usage row.
    const [catalogRows, usageRows] = await Promise.all([
      this.categoryCatalogRows(),
      this.categoryUsageRows(opts).execute(),
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

  /**
   * WHAT MAY I PUBLISH INTO: the admin-curated `primary_categories` catalog
   * alone, archived rows excluded. Usage rows are deliberately NOT unioned in.
   *
   * Primary categories are curated, not emergent (Eric, 2026-09-11 — settles
   * issues 97 and 106). Under the union in `listCategories` the act of saving a
   * draft carrying `categories: [anything]` put `anything` into the vocabulary,
   * so by the time that same item was published the `category.unknown` lint
   * rule — an ERROR — had nothing left to fire on: it was unreachable on the
   * interactive path by construction. This accessor is what `lintContext` uses,
   * which is what makes the rule mean something again.
   *
   * An archived category is not publishable either: archiving is how an admin
   * retires a term, and re-admitting it here would make that a no-op for new
   * writes while still hiding it from the picker.
   *
   * Counts are the same usage counts `listCategories` reports (scoped for an
   * anonymous caller the same way), so the Publish drawer can show how much
   * lives under a term without a second round trip.
   */
  async listCuratedCategories(query?: string, opts: { anonymousViewer?: boolean } = {}): Promise<TaxonomyCountView[]> {
    const [catalogRows, usageRows] = await Promise.all([
      this.categoryCatalogRows(),
      this.categoryUsageRows(opts).execute(),
    ]);
    const counts = new Map(usageRows.map((row) => [row.slug, Number(row.count)]));
    const views = catalogRows.map((row) => ({
      id: `category_${slugify(row.slug)}`,
      name: row.name,
      slug: row.slug,
      count: counts.get(row.slug) ?? 0,
      color: null,
      icon: null,
      scope: { type: 'global' as const, space_id: null, space_slug: null },
    }));
    return this.filterTaxonomy(views.sort((a, b) => a.slug.localeCompare(b.slug)), query);
  }

  /** The catalog rows both category accessors start from. */
  private categoryCatalogRows() {
    return this.db
      .selectFrom('primary_categories')
      .select(['slug', 'name'])
      .where('archived_at', 'is', null)
      .execute();
  }

  /**
   * Usage counts per category. Scoped for an anonymous caller: a category used
   * only inside private or unpublished pages must not surface through its count.
   */
  private categoryUsageRows(opts: { anonymousViewer?: boolean }) {
    let q = this.db
      .selectFrom('page_categories')
      .select(({ fn }) => ['category as name', 'category as slug', fn.count<number>('page_id').as('count')]);
    if (opts.anonymousViewer) q = q.where('page_id', 'in', this.anonymousVisiblePages());
    return q.groupBy('category').orderBy('category', 'asc');
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
      // An archived row still owns its slug (archive is soft). Say so, so the
      // admin restores the old term instead of hunting for a duplicate that the
      // active list does not show.
      const archived = await this.db
        .selectFrom('primary_categories')
        .select('slug')
        .where('slug', '=', slug)
        .where('archived_at', 'is not', null)
        .executeTakeFirst();
      if (archived) throw new ConflictException('an archived primary category already uses this slug; restore it instead');
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
    // Category LABELS are FTS text (reader UX plan §5.4): relabel and reindex the
    // items filed under it in one transaction, so search follows the rename.
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('primary_categories').set({ name, updated_at: nowIso() }).where('slug', '=', slug).executeTakeFirst();
      if (name !== existing.name) {
        await reindexPagesFtsWhere(tx, sql<boolean>`EXISTS (SELECT 1 FROM page_categories pc WHERE pc.page_id = p.id AND pc.category = ${slug})`);
      }
    });
    return this.getCategoryView(slug);
  }

  /**
   * Retire a term from the curated catalog. Deliberately NOT refused while
   * items carry it: retiring a term that drafts still use is exactly how an
   * admin stops new publishes into it (publish-lint-gate.e2e pins this), and
   * items already filed under it keep it. The admin page is stricter — it
   * offers Archive only for unused terms, where Undo is a clean round trip.
   */
  async archiveCategory(slug: string): Promise<TaxonomyCountView> {
    const existing = await this.getCategoryCatalogRow(slug);
    if (!existing) throw new NotFoundException('primary category not found');
    await this.db.updateTable('primary_categories').set({ archived_at: nowIso(), updated_at: nowIso() }).where('slug', '=', slug).executeTakeFirst();
    return { id: `category_${slugify(slug)}`, name: existing.name, slug, count: await this.categoryUsageCount(slug), color: null, icon: null, scope: { type: 'global', space_id: null, space_slug: null } };
  }

  /** Archived catalog rows, newest archive first, for the admin's "Archived" filter and Restore. */
  async listArchivedCategories(): Promise<TaxonomyCountView[]> {
    const rows = await this.db
      .selectFrom('primary_categories')
      .select(['slug', 'name', 'archived_at'])
      .where('archived_at', 'is not', null)
      .orderBy('archived_at', 'desc')
      .orderBy('slug', 'asc')
      .execute();
    const usage = await this.categoryUsageRows({}).execute();
    const counts = new Map(usage.map((row) => [row.slug, Number(row.count)]));
    return rows.map((row) => ({
      id: `category_${slugify(row.slug)}`,
      name: row.name,
      slug: row.slug,
      count: counts.get(row.slug) ?? 0,
      color: null,
      icon: null,
      scope: { type: 'global', space_id: null, space_slug: null },
      archived_at: row.archived_at,
    }));
  }

  /**
   * Undo an archive: the term is curated (and publishable) again under its old
   * label. Archive is soft precisely so this is a one-row flip — nothing about
   * the items filed under the slug changed while it was archived.
   */
  async restoreCategory(slug: string): Promise<TaxonomyCountView> {
    const row = await this.db
      .selectFrom('primary_categories')
      .select(['slug', 'archived_at'])
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('primary category not found');
    if (!row.archived_at) throw new ConflictException('primary category is not archived');
    await this.db.updateTable('primary_categories').set({ archived_at: null, updated_at: nowIso() }).where('slug', '=', slug).executeTakeFirst();
    return this.getCategoryView(slug);
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
        'groups.description as description',
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
      .groupBy(['groups.id', 'groups.name', 'groups.slug', 'groups.description', 'groups.space_id', 'spaces.slug'])
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
      description: row.description,
    }));
  }

  /**
   * Edit a group's name, description and where it is offered. The slug and id
   * stay put: items reference the group by id (`page_groups`) and frontmatter
   * names it by slug, so neither may move under them.
   */
  async updateGroup(id: string, input: UpdateGroupInput): Promise<TaxonomyCountView> {
    const existing = await this.getActiveGroupRow(id);
    if (!existing) throw new NotFoundException('group not found');
    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) throw new BadRequestException('group name is required');
    const description = input.description !== undefined ? input.description?.trim() || null : existing.description;

    // Scope only changes when the request names it; a plain rename keeps it.
    let spaceId = existing.space_id;
    const namesScope = input.scope !== undefined || input.space_id !== undefined || input.space_slug !== undefined;
    if (namesScope) {
      const wantsGlobal = input.scope === 'global' || (!input.space_id?.trim() && !input.space_slug?.trim());
      if (wantsGlobal) {
        spaceId = null;
      } else {
        const space = await this.resolveSpace(input.space_id?.trim() || null, input.space_slug?.trim() || null);
        if (!space || space.archived_at) throw new NotFoundException('topic not found');
        spaceId = space.id;
      }
    }

    // Group NAMES are FTS text (reader UX plan §5.4), like topic names and
    // category labels: rename and reindex the items in the group together, so
    // search follows the new name the moment it is visible.
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('groups')
        .set({ name, description, space_id: spaceId, updated_at: nowIso() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (name !== existing.name) {
        await reindexPagesFtsWhere(tx, sql<boolean>`EXISTS (SELECT 1 FROM page_groups pg WHERE pg.page_id = p.id AND pg.group_id = ${id})`);
      }
    });
    return this.getGroupView(id);
  }

  /**
   * Soft-archive a group. Refused while items are in it, like archiving a
   * topic: the group list hides archived groups, so archiving one in use would
   * hide a group those items still carry. (Categories differ on purpose — see
   * `archiveCategory`: a retired category still gates publishing, a group
   * gates nothing.)
   */
  async archiveGroup(id: string): Promise<TaxonomyCountView> {
    const existing = await this.getActiveGroupRow(id);
    if (!existing) throw new NotFoundException('group not found');
    const view = await this.getGroupView(id);
    if (view.count > 0) throw new ConflictException(`group is in use by ${pluralItems(view.count)}`);
    await this.db.updateTable('groups').set({ archived_at: nowIso(), updated_at: nowIso() }).where('id', '=', id).executeTakeFirst();
    return view;
  }

  /**
   * Slugs of archived groups, for the lint's `group.archived` warning (issue
   * 117): frontmatter naming one still links the item to the archived row.
   */
  async listArchivedGroupSlugs(): Promise<string[]> {
    const rows = await this.db.selectFrom('groups').select('slug').where('archived_at', 'is not', null).orderBy('slug').execute();
    return rows.map((row) => row.slug);
  }

  private async getActiveGroupRow(id: string) {
    const row = await this.db
      .selectFrom('groups')
      .select(['id', 'name', 'description', 'space_id'])
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row ?? null;
  }

  private async getGroupView(id: string): Promise<TaxonomyCountView> {
    const row = await this.db
      .selectFrom('groups')
      .leftJoin('spaces', 'spaces.id', 'groups.space_id')
      .select(['groups.id as id', 'groups.name as name', 'groups.slug as slug', 'groups.description as description', 'groups.space_id as space_id', 'spaces.slug as space_slug'])
      .where('groups.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('group not found');
    const usage = await this.db
      .selectFrom('page_groups')
      .select(({ fn }) => fn.count<number>('page_id').as('count'))
      .where('group_id', '=', id)
      .executeTakeFirst();
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      count: Number(usage?.count ?? 0),
      color: null,
      icon: null,
      scope: { type: row.space_id ? 'space' : 'global', space_id: row.space_id, space_slug: row.space_slug },
      description: row.description,
    };
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
        presentation: 'wiki',
        landing_markdown: null,
        start_here: null,
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

  /** Resolve an unarchived topic by id or slug (the reference form the read APIs accept). */
  async getByRef(ref: string): Promise<SpaceView | null> {
    const row = await this.db
      .selectFrom('spaces')
      .selectAll()
      .where((eb) => eb.or([eb('id', '=', ref), eb('slug', '=', ref)]))
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Public so a caller can read a topic's OUTGOING state before writing over it
   * — `TaxonomyController.updateTopic` needs the previous `visibility` to audit
   * the change with a before and an after, the way `config.read_access_change`
   * does for the instance-wide toggle.
   */
  async getById(id: string): Promise<SpaceView | null> {
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


