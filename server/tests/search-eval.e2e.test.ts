/**
 * Relevance eval against the search every reader uses (reader UX plan §5.8).
 *
 * `packages/search/tests/eval.test.ts` runs `eval/queries.yaml` against
 * `InMemorySearchProvider`. That gate was green on features the product did not
 * have, because the in-memory provider is not what `/search` calls. This test
 * runs the SAME query set against `SearchService` over a seeded SQLite
 * database — FTS5, the weighted ranker, the real visibility rules — and gates
 * at `successRate === 1`, k=5.
 *
 * A failure here is a real finding: either the ranking regressed, or a case
 * encodes something only the reference implementation can do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { evaluate, loadEvalCases, EVAL_QUERIES_PATH, InMemorySearchProvider, type EvalCase } from '@echozedlabs/search';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { EVAL_CORPUS, searchServiceProvider, seedEvalCorpus } from './eval-corpus.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';
import { SearchService } from '../src/search/search.service.js';
import { toReadActor } from '../src/query/viewer.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };
const K = 5;

describe('search relevance eval (real SearchService over SQLite)', () => {
  let app: INestApplication;
  let cases: EvalCase[];

  beforeAll(async () => {
    app = await makeApp();
    const { userId } = await seedAdminAndLogin(app);
    await seedEvalCorpus(app, userId);
    cases = await loadEvalCases(EVAL_QUERIES_PATH);
  });
  afterAll(async () => app.close());

  it('passes every eval case at k=5', async () => {
    const report = await evaluate(cases, searchServiceProvider(app), { k: K, viewer: ANON });
    const misses = report.cases.filter((c) => !c.hit).map((c) => `${c.query} -> [${c.returned.join(', ')}]`);

    expect(misses).toEqual([]);
    expect(report.total).toBe(cases.length);
    expect(report.successRate).toBe(1);
  });

  it('passes them at k=3 as well, the bar the in-memory run is held to', async () => {
    // The two gates are deliberately the same height. If the real search can
    // only clear the lower one, that is a ranking finding, not a reason to
    // lower the bar for the reference implementation.
    const report = await evaluate(cases, searchServiceProvider(app), { k: 3, viewer: ANON });
    const misses = report.cases.filter((c) => !c.hit).map((c) => `${c.query} -> [${c.returned.join(', ')}]`);

    expect(misses).toEqual([]);
    expect(report.successRate).toBe(1);
  });

  it('agrees with the in-memory provider on every eval case, so the gate cannot be green on one implementation only', async () => {
    const memory = new InMemorySearchProvider();
    for (const doc of EVAL_CORPUS) await memory.index(doc);

    const [real, reference] = await Promise.all([
      evaluate(cases, searchServiceProvider(app), { k: K, viewer: ANON }),
      evaluate(cases, memory, { k: K, viewer: ANON }),
    ]);

    expect(real.successRate).toBe(reference.successRate);
    expect(real.successRate).toBe(1);
  });

  it('passes every eval case through the reader path, lifecycle demotions included', async () => {
    // `/search` goes through KnowledgeQuery, which demotes stale, deprecated and
    // machine-unverified hits on the relevance path. A case that only passes
    // before that policy runs has not been proved for a reader.
    const query = app.get(KnowledgeQueryService);
    const misses: string[] = [];
    for (const evalCase of cases) {
      const set = await query.search({ q: evalCase.query, limit: K }, ANON);
      const returned = set.results.slice(0, K).map((hit) => hit.slug);
      const missing = evalCase.expect.filter((id) => !returned.includes(id));
      if (missing.length) misses.push(`${evalCase.query} -> [${returned.join(', ')}]`);
    }
    expect(misses).toEqual([]);
  });

  it('ranks the acronym-titled page first for `MQTT` on the real SQLite path (identifier boost)', async () => {
    // The boost lives in `packages/search`'s ranker, which the server uses
    // through `server/src/search/ranker.ts`; this proves it is judged on the
    // query as typed after the server lifts filters out of it, and survives the
    // reader path's lifecycle policy.
    const service = app.get(SearchService);
    for (const q of ['MQTT', 'MQTT type:Reference', 'mqtt']) {
      const hits = await service.search({ q, limit: 5, viewer_id: toReadActor(ANON).id });
      expect({ q, first: hits[0]?.slug }).toEqual({ q, first: 'reference-mqtt-topic-hierarchy' });
    }
    const upper = await service.search({ q: 'MQTT', limit: 5, viewer_id: toReadActor(ANON).id });
    const lower = await service.search({ q: 'mqtt', limit: 5, viewer_id: toReadActor(ANON).id });
    const score = (hits: typeof upper) => hits.find((hit) => hit.slug === 'reference-mqtt-topic-hierarchy')!.score;
    expect(score(upper)).toBeGreaterThan(score(lower));

    const reader = await app.get(KnowledgeQueryService).search({ q: 'MQTT', limit: 5 }, ANON);
    expect(reader.results[0]!.slug).toBe('reference-mqtt-topic-hierarchy');
  });

  it('counts every match, not the size of the page it returned', async () => {
    const query = app.get(KnowledgeQueryService);
    const all = await query.search({ q: 'the', limit: 2 }, ANON);
    // `total` is a COUNT over the same predicate: a page of 2 out of many.
    expect(all.results.length).toBeLessThanOrEqual(2);
    expect(all.total).toBeGreaterThan(all.results.length);

    const paged = await query.search({ q: 'the', limit: 2, offset: 2 }, ANON);
    expect(paged.total).toBe(all.total);
    expect(paged.results.map((hit) => hit.id)).not.toEqual(all.results.map((hit) => hit.id));
  });
});
