#!/usr/bin/env node
/**
 * Populate a deterministic demo corpus for evaluating browse/topic/category scale.
 *
 * Idempotent: re-running creates only missing topics, categories, and items.
 *
 * Usage:
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server populate:demo
 *   DB_URL=./data/kp.sqlite node --import @swc-node/register/esm-register server/scripts/populate-demo-corpus.ts
 */
import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kysely, sql } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import { hashPassword } from '../src/auth/password.js';
import { newId, nowIso } from '../src/common/ids.js';
import { slugify } from '../src/common/slug.js';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from '../src/pages/taxonomy.js';

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';
const DEMO_OWNER_USERNAME = process.env['DEMO_OWNER_USERNAME'] ?? 'demo-admin';
const DEMO_OWNER_EMAIL = process.env['DEMO_OWNER_EMAIL'] ?? 'demo-admin@local';
const DEMO_OWNER_PASSWORD = process.env['DEMO_OWNER_PASSWORD'] ?? 'demo-admin-password';

export const DEMO_CORPUS_TOPICS = [
  ['demo-product-strategy', 'Demo Product Strategy', 'Roadmap, positioning, and packaging decisions.'],
  ['demo-customer-research', 'Demo Customer Research', 'Interviews, feedback, and user evidence.'],
  ['demo-technical-research', 'Demo Technical Research', 'Engineering research and technology evaluation.'],
  ['demo-architecture', 'Demo Architecture', 'System design, diagrams, and integration boundaries.'],
  ['demo-implementation', 'Demo Implementation', 'Build notes, delivery plans, and code-facing details.'],
  ['demo-operations', 'Demo Operations', 'Runbooks, maintenance, and recurring checks.'],
  ['demo-automation', 'Demo Automation', 'Scripts and hands-off workflow patterns.'],
  ['demo-integrations', 'Demo Integrations', 'External APIs, services, and connector notes.'],
  ['demo-data-modeling', 'Demo Data Modeling', 'Schemas, taxonomies, and metadata conventions.'],
  ['demo-quality-assurance', 'Demo Quality Assurance', 'Test plans, coverage, and validation evidence.'],
  ['demo-security-privacy', 'Demo Security & Privacy', 'Access control, threat notes, and sensitive-data handling.'],
  ['demo-performance', 'Demo Performance', 'Latency, scale, profiling, and capacity observations.'],
  ['demo-support-knowledge', 'Demo Support Knowledge', 'Troubleshooting and support-facing knowledge.'],
  ['demo-competitive-intel', 'Demo Competitive Intel', 'Comparable products and market observations.'],
  ['demo-finance-admin', 'Demo Finance & Admin', 'Pricing, business operations, and administrative notes.'],
  ['demo-learning-lab', 'Demo Learning Lab', 'Experiments, tutorials, and skill-building reference.'],
  ['demo-release-planning', 'Demo Release Planning', 'Milestones, readiness, and launch checklists.'],
  ['demo-agent-workflows', 'Demo Agent Workflows', 'AI handoff, review, and autonomous-worker patterns.'],
  ['demo-personal-knowledge', 'Demo Personal Knowledge', 'Reusable personal notes and evergreen references.'],
  ['demo-meeting-memory', 'Demo Meeting Memory', 'Meeting captures, decisions, owners, and follow-ups.'],
] as const;

export const DEMO_CORPUS_CATEGORIES = [
  ['demo-research-notes', 'Demo Research notes'],
  ['demo-draft-capture', 'Demo Draft capture'],
  ['demo-decision-record', 'Demo Decision record'],
  ['demo-how-to', 'Demo How-to'],
  ['demo-reference', 'Demo Reference'],
  ['demo-runbook', 'Demo Runbook'],
  ['demo-experiment', 'Demo Experiment'],
  ['demo-meeting-notes', 'Demo Meeting notes'],
  ['demo-command-card', 'Demo Command card'],
  ['demo-checklist', 'Demo Checklist'],
] as const;

const ITEM_PATTERNS = [
  ['Command quick reference', 'demo-command-card', 'Copy this command when repeating the workflow.', '```bash\npnpm --filter @echozedlabs/web test:e2e -- grouped-topic-browse.spec.ts\n```'],
  ['Decision tradeoff note', 'demo-decision-record', 'Record the options considered and the selected path.', 'Decision: prefer catalog-backed topic selection over discovered metadata fallbacks.'],
  ['Research evidence packet', 'demo-research-notes', 'Collect quotes, links, and confidence notes.', 'Evidence table: source, quote, confidence, next question.'],
  ['Operational runbook', 'demo-runbook', 'List repeatable steps, verification commands, and escalation triggers.', 'Verification: confirm health endpoint, recent jobs, and error budget.'],
  ['Experiment result log', 'demo-experiment', 'Summarize the hypothesis, method, result, and next experiment.', 'Hypothesis: scaled topic browsing remains usable with 20 visible topics.'],
  ['Reference pattern card', 'demo-reference', 'Document a reusable pattern with examples and adjacent concepts.', 'Pattern: durable topic + primary purpose category + flexible tags.'],
  ['Meeting capture brief', 'demo-meeting-notes', 'Capture decisions, owners, and open questions from a focused conversation.', 'Follow-up: review topic density and category vocabulary.'],
  ['Draft idea scratchpad', 'demo-draft-capture', 'Save a rough idea with enough context to evaluate later.', 'Idea: add saved views for repeated topic/category combinations.'],
  ['Launch checklist', 'demo-checklist', 'Track a small readiness checklist for the topic.', '- [ ] owner assigned\n- [ ] evidence attached\n- [ ] review complete'],
  ['Implementation how-to', 'demo-how-to', 'Explain the steps needed to repeat the implementation.', 'Steps: choose topic, choose primary category, add copyable command, save.'],
] as const;

