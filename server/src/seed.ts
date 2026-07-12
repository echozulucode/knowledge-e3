/**
 * Bootstrap deterministic local/demo data.
 *
 * Idempotent: re-running is a no-op for rows that already exist. The exported
 * FIRST_MVP_* fixtures are consumed by first-MVP smoke tests so the UI and MCP
 * paths exercise the same human-readable corpus.
 *
 *   $ DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server seed
 */
import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kysely, sql } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import { makeKysely } from './db/db.module.js';
import { migrateSqlite } from './db/migrations.js';
import { hashPassword } from './auth/password.js';
import { newId, nowIso } from './common/ids.js';
import { slugify } from './common/slug.js';
import type { Database } from './db/schema.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from './pages/taxonomy.js';

export const FIRST_MVP_SEED_SPACES = [
  { slug: 'product', name: 'Product', description: 'First-MVP human product workspace.' },
  { slug: 'agent-notes', name: 'Agent Notes', description: 'First-MVP agent-created drafts and observations.' },
  { slug: 'product-workspace', name: 'Product workspace', description: 'Product planning, packaging, and customer-facing decisions.' },
  { slug: 'research', name: 'Research', description: 'Market, technical, and evidence-gathering notes.' },
  { slug: 'implementation', name: 'Implementation', description: 'Build notes, engineering plans, and delivery details.' },
  { slug: 'operations', name: 'Operations', description: 'Runbooks, maintenance, and recurring workflow notes.' },
  { slug: 'customer-insights', name: 'Customer Insights', description: 'Interview notes, pain points, and user feedback synthesis.' },
  { slug: 'architecture', name: 'Architecture', description: 'System design decisions, tradeoffs, and diagrams.' },
  { slug: 'release-planning', name: 'Release Planning', description: 'Milestones, release readiness, and launch checklists.' },
  { slug: 'personal-knowledge', name: 'Personal Knowledge', description: 'Reusable learning notes and reference material.' },
  { slug: 'automation', name: 'Automation', description: 'Scripts, repeatable workflows, and hands-off task patterns.' },
  { slug: 'integrations', name: 'Integrations', description: 'External services, APIs, and connector-specific notes.' },
  { slug: 'data-modeling', name: 'Data Modeling', description: 'Schemas, metadata conventions, and information architecture.' },
  { slug: 'quality-assurance', name: 'Quality Assurance', description: 'Test plans, validation evidence, and regression coverage.' },
  { slug: 'security-privacy', name: 'Security & Privacy', description: 'Access control, threat notes, and sensitive-data handling.' },
  { slug: 'performance', name: 'Performance', description: 'Latency, scale, profiling, and capacity observations.' },
  { slug: 'support-knowledge', name: 'Support Knowledge', description: 'Troubleshooting guides and user-facing support patterns.' },
  { slug: 'competitive-intel', name: 'Competitive Intel', description: 'Comparable products, positioning, and market observations.' },
  { slug: 'finance-admin', name: 'Finance & Admin', description: 'Pricing, business operations, and lightweight administrative notes.' },
  { slug: 'learning-lab', name: 'Learning Lab', description: 'Experiments, tutorials, and skill-building reference material.' },
] as const;

export const FIRST_MVP_SEED_CATEGORIES = [
  { slug: 'research-notes', name: 'Research notes' },
  { slug: 'draft-capture', name: 'Draft capture' },
  { slug: 'decision-record', name: 'Decision record' },
  { slug: 'how-to', name: 'How-to' },
  { slug: 'reference', name: 'Reference' },
  { slug: 'runbook', name: 'Runbook' },
  { slug: 'experiment', name: 'Experiment' },
  { slug: 'meeting-notes', name: 'Meeting notes' },
] as const;

export const FIRST_MVP_SEED_GROUPS = [
  { slug: 'agent-flow', name: 'agent-flow', spaceSlug: 'product', description: 'Human plus agent happy-path validation group.' },
  { slug: 'demo-review', name: 'demo-review', spaceSlug: 'agent-notes', description: 'Evening-review demo validation group.' },
  { slug: 'editor-ux', name: 'editor-ux', spaceSlug: 'product-workspace', description: 'Composer, editor, and browsing interaction work.' },
  { slug: 'data-entry', name: 'data-entry', spaceSlug: 'product-workspace', description: 'Structured capture and taxonomy entry flow.' },
  { slug: 'onboarding', name: 'onboarding', spaceSlug: 'customer-insights', description: 'First-run user experience and starter content.' },
  { slug: 'roadmap', name: 'roadmap', spaceSlug: 'release-planning', description: 'Planning themes and milestone candidates.' },
  { slug: 'mcp', name: 'mcp', spaceSlug: 'implementation', description: 'MCP integration and agent-facing workflows.' },
  { slug: 'ops-review', name: 'ops-review', spaceSlug: 'operations', description: 'Operational readiness and recurring checks.' },
] as const;

