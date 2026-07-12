/**
 * Seeding utility for benchmark.
 * Generates N pages with realistic Markdown bodies and metadata.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../src/db/schema.js';
import { newId, nowIso } from '../src/common/ids.js';
import { slugify } from '../src/common/slug.js';
import { parse } from '@echozedlabs/codec';

const SAMPLE_TITLES = [
  'Payments Architecture',
  'Distributed Tracing Guide',
  'API Design Patterns',
  'Database Indexing Strategy',
  'Caching Layers',
  'Authentication Flow',
  'Error Handling Best Practices',
  'Testing Strategy',
  'Deployment Pipeline',
  'Monitoring and Alerting',
  'Security Guidelines',
  'Code Review Standards',
  'Performance Optimization',
  'Incident Response',
  'Runbook Templates',
  'Data Migration Guide',
  'Service Discovery',
  'Rate Limiting',
  'Logging Standards',
  'Backup and Restore',
];

const SAMPLE_TAGS = [
  'runbook',
  'architecture',
  'guide',
  'how-to',
  'infra',
  'backend',
  'database',
  'frontend',
  'devops',
  'security',
  'performance',
  'testing',
];

const SAMPLE_BODY_SNIPPETS = [
  'This document outlines the core strategy for handling retries across our microservices.',
  'Follow this guide when deploying to production. Always check the pre-flight checklist.',
  'Key metrics to monitor: latency (p50, p95, p99), error rate, and throughput.',
  'Authentication is handled via OAuth2 with JWT bearer tokens. Tokens expire after 1 hour.',
  'The database uses read replicas for scaling. Writes go to the primary; reads can use any replica.',
  'Implement exponential backoff with jitter for retries. Start with 100ms, max 10s.',
  'Code reviews must be approved by at least one senior engineer before merging.',
  'Tests should cover happy path, edge cases, and error conditions.',
  'Use structured logging with JSON output. Include request ID and user ID in all logs.',
  'Cache invalidation strategies: TTL, event-driven, or LRU. Choose based on consistency requirements.',
];

interface PageSeedInput {
  db: Kysely<Database>;
  userId: string;
  count: number;
}

export async function seedPages(input: PageSeedInput): Promise<{ count: number; ids: string[] }> {
  const { db, userId, count } = input;
  const ids: string[] = [];

  for (let i = 0; i < count; i++) {
    const pageId = newId();
    const versionId = newId();
    const now = nowIso();

    // Pick a random title and variant it
    const baseTitle = SAMPLE_TITLES[i % SAMPLE_TITLES.length];
    const variantIdx = Math.floor(i / SAMPLE_TITLES.length);
    const title = variantIdx === 0 ? baseTitle : `${baseTitle} (${variantIdx})`;
    const slug = await findFreeSlug(db, title);

    // Generate random tags (0-3 per page)
    const tagCount = Math.floor(Math.random() * 4);
    const tags: string[] = [];
    for (let j = 0; j < tagCount; j++) {
      tags.push(SAMPLE_TAGS[Math.floor(Math.random() * SAMPLE_TAGS.length)]);
    }
    tags = [...new Set(tags)]; // deduplicate

    // Generate body: several sentences from snippets + some variation
    const bodySnippets: string[] = [];
    const snippetCount = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < snippetCount; j++) {
      bodySnippets.push(SAMPLE_BODY_SNIPPETS[Math.floor(Math.random() * SAMPLE_BODY_SNIPPETS.length)]);
    }
    const body = bodySnippets.join(' ') + '\n\nLastly, always refer to the runbook when in doubt.';

    // Frontmatter
    const frontmatter = {
      title,
      status: Math.random() > 0.2 ? 'published' : 'draft',
      tags: tags.length > 0 ? tags : undefined,
    };

    // Serialize as raw markdown
    const yaml = stringifyYamlLite(frontmatter);
    const raw = `---\n${yaml}---\n\n${body}`;

    // Parse to get AST
    const parsed = parse(raw);

    // Insert page + version in a transaction
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('pages')
        .values({
          id: pageId,
          slug,
          title,
          status: frontmatter.status,
          owner_id: userId,
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
          page_id: pageId,
          body_markdown: parsed.body,
          raw_markdown: raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: now,
          created_by: userId,
          parent_version_id: null,
        })
        .execute();

      if (tags.length > 0) {
        await tx
          .insertInto('page_tags')
          .values(tags.map((tag) => ({ page_id: pageId, tag })))
          .execute();
      }

      // Index FTS
      await indexFtsLite(tx, pageId, title, parsed.body, tags);
    });

    ids.push(pageId);
  }

  return { count, ids };
}

/**
 * Simple slug generator. In the benchmark we don't need to worry about collisions
 * since we control the title generation.
 */
async function findFreeSlug(db: Kysely<Database>, title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  let n = 2;
  while (n < 100) {
    const taken = await db
      .selectFrom('pages')
      .select('id')
      .where('slug', '=', candidate)
      .executeTakeFirst();
    if (!taken) return candidate;
    candidate = `${base}-${n}`;
    n++;
  }
  throw new Error('Could not find a free slug after 100 attempts');
}

/**
 * Minimal YAML stringifier for benchmark data.
 */
function stringifyYamlLite(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Index a page for FTS (mimics pages.service.ts indexFts).
 */
async function indexFtsLite(
  db: Kysely<Database>,
  pageId: string,
  title: string,
  body: string,
  tags: string[],
): Promise<void> {
  const { sql } = await import('kysely');
  await sql`DELETE FROM pages_fts WHERE page_id = ${pageId}`.execute(db);
  await sql`INSERT INTO pages_fts (page_id, title, body, tags) VALUES (${pageId}, ${title}, ${body}, ${tags.join(' ')})`.execute(db);
}
