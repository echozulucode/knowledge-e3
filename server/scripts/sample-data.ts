/**
 * Sample-data toolkit: generate a large, deterministic taxonomy + content
 * dataset, reset (empty) the database content, and import a dataset.
 *
 * Used by the thin CLI wrappers:
 *   - generate-sample-dataset.ts  -> writes data/sample-dataset.json
 *   - reset-data.ts               -> empties all content + taxonomy
 *   - import-sample-dataset.ts    -> imports a dataset (optionally --reset first)
 *
 * The insert path mirrors src/seed.ts (pages + page_versions + taxonomy + FTS +
 * links), so generated content behaves exactly like app-created content.
 */
import { Kysely, sql } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import type { Database } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';
import { newId, nowIso } from '../src/common/ids.js';
import { slugify } from '../src/common/slug.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from '../src/pages/taxonomy.js';

export const DEFAULT_SPACE_ID = 'space_default';

export interface SampleTopic {
  name: string;
  slug: string;
  description: string;
}
export interface SampleCategory {
  name: string;
  slug: string;
}
export interface SampleGroup {
  name: string;
  slug: string;
  description: string;
}
export interface SampleItem {
  title: string;
  status: 'draft' | 'published';
  body: string;
  topic: string; // topic name
  categories: string[]; // category slugs
  groups: string[]; // group slugs
  tags: string[];
}
export interface SampleDataset {
  generatedAt: string;
  counts: { topics: number; categories: number; groups: number; items: number };
  topics: SampleTopic[];
  categories: SampleCategory[];
  groups: SampleGroup[];
  items: SampleItem[];
}

export interface DatasetCounts {
  topics: number;
  categories: number;
  groups: number;
  items: number;
  seed: number;
}

export const DEFAULT_COUNTS: DatasetCounts = {
  topics: 60,
  categories: 50,
  groups: 40,
  items: 750,
  seed: 42,
};

// ---- deterministic RNG ------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- word pools -------------------------------------------------------------

const TOPIC_ADJ = [
  'Platform', 'Cloud', 'Data', 'Mobile', 'Frontend', 'Backend', 'Distributed', 'Security',
  'Customer', 'Product', 'Developer', 'Machine Learning', 'Realtime', 'Edge', 'Internal',
  'Payments', 'Identity', 'Search', 'Growth', 'Billing', 'Messaging', 'Analytics', 'Content',
];
const TOPIC_NOUN = [
  'Engineering', 'Operations', 'Infrastructure', 'Experience', 'Architecture', 'Reliability',
  'Analytics', 'Tooling', 'Systems', 'Research', 'Strategy', 'Enablement', 'Success', 'Insights',
  'Platform', 'Services', 'Workflows', 'Quality', 'Design', 'Governance',
];
const CATEGORY_NAMES = [
  'Runbook', 'Decision Record', 'How-to Guide', 'Reference', 'Postmortem', 'Meeting Notes',
  'Design Doc', 'Research Note', 'Tutorial', 'Checklist', 'Specification', 'Retrospective',
  'FAQ', 'Glossary', 'Onboarding', 'Troubleshooting', 'Release Note', 'Architecture Decision',
  'Incident Report', 'Standard', 'Policy', 'Proposal', 'Brief', 'Playbook', 'Template',
  'Benchmark', 'Migration Plan', 'Roadmap', 'Changelog', 'Style Guide',
];
const GROUP_BASE = [
  'Platform Team', 'SRE', 'Data Guild', 'Frontend Guild', 'Security Council', 'Onboarding Crew',
  'Release Captains', 'Docs Working Group', 'API Council', 'Mobile Squad', 'Growth Pod',
  'Quality Circle', 'Architecture Board', 'Incident Commanders', 'Design Systems', 'ML Working Group',
];
const TAG_POOL = [
  'draft', 'review', 'approved', 'urgent', 'q1', 'q2', 'q3', 'q4', 'backend', 'frontend',
  'infra', 'security', 'performance', 'ux', 'api', 'mobile', 'data', 'ml', 'ops', 'docs',
  'incident', 'experiment', 'decision', 'reference', 'how-to', 'planning', 'customer', 'internal',
];