type DemoSeedItem = readonly [
  title: string,
  space: string,
  category: string,
  tags: readonly string[],
  groups: readonly string[],
  summary: string,
  bodyDetail: string,
];

const DEMO_ITEM_TEMPLATES = [
  ['Command quick reference', 'how-to', ['commands', 'copyable'], ['editor-ux', 'data-entry'], 'Capture a reusable command with the exact copyable text and surrounding context.'],
  ['Decision tradeoff note', 'decision-record', ['decision', 'tradeoff'], ['roadmap'], 'Record the options considered, selected path, and follow-up questions.'],
  ['Research evidence packet', 'research-notes', ['research', 'evidence'], ['demo-review'], 'Collect quotes, links, and confidence notes for later synthesis.'],
  ['Operational checklist', 'runbook', ['operations', 'checklist'], ['ops-review'], 'List repeatable steps, verification commands, and escalation triggers.'],
  ['Experiment result log', 'experiment', ['experiment', 'validation'], ['mcp'], 'Summarize the hypothesis, method, result, and next experiment.'],
  ['Reference pattern card', 'reference', ['reference', 'pattern'], ['agent-flow'], 'Document a reusable pattern with examples and adjacent concepts.'],
  ['Meeting capture brief', 'meeting-notes', ['meeting', 'follow-up'], ['onboarding'], 'Capture decisions, owners, and open questions from a focused conversation.'],
  ['Draft idea scratchpad', 'draft-capture', ['idea', 'draft'], ['data-entry'], 'Save a rough idea with enough context to evaluate later.'],
] as const;

const DEMO_SEED_ITEMS: DemoSeedItem[] = Array.from({ length: 98 }, (_, idx) => {
  const topic = FIRST_MVP_SEED_SPACES[idx % FIRST_MVP_SEED_SPACES.length];
  const template = DEMO_ITEM_TEMPLATES[idx % DEMO_ITEM_TEMPLATES.length];
  const cycle = Math.floor(idx / FIRST_MVP_SEED_SPACES.length) + 1;
  const title = `${topic.name} ${template[0]} ${cycle}`;
  const category = template[1];
  const tags = [...template[2], topic.slug, `scale-${String(idx + 1).padStart(3, '0')}`];
  const groups = template[3];
  const summary = `${template[4]} Topic: ${topic.name}; sample ${idx + 1} of 98.`;
  const bodyDetail = `This deterministic sample helps validate 100-item browse scale, 20-topic dropdown parity, topic scroll behavior, and mixed metadata density for ${topic.name}.`;
  return [title, topic.name, category, tags, groups, summary, bodyDetail];
});

export const FIRST_MVP_SEED_ITEMS = [
  {
    title: 'First MVP Retrieval Anchor',
    status: 'published' as const,
    body: 'first mvp retrieval anchor for UI and MCP search. Links to [[First MVP Linked Context]] so backlinks can prove the graph works.',
    tags: ['first-mvp', 'searchable'],
    frontmatter: {
      space: 'Product',
      summary: 'Published product anchor used by the first-MVP happy-path smoke.',
      categories: ['research-notes'],
      groups: ['agent-flow'],
    },
  },
  {
    title: 'First MVP Linked Context',
    status: 'published' as const,
    body: 'Context target for the first MVP smoke. The human-created item links here and should appear as a backlink.',
    tags: ['first-mvp', 'linked'],
    frontmatter: {
      space: 'Agent Notes',
      summary: 'Linked context item used to validate backlinks and link suggestions.',
      categories: ['draft-capture'],
      groups: ['demo-review'],
    },
  },
  ...DEMO_SEED_ITEMS.map(([title, space, category, tags, groups, summary, bodyDetail], idx) => ({
    title,
    status: idx % 5 === 0 ? 'draft' as const : 'published' as const,
    body: `${summary} ${bodyDetail}`,
    tags,
    frontmatter: {
      space,
      summary,
      categories: [category],
      groups,
    },
  })),
] as const;

const USERNAME = process.env['SEED_ADMIN_USERNAME'] ?? 'admin';
const EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@local';
const PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'admin-dev-password';
const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';

