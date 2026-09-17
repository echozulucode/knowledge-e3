/**
 * The shared eval corpus, seeded into a real SQLite database through the real
 * write path (reader UX plan §5.8).
 *
 * `packages/search` evaluates `eval/queries.yaml` against
 * `InMemorySearchProvider` over these same documents. Seeding them here lets
 * the identical query set run against `SearchService` — the FTS5 path every
 * reader actually uses — so the relevance gate measures the product's search
 * instead of the reference implementation's.
 *
 * Fixture ids are used as both the page id and the slug, so an eval expectation
 * (`expect: [runbook-postgres-failover]`) names the same thing in both runs.
 */
import type { INestApplication } from '@nestjs/common';
import type { SearchDoc, SearchHit, SearchProvider, SearchQuery, Viewer } from '@echozedlabs/knowledge-types';
import { EVAL_CORPUS, type AuthoredSearchDoc } from '@echozedlabs/search';
import { PagesService } from '../src/pages/pages.service.js';
import { SearchService } from '../src/search/search.service.js';
import { toReadActor } from '../src/query/viewer.js';

export { EVAL_CORPUS };

/** Frontmatter that reproduces a fixture document's taxonomy and lifecycle. */
export function frontmatterFor(doc: SearchDoc): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  if (doc.topic) fm['topic'] = doc.topic;
  if (doc.type) fm['type'] = doc.type;
  if (doc.categories?.length) fm['categories'] = doc.categories;
  if (doc.groups?.length) fm['groups'] = doc.groups;
  if (doc.description) fm['description'] = doc.description;
  // Both spellings the `author:` filter reads, exactly as the fixture carries them.
  const { authors, author } = doc as AuthoredSearchDoc;
  if (authors?.length) fm['authors'] = authors;
  if (author) fm['author'] = author;
  if (doc.lifecycle_status && doc.lifecycle_status !== 'stable') fm['status'] = doc.lifecycle_status;
  if (doc.superseded_by) fm['superseded_by'] = doc.superseded_by;
  if (doc.stale_after) fm['stale_after'] = doc.stale_after;
  if (doc.generated_by) fm['generated'] = { by: doc.generated_by };
  // The trust tier is derived from `verified`, so write the events that produce
  // the tier the fixture declares rather than the tier itself.
  if (doc.trust_tier === 'human-reviewed') fm['verified'] = [{ by: 'human:eval', at: doc.updated_at }];
  if (doc.trust_tier === 'machine-confirmed') fm['verified'] = [{ by: 'agent:eval', at: doc.updated_at }];
  return fm;
}

/** Create every fixture document through `PagesService`, owned by `ownerId`. */
export async function seedEvalCorpus(app: INestApplication, ownerId: string): Promise<void> {
  const pages = app.get(PagesService);
  for (const doc of EVAL_CORPUS) {
    await pages.create(ownerId, {
      id: doc.id,
      slug: doc.slug,
      title: doc.title,
      body: doc.body_text,
      status: doc.status,
      now: doc.updated_at,
      tags: doc.tags ?? [],
      frontmatter: frontmatterFor(doc),
    });
  }
}

/**
 * `SearchService` behind the `SearchProvider` seam, so the eval harness and the
 * conformance suite can drive the product's search with the same calls they
 * make against `InMemorySearchProvider`. Hits are keyed by slug because that is
 * the fixture id; the database's own page ids are nanoids.
 */
export function searchServiceProvider(app: INestApplication): SearchProvider {
  const service = app.get(SearchService);
  return {
    async index(): Promise<void> {
      // The write path indexes; nothing to do.
    },
    async remove(): Promise<void> {
      // Ditto.
    },
    async query(q: SearchQuery, viewer: Viewer): Promise<SearchHit[]> {
      const hits = await service.search({
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.space !== undefined ? { space: q.space } : {}),
        ...(q.tag !== undefined ? { tag: q.tag } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.group !== undefined ? { group: q.group } : {}),
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.since !== undefined ? { since: q.since } : {}),
        ...(q.sort !== undefined ? { sort: q.sort } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
        // Same rule the in-memory provider applies: drafts for an admin, or
        // when the caller explicitly asks.
        include_drafts: q.include_drafts === true || viewer.role === 'admin',
        viewer_id: toReadActor(viewer).id,
      });
      return hits.map((hit) => ({ ...hit, id: hit.slug }) as unknown as SearchHit);
    },
  };
}