function uniqueNames(pool: string[], qualifiers: string[], count: number, rng: () => number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // First pass: raw pool entries.
  for (const base of pool) {
    if (out.length >= count) break;
    if (!seen.has(base)) {
      seen.add(base);
      out.push(base);
    }
  }
  // Then combine with qualifiers for more unique names.
  let guard = 0;
  while (out.length < count && guard < count * 50) {
    guard += 1;
    const base = pool[Math.floor(rng() * pool.length)]!;
    const q = qualifiers[Math.floor(rng() * qualifiers.length)]!;
    const name = `${q} ${base}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  // Final fallback: numbered suffix.
  let n = 2;
  while (out.length < count) {
    const name = `${pool[out.length % pool.length]} ${n}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    n += 1;
  }
  return out.slice(0, count);
}

function topicNames(count: number, rng: () => number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 200) {
    guard += 1;
    const adj = TOPIC_ADJ[Math.floor(rng() * TOPIC_ADJ.length)]!;
    const noun = TOPIC_NOUN[Math.floor(rng() * TOPIC_NOUN.length)]!;
    const name = `${adj} ${noun}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  let n = 2;
  while (out.length < count) {
    const name = `${TOPIC_ADJ[out.length % TOPIC_ADJ.length]} Domain ${n}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    n += 1;
  }
  return out;
}

// ---- generation -------------------------------------------------------------

export function generateDataset(counts: DatasetCounts): SampleDataset {
  const rng = mulberry32(counts.seed);

  const topics: SampleTopic[] = topicNames(counts.topics, rng).map((name) => ({
    name,
    slug: slugify(name),
    description: `${name} knowledge: notes, decisions, and references for the ${name.toLowerCase()} area.`,
  }));

  const categories: SampleCategory[] = uniqueNames(CATEGORY_NAMES, ['Internal', 'Team', 'Public', 'Draft'], counts.categories, rng).map((name) => ({
    name,
    slug: slugify(name),
  }));

  const groups: SampleGroup[] = uniqueNames(GROUP_BASE, ['Core', 'Extended', 'Alpha', 'Beta'], counts.groups, rng).map((name) => ({
    name,
    slug: slugify(name),
    description: `${name} working group.`,
  }));

  const items: SampleItem[] = [];
  for (let i = 0; i < counts.items; i++) {
    const topic = topics[i % topics.length]!;
    const category = categories[(i * 7 + 3) % categories.length]!;
    const category2 = categories[(i * 13 + 5) % categories.length]!;
    const group = groups[(i * 3 + 1) % groups.length]!;
    const tagCount = 2 + Math.floor(rng() * 3);
    const tags = Array.from({ length: tagCount }, () => TAG_POOL[Math.floor(rng() * TAG_POOL.length)]!);
    tags.push(topic.slug);
    const seq = String(i + 1).padStart(4, '0');
    const title = `${topic.name} ${category.name} ${seq}`;
    const status: 'draft' | 'published' = i % 6 === 0 ? 'draft' : 'published';
    const body = [
      `# ${title}`,
      '',
      `Sample content for **${topic.name}**, categorized as _${category.name}_.`,
      '',
      `- Topic: ${topic.name}`,
      `- Category: ${category.name}`,
      `- Group: ${group.name}`,
      `- Tags: ${[...new Set(tags)].join(', ')}`,
      '',
      `This deterministic record (#${i + 1} of ${counts.items}) exists to exercise topic and category navigation, filtering, counts, and search at scale.`,
    ].join('\n');

    items.push({
      title,
      status,
      body,
      topic: topic.name,
      categories: [...new Set([category.slug, category2.slug])],
      groups: [group.slug],
      tags: [...new Set(tags)],
    });
  }

  return {
    generatedAt: nowIso(),
    counts: { topics: topics.length, categories: categories.length, groups: groups.length, items: items.length },
    topics,
    categories,
    groups,
    items,
  };
}

// ---- reset ------------------------------------------------------------------

/**
 * Empty all content and taxonomy. Keeps the `users` and `sessions` tables (so
 * the admin stays signed in) and the built-in default topic. Deletes are in
 * child -> parent order because foreign keys are enforced.
 */
export async function resetContent(db: Kysely<Database>): Promise<void> {
  await sql`DELETE FROM pages_fts`.execute(db);
  const tables = [
    'page_groups',
    'page_categories',
    'page_tags',
    'page_views',
    'item_links',
    'wikilinks',
    'revision_mirror_state',
    'page_versions',
    'audit_log',
    'bug_reports',
    'pages',
    'groups',
    'primary_categories',
  ] as const;
  for (const table of tables) {
    await db.deleteFrom(table).execute();
  }
  // Keep the default topic; drop everything else.
  await db.deleteFrom('spaces').where('id', '!=', DEFAULT_SPACE_ID).execute();
  await ensureDefaultSpace(db);
}