async function seedAdmin(db: Kysely<Database>): Promise<string> {
  const existing = await db
    .selectFrom('users')
    .select(['id', 'role'])
    .where('username', '=', USERNAME)
    .executeTakeFirst();

  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`[seed] user '${USERNAME}' already exists (role=${existing.role}); no-op.`);
    return existing.id;
  }

  const id = newId();
  const hash = await hashPassword(PASSWORD);
  await db
    .insertInto('users')
    .values({
      id,
      email: EMAIL,
      username: USERNAME,
      password_hash: hash,
      role: 'admin',
      created_at: nowIso(),
      deleted_at: null,
    })
    .execute();

  // eslint-disable-next-line no-console
  console.log(`[seed] created admin '${USERNAME}' (email='${EMAIL}'). Sign in at /login.`);
  return id;
}

export async function seedFirstMvpCorpus(db: Kysely<Database>, ownerId: string): Promise<{ itemsCreated: number; spaces: number; categories: number; groups: number }> {
  const now = nowIso();
  let itemsCreated = 0;

  for (const space of FIRST_MVP_SEED_SPACES) {
    await db
      .insertInto('spaces')
      .values({
        id: `space_${space.slug}`,
        slug: space.slug,
        name: space.name,
        description: space.description,
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: space.name, description: space.description, updated_at: now }))
      .execute();
  }

  for (const category of FIRST_MVP_SEED_CATEGORIES) {
    await db
      .insertInto('primary_categories')
      .values({ slug: category.slug, name: category.name, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: category.name, updated_at: now }))
      .execute();
  }

  for (const group of FIRST_MVP_SEED_GROUPS) {
    const space = await db.selectFrom('spaces').select('id').where('slug', '=', group.spaceSlug).executeTakeFirst();
    await db
      .insertInto('groups')
      .values({
        id: `group_${group.slug}`,
        slug: group.slug,
        name: group.name,
        description: group.description,
        space_id: space?.id ?? null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: group.name, description: group.description, space_id: space?.id ?? null, updated_at: now }))
      .execute();
  }

  for (const item of FIRST_MVP_SEED_ITEMS) {
    const existing = await db
      .selectFrom('pages')
      .select('id')
      .where('title', '=', item.title)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing) continue;

    const title = item.title;
    const id = newId();
    const versionId = newId();
    const slug = slugify(title);
    const frontmatter = { ...item.frontmatter, title, status: item.status, tags: [...item.tags] };
    const raw = markdownWithFrontmatter(frontmatter, item.body);
    const parsed = parse(raw);
    const spaceSlug = slugify(String(item.frontmatter.space));
    const space = await db.selectFrom('spaces').select('id').where('slug', '=', spaceSlug).executeTakeFirst();
    const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, [...item.tags]);

    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('pages')
        .values({
          id,
          slug,
          title,
          status: item.status,
          owner_id: ownerId,
          space_id: space?.id ?? null,
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
        await tx.insertInto('item_links').values(links.map((link) => ({ source_page_id: id, target_ref: link.target, link_type: link.type, link_text: link.text, position: link.start }))).execute();
        const wikiLinks = links.filter((link) => link.type === 'wiki');
        if (wikiLinks.length) {
          await tx.insertInto('wikilinks').values(wikiLinks.map((link) => ({ source_page_id: id, target_title: link.target, position: link.start }))).execute();
        }
      }
      await sql`DELETE FROM pages_fts WHERE page_id = ${id}`.execute(tx);
      await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${id}, ${title}, ${parsed.body}, ${taxonomy.tags.join(' ')})`.execute(tx);
    });
    itemsCreated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] first-MVP corpus ready (${itemsCreated} new items; ${FIRST_MVP_SEED_SPACES.length} spaces, ${FIRST_MVP_SEED_CATEGORIES.length} categories, ${FIRST_MVP_SEED_GROUPS.length} groups).`);
  return { itemsCreated, spaces: FIRST_MVP_SEED_SPACES.length, categories: FIRST_MVP_SEED_CATEGORIES.length, groups: FIRST_MVP_SEED_GROUPS.length };
}

function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)
    .join('\n');
  return `---\n${yaml}\n---\n${body}`;
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

export async function runSeed(dbUrl = DB_URL) {
  if (dbUrl !== ':memory:') {
    const abs = isAbsolute(dbUrl) ? dbUrl : resolve(process.cwd(), dbUrl);
    mkdirSync(dirname(abs), { recursive: true });
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] DB_URL=${dbUrl}`);
  const db: Kysely<Database> = makeKysely({ url: dbUrl, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    const adminId = await seedAdmin(db);
    await seedFirstMvpCorpus(db, adminId);
  } finally {
    await db.destroy();
  }
}

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedAsScript) {
  runSeed().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