type PopulateDemoCorpusResult = {
  topicsCreated: number;
  categoriesCreated: number;
  itemsCreated: number;
};

export async function populateDemoCorpus(db: Kysely<Database>, ownerId?: string): Promise<PopulateDemoCorpusResult> {
  const now = nowIso();
  const actualOwnerId = ownerId ?? await ensureDemoOwner(db);
  let topicsCreated = 0;
  let categoriesCreated = 0;
  let itemsCreated = 0;

  for (const [slug, name, description] of DEMO_CORPUS_TOPICS) {
    const result = await db
      .insertInto('spaces')
      .values({ id: `space_${slug}`, slug, name, description, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0n) > 0) topicsCreated += 1;
  }

  for (const [slug, name] of DEMO_CORPUS_CATEGORIES) {
    const result = await db
      .insertInto('primary_categories')
      .values({ slug, name, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0n) > 0) categoriesCreated += 1;
  }

  const topicRows = await db
    .selectFrom('spaces')
    .select(['id', 'slug', 'name'])
    .where('slug', 'in', DEMO_CORPUS_TOPICS.map(([slug]) => slug))
    .execute();
  const topicBySlug = new Map(topicRows.map((topic) => [topic.slug, topic]));

  for (let index = 0; index < 100; index += 1) {
    const [topicSlug, topicName] = DEMO_CORPUS_TOPICS[index % DEMO_CORPUS_TOPICS.length];
    const [patternName, category, summaryLead, bodySnippet] = ITEM_PATTERNS[index % ITEM_PATTERNS.length];
    const topic = topicBySlug.get(topicSlug);
    const sequence = String(index + 1).padStart(3, '0');
    const cycle = Math.floor(index / DEMO_CORPUS_TOPICS.length) + 1;
    const title = `Demo Corpus: ${topicName} ${patternName} ${cycle}`;
    const existing = await db.selectFrom('pages').select('id').where('title', '=', title).where('deleted_at', 'is', null).executeTakeFirst();
    if (existing) continue;

    const id = newId();
    const versionId = newId();
    const status = index % 7 === 0 ? 'draft' : 'published';
    const tags = ['demo-corpus', topicSlug, category, `sample-${sequence}`];
    const frontmatter = {
      title,
      status,
      topic: topicName,
      summary: `${summaryLead} Topic ${topicName}; sample ${sequence} of 100.`,
      categories: [category],
      tags,
    };
    const body = `${summaryLead}\n\n${bodySnippet}\n\nThis deterministic demo item validates 100-item browsing, 20-topic navigation, and 10-category selection at realistic UI density.`;
    const raw = markdownWithFrontmatter(frontmatter, body);
    const parsed = parse(raw);
    const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, tags);

    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('pages')
        .values({
          id,
          slug: slugify(title),
          title,
          status,
          owner_id: actualOwnerId,
          space_id: topic?.id ?? null,
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
          created_by: actualOwnerId,
          parent_version_id: null,
        })
        .execute();

      await syncTaxonomyInTx(tx, id, taxonomy);
      const links = extractItemLinks(parsed);
      if (links.length) {
        await tx.insertInto('item_links').values(links.map((link) => ({ source_page_id: id, target_ref: link.target, link_type: link.type, link_text: link.text, position: link.start }))).execute();
      }
      await sql`DELETE FROM pages_fts WHERE page_id = ${id}`.execute(tx);
      await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${id}, ${title}, ${parsed.body}, ${taxonomy.tags.join(' ')})`.execute(tx);
    });
    itemsCreated += 1;
  }

  return { topicsCreated, categoriesCreated, itemsCreated };
}

async function ensureDemoOwner(db: Kysely<Database>): Promise<string> {
  const existing = await db.selectFrom('users').select('id').where('username', '=', DEMO_OWNER_USERNAME).executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  const passwordHash = await hashPassword(DEMO_OWNER_PASSWORD);
  await db
    .insertInto('users')
    .values({ id, email: DEMO_OWNER_EMAIL, username: DEMO_OWNER_USERNAME, password_hash: passwordHash, role: 'admin', created_at: nowIso(), deleted_at: null })
    .execute();
  return id;
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

export async function runPopulateDemoCorpus(dbUrl = DB_URL): Promise<PopulateDemoCorpusResult> {
  if (dbUrl !== ':memory:') {
    const abs = isAbsolute(dbUrl) ? dbUrl : resolve(process.cwd(), dbUrl);
    mkdirSync(dirname(abs), { recursive: true });
  }

  const db = makeKysely({ url: dbUrl, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    return await populateDemoCorpus(db);
  } finally {
    await db.destroy();
  }
}

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedAsScript) {
  runPopulateDemoCorpus()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(`[populate-demo-corpus] ready (${result.itemsCreated} new items; ${result.topicsCreated} new topics; ${result.categoriesCreated} new main categories).`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[populate-demo-corpus] failed:', err);
      process.exit(1);
    });
}