async function ensureDefaultSpace(db: Kysely<Database>): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('spaces')
    .values({
      id: DEFAULT_SPACE_ID,
      slug: 'default',
      name: 'Default',
      description: 'Default local knowledge topic',
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

// ---- admin ------------------------------------------------------------------

export async function ensureAdmin(db: Kysely<Database>): Promise<string> {
  const username = process.env['SEED_ADMIN_USERNAME'] ?? 'admin';
  const email = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@local';
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'admin-dev-password';

  const existing = await db.selectFrom('users').select(['id']).where('username', '=', username).executeTakeFirst();
  if (existing) return existing.id;

  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      email,
      username,
      password_hash: await hashPassword(password),
      role: 'admin',
      created_at: nowIso(),
      deleted_at: null,
    })
    .execute();
  // eslint-disable-next-line no-console
  console.log(`[sample-data] created admin '${username}'.`);
  return id;
}

// ---- import -----------------------------------------------------------------

export async function importDataset(
  db: Kysely<Database>,
  ownerId: string,
  dataset: SampleDataset,
): Promise<{ topics: number; categories: number; groups: number; items: number }> {
  const now = nowIso();

  for (const topic of dataset.topics) {
    await db
      .insertInto('spaces')
      .values({
        id: `space_${topic.slug}`,
        slug: topic.slug,
        name: topic.name,
        description: topic.description,
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: topic.name, description: topic.description, updated_at: now }))
      .execute();
  }

  for (const category of dataset.categories) {
    await db
      .insertInto('primary_categories')
      .values({ slug: category.slug, name: category.name, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: category.name, updated_at: now }))
      .execute();
  }

  // Groups are global (id `group_<slug>`) so item frontmatter `groups: [slug]`
  // resolves to the same row via syncTaxonomyInTx.
  for (const group of dataset.groups) {
    await db
      .insertInto('groups')
      .values({
        id: `group_${group.slug}`,
        slug: group.slug,
        name: group.name,
        description: group.description,
        space_id: null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: group.name, description: group.description, updated_at: now }))
      .execute();
  }

  let itemsCreated = 0;
  for (const item of dataset.items) {
    const existing = await db
      .selectFrom('pages')
      .select('id')
      .where('title', '=', item.title)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing) continue;

    const id = newId();
    const versionId = newId();
    const slug = await findFreeSlug(db, slugify(item.title));
    const frontmatter = {
      title: item.title,
      status: item.status,
      topic: item.topic,
      categories: item.categories,
      groups: item.groups,
      tags: item.tags,
    };
    const raw = markdownWithFrontmatter(frontmatter, item.body);
    const parsed = parse(raw);
    const topicSlug = slugify(item.topic);
    const space = await db.selectFrom('spaces').select('id').where('slug', '=', topicSlug).executeTakeFirst();
    const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, item.tags);

    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('pages')
        .values({
          id,
          slug,
          title: item.title,
          status: item.status,
          owner_id: ownerId,
          space_id: space?.id ?? DEFAULT_SPACE_ID,
          created_at: now,
          updated_at: now,
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
          created_by: ownerId,
          parent_version_id: null,
        })
        .execute();

      await syncTaxonomyInTx(tx, id, taxonomy);

      const links = extractItemLinks(parsed);
      if (links.length) {
        await tx
          .insertInto('item_links')
          .values(links.map((link) => ({ source_page_id: id, target_ref: link.target, link_type: link.type, link_text: link.text, position: link.start })))
          .execute();
      }

      await sql`DELETE FROM pages_fts WHERE page_id = ${id}`.execute(tx);
      await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${id}, ${item.title}, ${parsed.body}, ${taxonomy.tags.join(' ')})`.execute(tx);
    });
    itemsCreated += 1;
  }

  return { topics: dataset.topics.length, categories: dataset.categories.length, groups: dataset.groups.length, items: itemsCreated };
}

async function findFreeSlug(db: Kysely<Database>, base: string): Promise<string> {
  let candidate = base || 'item';
  let n = 2;
  while (n < 10000) {
    const taken = await db.selectFrom('pages').select('id').where('slug', '=', candidate).executeTakeFirst();
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
  return `${base}-${newId()}`;
}

function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)
    .join('\n');
  return `---\n${yaml}\n---\n${body}\n`;
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => formatYamlValue(entry)).join(', ')}]`;
  if (typeof value === 'string') {
    if (/^[\w\-./@:+]+$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/^-?\d/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}
