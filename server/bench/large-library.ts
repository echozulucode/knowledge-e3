/**
 * Deterministic large-library seed data for scale and performance smoke checks.
 *
 * The generator intentionally models Knowledge E3 product language: items live in
 * Topics, carry tags/categories/groups/status, and contain long realistic bodies.
 * It is deterministic for a given {count, seed} pair and writes only rows whose
 * ids/slugs use the `scale_` / `scale-` namespace, so generated data can be
 * recreated locally without committing a bulky fixture file.
 */
import { parse } from '@echozedlabs/codec';
import { sql, type Kysely } from 'kysely';
import { slugify } from '../src/common/slug.js';
import type { Database } from '../src/db/schema.js';

export interface LargeLibraryOptions {
  count?: number;
  seed?: number;
  bodyParagraphs?: number;
}

export interface LargeLibraryRecord {
  id: string;
  versionId: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  topic: SeedTopic;
  tags: string[];
  categories: string[];
  groups: SeedGroup[];
  body: string;
  raw: string;
  updatedAt: string;
}

export interface LargeLibrarySeedResult {
  pages: number;
  topics: number;
  tags: number;
  categories: number;
  groups: number;
  firstPageId: string;
  lastPageId: string;
  marker: string;
}

export interface SeedTopic {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface SeedGroup {
  id: string;
  slug: string;
  name: string;
  topicSlug: string;
}

const DEFAULT_COUNT = 1_000;
const DEFAULT_SEED = 67_067;
const DEFAULT_BODY_PARAGRAPHS = 5;
export const LARGE_LIBRARY_MARKER = 'scale-library-mvp-067';

const TOPIC_NAMES = [
  'Product Strategy',
  'User Research',
  'Search Experience',
  'Markdown Editor',
  'MCP Integration',
  'Storage and Sync',
  'Agent Workflows',
  'Quality Gates',
  'Release Planning',
  'Operational Runbooks',
  'Design System',
  'Performance Notes',
  'Data Modeling',
  'Import Pipeline',
  'Knowledge Taxonomy',
  'Customer Feedback',
  'Architecture Decisions',
  'Experiment Log',
  'Developer Experience',
  'Roadmap Candidates',
  'Security Review',
  'Observability',
  'Integration Testing',
  'Browser UX Lab',
];

const CATEGORY_NAMES = [
  'Decision record',
  'Research notes',
  'Runbook',
  'Design brief',
  'Experiment',
  'Meeting summary',
  'Architecture',
  'QA checklist',
  'Backlog idea',
  'Troubleshooting',
  'Reference',
  'Release note',
];

const TAGS = [
  'agentic-ai',
  'searchable',
  'mcp',
  'topic-navigation',
  'editor-ux',
  'sqlite',
  'git-sync',
  'performance',
  'regression-risk',
  'demo-ready',
  'customer-signal',
  'batch-demo',
  'local-first',
  'scale-test',
  'taxonomy',
  'markdown',
  'discovery',
  'quality-gate',
];

const GROUP_NAMES = [
  'agent-flow',
  'editor-experience',
  'search-and-retrieval',
  'storage-seam',
  'mvp-readiness',
  'scale-validation',
  'demo-narrative',
  'customer-learning',
];

const BODY_SECTIONS = [
  'Context',
  'Evidence',
  'Decision',
  'Open Questions',
  'Next Steps',
  'Risks',
  'Implementation Notes',
  'Validation Plan',
];

const BODY_SENTENCES = [
  'This item captures what the team learned while preparing the next batch demo and keeps the language grounded in Topic and item workflows.',
  'Search quality depends on title, body, tag, category, group, and topic signals staying understandable when the library grows beyond a small curated demo.',
  'The expected reader may be an AI agent, a future maintainer, or Eric reviewing a focused evening checkpoint after autonomous implementation work.',
  'The note intentionally includes realistic Markdown structure, internal links, and enough prose to stress snippets, parsing, storage, and rendering.',
  'A useful result should make the current bottleneck visible without turning ordinary local development into a fragile benchmark lab.',
  'Browser smoke checks should emphasize usability signals: first browse response, topic drawer population, item open, edit path, and create flow.',
  'Server smoke checks should emphasize stable API behavior under load: list, search, item read, item update, taxonomy counts, and MCP tool calls.',
  'The corpus contains repeated domain vocabulary so broad queries return many results and rare markers can still prove precise retrieval.',
  'Generated scale data is disposable; the repeatable command recreates it and prevents bulky local artifacts from drifting into git history.',
  'The next tuning pass should inspect query plans, result payload size, client render cost, and whether long bodies need lazy loading.',
];

export function generateLargeLibrary(options: LargeLibraryOptions = {}): LargeLibraryRecord[] {
  const count = options.count ?? DEFAULT_COUNT;
  const seed = options.seed ?? DEFAULT_SEED;
  const paragraphs = options.bodyParagraphs ?? DEFAULT_BODY_PARAGRAPHS;
  const rng = mulberry32(seed);
  const topics = seedTopics();
  const groups = seedGroups(topics);
  const categories = seedCategories();
  const baseDate = Date.UTC(2026, 0, 1, 12, 0, 0);

  return Array.from({ length: count }, (_, idx) => {
    const itemNo = idx + 1;
    const topic = topics[idx % topics.length]!;
    const groupA = groups[(idx * 3) % groups.length]!;
    const groupB = groups[(idx * 7 + 5) % groups.length]!;
    const categoryA = categories[(idx * 5) % categories.length]!;
    const categoryB = categories[(idx * 11 + 2) % categories.length]!;
    const status = idx % 7 === 0 ? 'draft' : 'published';
    const tags = pickTags(idx, rng);
    const title = `${topic.name} ${categoryA.name} ${String(itemNo).padStart(4, '0')}`;
    const slug = `scale-${String(itemNo).padStart(5, '0')}-${slugify(title)}`;
    const updatedAt = new Date(baseDate + idx * 60 * 60 * 1000).toISOString();
    const body = buildBody({ idx, title, topic, tags, groups: [groupA, groupB], paragraphs, rng });
    const frontmatter = {
      title,
      status,
      topic: topic.name,
      tags,
      categories: unique([categoryA.slug, categoryB.slug]),
      groups: unique([groupA.slug, groupB.slug]),
      summary: `Scale seed item ${itemNo} for ${topic.name}; marker ${LARGE_LIBRARY_MARKER}.`,
    };
    const raw = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
    return {
      id: `scale_page_${String(itemNo).padStart(6, '0')}`,
      versionId: `scale_version_${String(itemNo).padStart(6, '0')}`,
      slug,
      title,
      status,
      topic,
      tags,
      categories: frontmatter.categories,
      groups: uniqueBySlug([groupA, groupB]),
      body,
      raw,
      updatedAt,
    };
  });
}

export function seedTopics(): SeedTopic[] {
  return TOPIC_NAMES.map((name, idx) => ({
    id: `scale_topic_${String(idx + 1).padStart(3, '0')}`,
    slug: `scale-${slugify(name)}`,
    name,
    description: `Large-library scale topic for ${name}.`,
  }));
}

export function seedCategories(): Array<{ slug: string; name: string }> {
  return CATEGORY_NAMES.map((name) => ({ slug: slugify(name), name }));
}

export function seedGroups(topics = seedTopics()): SeedGroup[] {
  return GROUP_NAMES.flatMap((name, idx) => {
    const primaryTopic = topics[idx % topics.length]!;
    const secondaryTopic = topics[(idx * 5 + 3) % topics.length]!;
    return [primaryTopic, secondaryTopic].map((topic, topicIdx) => ({
      id: `scale_group_${String(idx + 1).padStart(3, '0')}_${topicIdx + 1}`,
      slug: `${slugify(name)}-${topic.slug.replace(/^scale-/, '')}`,
      name: `${name.replace(/-/g, ' ')} ${topicIdx + 1}`,
      topicSlug: topic.slug,
    }));
  });
}

export async function seedLargeLibrary(
  db: Kysely<Database>,
  userId: string,
  options: LargeLibraryOptions = {},
): Promise<LargeLibrarySeedResult> {
  const records = generateLargeLibrary(options);
  const topics = seedTopics();
  const categories = seedCategories();
  const groups = seedGroups(topics);
  const now = new Date('2026-01-01T12:00:00.000Z').toISOString();

  await deleteExistingScaleRows(db);

  await db.transaction().execute(async (tx) => {
    if (topics.length) {
      await tx
        .insertInto('spaces')
        .values(topics.map((topic) => ({
          id: topic.id,
          slug: topic.slug,
          name: topic.name,
          description: topic.description,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })))
        .execute();
    }

    if (categories.length) {
      await tx
        .insertInto('primary_categories')
        .values(categories.map((category) => ({
          slug: category.slug,
          name: category.name,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })))
        .onConflict((oc) => oc.column('slug').doUpdateSet((eb) => ({ name: eb.ref('excluded.name'), archived_at: null, updated_at: now })))
        .execute();
    }

    if (groups.length) {
      const topicBySlug = new Map(topics.map((topic) => [topic.slug, topic]));
      await tx
        .insertInto('groups')
        .values(groups.map((group) => ({
          id: group.id,
          slug: group.slug,
          name: group.name,
          description: `Scale validation group for ${group.name}.`,
          space_id: topicBySlug.get(group.topicSlug)?.id ?? null,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })))
        .execute();
    }

    for (const record of records) {
      const parsed = parse(record.raw);
      await tx
        .insertInto('pages')
        .values({
          id: record.id,
          slug: record.slug,
          title: record.title,
          status: record.status,
          owner_id: userId,
          space_id: record.topic.id,
          created_at: record.updatedAt,
          updated_at: record.updatedAt,
          deleted_at: null,
          version_token: 1,
          current_version_id: record.versionId,
        })
        .execute();

      await tx
        .insertInto('page_versions')
        .values({
          id: record.versionId,
          page_id: record.id,
          body_markdown: parsed.body,
          raw_markdown: record.raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: record.updatedAt,
          created_by: userId,
          parent_version_id: null,
        })
        .execute();

      await tx.insertInto('page_tags').values(record.tags.map((tag) => ({ page_id: record.id, tag }))).execute();
      await tx.insertInto('page_categories').values(record.categories.map((category) => ({ page_id: record.id, category }))).execute();
      await tx.insertInto('page_groups').values(record.groups.map((group) => ({ page_id: record.id, group_id: group.id }))).execute();
      await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${record.id}, ${record.title}, ${parsed.body}, ${record.tags.join(' ')})`.execute(tx);
    }
  });

  return {
    pages: records.length,
    topics: topics.length,
    tags: TAGS.length,
    categories: categories.length,
    groups: groups.length,
    firstPageId: records[0]?.id ?? '',
    lastPageId: records[records.length - 1]?.id ?? '',
    marker: LARGE_LIBRARY_MARKER,
  };
}

async function deleteExistingScaleRows(db: Kysely<Database>): Promise<void> {
  const pageIds = await db.selectFrom('pages').select('id').where('id', 'like', 'scale_page_%').execute();
  if (pageIds.length > 0) {
    const ids = pageIds.map((row) => row.id);
    await db.deleteFrom('page_groups').where('page_id', 'in', ids).execute();
    await db.deleteFrom('page_categories').where('page_id', 'in', ids).execute();
    await db.deleteFrom('page_tags').where('page_id', 'in', ids).execute();
    await db.deleteFrom('item_links').where('source_page_id', 'in', ids).execute();
    await db.deleteFrom('wikilinks').where('source_page_id', 'in', ids).execute();
    await db.deleteFrom('page_views').where('page_id', 'in', ids).execute();
    await db.deleteFrom('revision_mirror_state').where('page_id', 'in', ids).execute();
    await db.deleteFrom('page_versions').where('page_id', 'in', ids).execute();
    await db.deleteFrom('pages').where('id', 'in', ids).execute();
  }
  await sql`DELETE FROM pages_fts WHERE page_id LIKE 'scale_page_%'`.execute(db);
  await db.deleteFrom('page_groups').where('group_id', 'like', 'scale_group_%').execute();
  await db.deleteFrom('groups').where('id', 'like', 'scale_group_%').execute();
  await db.deleteFrom('spaces').where('id', 'like', 'scale_topic_%').execute();
}

function pickTags(idx: number, rng: () => number): string[] {
  const count = 2 + (idx % 4);
  const picked: string[] = [TAGS[idx % TAGS.length]!, TAGS[(idx * 3 + 1) % TAGS.length]!];
  while (picked.length < count) picked.push(TAGS[Math.floor(rng() * TAGS.length)]!);
  return unique(picked);
}

function buildBody(input: {
  idx: number;
  title: string;
  topic: SeedTopic;
  tags: string[];
  groups: SeedGroup[];
  paragraphs: number;
  rng: () => number;
}): string {
  const lines = [`# ${input.title}`, '', `Marker: ${LARGE_LIBRARY_MARKER}.`, ''];
  for (let p = 0; p < input.paragraphs; p += 1) {
    const heading = BODY_SECTIONS[(input.idx + p) % BODY_SECTIONS.length]!;
    lines.push(`## ${heading}`, '');
    const s1 = BODY_SENTENCES[(input.idx + p * 2) % BODY_SENTENCES.length]!;
    const s2 = BODY_SENTENCES[(input.idx + p * 3 + 4) % BODY_SENTENCES.length]!;
    const rare = p === input.paragraphs - 1 && input.idx % 17 === 0 ? ' Rare retrieval marker: vectorless-corpus-candidate.' : '';
    lines.push(`${s1} ${s2}${rare}`);
    lines.push(`Topic: ${input.topic.name}. Tags: ${input.tags.join(', ')}. Groups: ${input.groups.map((group) => group.slug).join(', ')}.`);
    lines.push(`Related: [[${TOPIC_NAMES[Math.floor(input.rng() * TOPIC_NAMES.length)]} ${CATEGORY_NAMES[Math.floor(input.rng() * CATEGORY_NAMES.length)]}]]`, '');
  }
  lines.push('- [ ] Confirm item remains discoverable through browser search.');
  lines.push('- [ ] Confirm MCP search can retrieve this item by marker.');
  return lines.join('\n');
}

function stringifyYaml(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => Array.isArray(value) ? `${key}: [${value.map((entry) => JSON.stringify(entry)).join(', ')}]` : `${key}: ${JSON.stringify(value)}`)
    .join('\n') + '\n';
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueBySlug(groups: SeedGroup[]): SeedGroup[] {
  return [...new Map(groups.map((group) => [group.slug, group])).values()];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
