import { BadRequestException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';

export interface ExtractedTaxonomy {
  tags: string[];
  categories: string[];
  groups: string[];
}

export function taxonomyFromFrontmatter(
  frontmatter: Record<string, unknown>,
  explicitTags?: string[],
): ExtractedTaxonomy {
  return {
    tags: normalizeStringArray(explicitTags ?? frontmatter['tags'], 'tags'),
    categories: normalizeStringArray(frontmatter['categories'], 'categories'),
    groups: normalizeStringArray(frontmatter['groups'], 'groups'),
  };
}

export async function syncTaxonomyInTx(
  db: Kysely<Database>,
  pageId: string,
  taxonomy: ExtractedTaxonomy,
): Promise<void> {
  await db.deleteFrom('page_tags').where('page_id', '=', pageId).execute();
  if (taxonomy.tags.length) {
    await db
      .insertInto('page_tags')
      .values(taxonomy.tags.map((tag) => ({ page_id: pageId, tag })))
      .execute();
  }

  await db.deleteFrom('page_categories').where('page_id', '=', pageId).execute();
  if (taxonomy.categories.length) {
    await db
      .insertInto('page_categories')
      .values(taxonomy.categories.map((category) => ({ page_id: pageId, category })))
      .execute();
  }

  await db.deleteFrom('page_groups').where('page_id', '=', pageId).execute();
  for (const group of taxonomy.groups) {
    const slug = slugify(group);
    if (!slug) continue;
    const groupId = await resolveGroupId(db, slug, group);
    // Two spellings of one slug (`Lab Operators`, `lab-operators`) are one link.
    await db
      .insertInto('page_groups')
      .values({ page_id: pageId, group_id: groupId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/**
 * The id of the group that owns `slug`, creating it only when no row does
 * (issue 117). Frontmatter names a group by slug, and the slug is unique across
 * the instance, but the id is not derivable from it: a group an admin created
 * for one topic is `group_<topic>_<slug>` (`SpacesService.createGroup`). So the
 * link takes whatever id the existing row has — archived or not, whatever topic
 * it is available in. An archived group is linked, NOT restored: archiving is
 * the admin's decision, and the lint reports the item naming it
 * (`group.archived`, a warning) instead of this write silently undoing it.
 *
 * A new row keeps the id format frontmatter-born groups have always had.
 */
export async function resolveGroupId(db: Kysely<Database>, slug: string, name: string): Promise<string> {
  const existing = await db.selectFrom('groups').select('id').where('slug', '=', slug).executeTakeFirst();
  if (existing) return existing.id;
  const now = nowIso();
  await db
    .insertInto('groups')
    .values({
      id: `group_${slug}`,
      slug,
      name,
      description: null,
      space_id: 'space_default',
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const row = await db.selectFrom('groups').select('id').where('slug', '=', slug).executeTakeFirstOrThrow();
  return row.id;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new BadRequestException(`invalid taxonomy: ${field} must be a list of strings`);
  }
  if (Array.isArray(value) && value.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestException(`invalid taxonomy: ${field} must be a list of strings`);
  }
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))).sort();
}
