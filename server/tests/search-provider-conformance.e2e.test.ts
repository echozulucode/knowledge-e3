/**
 * Provider conformance (reader UX plan §5.2).
 *
 * One query list, two implementations of the same query language:
 * `InMemorySearchProvider` (the reference behind the ADR-0002 seam) and
 * `SearchService` (FTS5, what `/search` and ⌘K call). They must return the same
 * items. This test exists because they had silently diverged — the in-memory
 * provider honoured `-term` exclusion and the product did not, and the eval
 * gate ran only against the provider that did.
 *
 * Ordering is deliberately NOT asserted: the two score differently on purpose
 * (bm25 plus the weighted ranker vs. a transparent field-weight model). What
 * must agree is WHICH items a query selects.
 *
 * 2026-09-11: the first of the two divergences the last test recorded is closed.
 * `pages_fts` now indexes `description` as well as title, body and tags, so free
 * text over the description is conformance rather than a documented difference —
 * the query list below carries it, and the last test asserts the two AGREE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { SearchProvider, SearchQuery, Viewer } from '@echozedlabs/knowledge-types';
import { InMemorySearchProvider } from '@echozedlabs/search';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { SearchService } from '../src/search/search.service.js';
import { ANONYMOUS_ACTOR } from '../src/auth/auth-mode.js';
import { EVAL_CORPUS, searchServiceProvider, seedEvalCorpus } from './eval-corpus.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };
const ADMIN: Viewer = { userId: 'admin', role: 'admin' };
const LIMIT = 100;

/**
 * Queries whose result SET both providers must agree on. Free text here stays
 * inside the fields both index — title, body, tags and (since §5.4) description
 * — because the two still differ, knowingly, on the one axis recorded in the
 * last test of this file.
 */
const CONFORMANCE_QUERIES: { q: string; viewer?: Viewer; note: string }[] = [
  { q: 'docker', note: 'plain term' },
  { q: 'docker cache', note: 'two terms AND' },
  { q: '"pg_ctl promote"', note: 'exact phrase' },
  { q: 'kube', note: 'prefix on the word still being typed' },
  { q: 'hiding', note: 'a word that appears only in an item description, which both providers index' },
  { q: 'reusable conventions', note: 'two words, both only in a description' },
  { q: 'orm', note: 'a word inside a Topic name (`platform`) reaches only the item that really says it' },
  { q: '"kubernetes"', note: 'a quoted word matches whole words only, never a fragment' },
  { q: 'ci -jenkins', note: 'excluded term' },
  { q: 'kubectl -"pod disruption budgets"', note: 'excluded phrase, excluded as a phrase and not as its words' },
  { q: 'tag:kubernetes', note: 'single filter' },
  { q: 'tag:kubernetes tag:postgres', note: 'repeated filter ORs its values' },
  { q: 'tag:kubernetes tag:postgres tag:vpn', note: 'three values, still OR' },
  { q: 'type:Runbook', note: 'type: reaches the results' },
  { q: 'type:runbook', note: 'type: is case-insensitive' },
  { q: 'type:Runbook kubernetes', note: 'filter AND text' },
  { q: 'type:Runbook type:FAQ', note: 'repeated type ORs' },
  { q: '-type:Runbook ci', note: 'negated type keeps untyped and other-typed items' },
  { q: 'ci -tag:jenkins', note: 'negated tag' },
  { q: 'topic:sre', note: 'topic filter' },
  { q: 'space:sre', note: 'space is an alias of topic' },
  { q: 'space:sre topic:platform', note: 'the alias pair ORs rather than dropping one' },
  { q: 'category:operations', note: 'primary category (curated vocabulary)' },
  { q: 'category:operations category:build', note: 'repeated category ORs' },
  { q: 'group:sre', note: 'group filter' },
  { q: 'category:operations -tag:postgres', note: 'include and exclude on different axes' },
  { q: 'status:draft', viewer: ADMIN, note: 'status filter under draft visibility' },
  { q: 'tag:kubernetes type:Runbook', note: 'two axes AND' },
];

/**
 * `author:`, `updated:` and `is:` (reader UX plan §5.2), mirrored from
 * `CONFORMANCE` in `packages/search/tests/in-memory-provider-filters.test.ts`,
 * where `filter-semantics.ts` defines what they mean. Each names the EXACT
 * result set, so the SQL is held to the reference definition rather than merely
 * to "the same as the other provider today". Relative `updated:` windows are
 * absent on purpose: they depend on a clock the server run does not inject.
 */
const ITEM_FILTER_CONFORMANCE: { q: string; viewer?: Viewer; expect: string[]; note: string }[] = [
  { q: 'author:"Ada Lovelace"', expect: ['reference-mqtt-topic-hierarchy'], note: 'authors list, quoted name' },
  { q: 'author:"charles babbage"', expect: ['reference-mqtt-topic-hierarchy'], note: 'second name in the list, any case' },
  { q: 'author:"Grace Hopper"', expect: ['guide-sensor-gateway-onboarding'], note: 'single author field' },
  { q: 'author:"ada   lovelace"', expect: ['reference-mqtt-topic-hierarchy'], note: 'whitespace collapsed' },
  { q: 'author:"Ada Lovelace" author:"Grace Hopper"', expect: ['guide-sensor-gateway-onboarding', 'reference-mqtt-topic-hierarchy'], note: 'repeated author ORs' },
  { q: 'category:integration -author:"grace hopper"', expect: ['reference-mqtt-topic-hierarchy'], note: 'negated author' },
  { q: 'author:"Grace Hopper" gateway', expect: ['guide-sensor-gateway-onboarding'], note: 'author AND text' },
  { q: 'updated:2025', expect: ['runbook-tls-cert-renewal'], note: 'a bare year' },
  { q: 'updated:<2025', expect: ['guide-jenkins-pipelines'], note: 'before a year' },
  {
    q: 'updated:2026-08',
    expect: ['guide-github-actions-ci', 'guide-sensor-gateway-onboarding', 'runbook-kubernetes-node-drain', 'troubleshoot-docker-build-cache'],
    note: 'a whole month',
  },
  {
    q: 'updated:<2026-06 updated:2026',
    expect: ['blog-prisma-to-kysely', 'blog-sqlite-fts5-search', 'guide-jenkins-pipelines', 'runbook-tls-cert-renewal'],
    note: 'updated: is single-valued: the second value is warned about, never ANDed',
  },
  { q: 'updated:<=2026-08-01 runbook', expect: ['runbook-kubernetes-node-drain', 'runbook-postgres-failover', 'runbook-tls-cert-renewal'], note: 'on-or-before a day includes that whole day' },
  { q: 'updated:<2026-08-01 runbook', expect: ['runbook-postgres-failover', 'runbook-tls-cert-renewal'], note: 'before a day excludes that day (drain is 2026-08-01T11:00Z)' },
  { q: 'updated:>2026-08-20', expect: ['metric-weekly-deploy-frequency'], note: 'after a day excludes that day (docker is 2026-08-20T10:00Z)' },
  { q: 'updated:>=2026-09', viewer: ADMIN, expect: ['adr-postgres-cloud-edition', 'metric-weekly-deploy-frequency'], note: 'updated: under draft visibility' },
  { q: 'is:unverified', expect: ['metric-weekly-deploy-frequency'], note: 'unverified tier' },
  { q: 'is:unverified', viewer: ADMIN, expect: ['adr-postgres-cloud-edition', 'metric-weekly-deploy-frequency'], note: 'is: never widens visibility, but an admin sees the draft' },
  { q: 'is:machine-confirmed', expect: ['troubleshoot-node-heap-oom'], note: 'one tier exactly' },
  { q: 'is:needs-review', expect: ['runbook-tls-cert-renewal'], note: 'stale' },
  { q: 'is:stale', expect: ['runbook-tls-cert-renewal'], note: 'alias of needs-review' },
  { q: 'is:machine-confirmed is:needs-review', expect: ['runbook-tls-cert-renewal', 'troubleshoot-node-heap-oom'], note: 'repeated is: ORs' },
  { q: '-is:verified', expect: ['metric-weekly-deploy-frequency'], note: 'negated is:' },
  { q: 'kubectl -is:needs-review', expect: ['runbook-kubernetes-node-drain'], note: 'negated is: AND text' },
  { q: 'is:draft', viewer: ADMIN, expect: ['adr-postgres-cloud-edition'], note: 'is:draft for an admin' },
  { q: 'is:draft', expect: [], note: 'is:draft never shows an anonymous reader a draft' },
  { q: 'status:published is:draft', viewer: ADMIN, expect: [], note: 'status: and is: both hold' },
  { q: 'is:verified type:Runbook updated:2026', expect: ['runbook-kubernetes-node-drain', 'runbook-postgres-failover'], note: 'three new-and-old keys AND' },
  { q: 'MQTT', expect: ['guide-sensor-gateway-onboarding', 'reference-mqtt-topic-hierarchy'], note: 'acronym selects the same set as the word' },
  { q: 'cert-man', expect: ['runbook-tls-cert-renewal'], note: 'prefix on a hyphenated trailing term' },
];

async function idsFrom(provider: SearchProvider, q: SearchQuery, viewer: Viewer): Promise<string[]> {
  const hits = await provider.query({ ...q, limit: LIMIT }, viewer);
  return hits.map((hit) => hit.id).sort();
}

describe('SearchProvider conformance: in-memory vs SearchService', () => {
  let app: INestApplication;
  let memory: InMemorySearchProvider;
  let real: SearchProvider;

  beforeAll(async () => {
    app = await makeApp();
    const { userId } = await seedAdminAndLogin(app);
    await seedEvalCorpus(app, userId);
    memory = new InMemorySearchProvider();
    for (const doc of EVAL_CORPUS) await memory.index(doc);
    real = searchServiceProvider(app);
  });
  afterAll(async () => app.close());

  for (const { q, viewer, note } of CONFORMANCE_QUERIES) {
    it(`selects the same items for \`${q}\` (${note})`, async () => {
      const who = viewer ?? ANON;
      const [fromMemory, fromService] = await Promise.all([idsFrom(memory, { q }, who), idsFrom(real, { q }, who)]);
      expect(fromService).toEqual(fromMemory);
      // A query that selects nothing in both providers proves nothing, so the
      // list above must keep matching something.
      expect(fromMemory.length).toBeGreaterThan(0);
    });
  }

  for (const { q, viewer, expect: expected, note } of ITEM_FILTER_CONFORMANCE) {
    it(`selects exactly the reference set for \`${q}\` (${note})`, async () => {
      const who = viewer ?? ANON;
      const [fromMemory, fromService] = await Promise.all([idsFrom(memory, { q }, who), idsFrom(real, { q }, who)]);
      // Both against the literal set, so neither provider can drift and drag the
      // other's expectation with it. Three cases select nothing on purpose.
      expect(fromService).toEqual([...expected].sort());
      expect(fromMemory).toEqual([...expected].sort());
    });
  }

  it('honours explicit query fields identically, and lets them win over the same parsed filter', async () => {
    const cases: SearchQuery[] = [
      { tag: 'kubernetes' },
      { type: 'Runbook' },
      { category: 'operations' },
      { group: 'sre' },
      { space: 'platform' },
      { q: 'ci tag:jenkins', tag: 'github-actions' },
    ];
    for (const query of cases) {
      const [fromMemory, fromService] = await Promise.all([idsFrom(memory, query, ANON), idsFrom(real, query, ANON)]);
      expect({ query, ids: fromService }).toEqual({ query, ids: fromMemory });
      expect(fromMemory.length).toBeGreaterThan(0);
    }
  });

  it('hides drafts from everyone but an admin, in both providers', async () => {
    for (const viewer of [ANON, { userId: 'u1', role: 'user' } as Viewer]) {
      const [fromMemory, fromService] = await Promise.all([idsFrom(memory, { q: 'postgres' }, viewer), idsFrom(real, { q: 'postgres' }, viewer)]);
      expect(fromService).toEqual(fromMemory);
      expect(fromService).not.toContain('adr-postgres-cloud-edition');
    }
    const [fromMemory, fromService] = await Promise.all([idsFrom(memory, { q: 'postgres' }, ADMIN), idsFrom(real, { q: 'postgres' }, ADMIN)]);
    expect(fromService).toEqual(fromMemory);
    expect(fromService).toContain('adr-postgres-cloud-edition');
  });

  /**
   * The record of where the two implementations stand relative to each other.
   * One entry closed on 2026-09-11 and one remains; both are asserted rather
   * than avoided, so re-opening the first or closing the second fails here and
   * whoever does it updates the record.
   */
  it('records where the two are known to differ, so the difference cannot be mistaken for drift', async () => {
    // 1. CLOSED (2026-09-11, reader UX plan §5.4). `pages_fts` was
    //    fts5(page_id, title, body, tags) and the in-memory provider indexed the
    //    description as well, so a word that lived only in an item's one-line
    //    summary was findable in the reference implementation and invisible in
    //    the product. The table now carries a `description` column, so the two
    //    AGREE — this assertion is the inverse of the one it replaces.
    const descriptionOnly = 'hiding';
    const [memoryDescription, serviceDescription] = await Promise.all([
      idsFrom(memory, { q: descriptionOnly }, ANON),
      idsFrom(real, { q: descriptionOnly }, ANON),
    ]);
    expect(serviceDescription).toEqual(memoryDescription);
    expect(serviceDescription).toContain('blog-prisma-to-kysely');

    // 2. STILL OPEN, but narrowed. The server matches free text against
    //    taxonomy NAMES (Topic, category, group) — as `pages_fts` columns since
    //    R3.3, and through its whole-token LIKE safety net; the in-memory
    //    provider still indexes title, tags, description and body only
    //    (re-checked 2026-09-13 against the library's `FIELD_ORDER`).
    //    `sre` is a Topic name that appears in no title, body, tag or
    //    description, so only the server reaches those items — that affordance
    //    is deliberate and stays.
    const taxonomyOnly = 'sre';
    expect(await idsFrom(memory, { q: taxonomyOnly }, ANON)).toEqual([]);
    expect((await idsFrom(real, { q: taxonomyOnly }, ANON)).length).toBeGreaterThan(0);

    // What the net no longer does is match a SUBSTRING. It used to be
    // `LIKE '%orm%'`, so `orm` reached every item whose Topic is `platform` —
    // and since the net counts toward `total` and the facets, it inflated the
    // numbers too. It is a token-boundary match now, so `orm` returns only the
    // item that actually says "ORM", and the two providers agree on it.
    const insideATopicName = 'orm';
    const [memoryOrm, serviceOrm] = await Promise.all([
      idsFrom(memory, { q: insideATopicName }, ANON),
      idsFrom(real, { q: insideATopicName }, ANON),
    ]);
    expect(serviceOrm).toEqual(memoryOrm);
    expect(serviceOrm).toEqual(['blog-prisma-to-kysely']);

    // And the whole-token match still reaches a multi-word taxonomy name: the
    // group is `platform-eng`, which `platform` finds and `orm` does not.
    const insideAGroupName = 'platform';
    expect((await idsFrom(real, { q: insideAGroupName }, ANON)).length).toBeGreaterThan(0);
  });

  it('counts the taxonomy net the same way it lists it, on every pass', async () => {
    // Wave 1 unified the FTS pass, the browse pass, the COUNT(*) and the facets
    // onto one resolved query, so tightening the net in one place has to tighten
    // it everywhere. `total` is the observable: `orm` used to report every
    // `platform` item.
    const service = app.get(SearchService);
    const set = await service.searchWithContext({ q: 'orm', limit: 100, viewer_id: ANONYMOUS_ACTOR.id });
    expect(set.results.map((hit) => hit.slug)).toEqual(['blog-prisma-to-kysely']);
    expect(set.total).toBe(1);
    const topicFacetCounts = set.facets.topics.reduce((sum, facet) => sum + facet.count, 0);
    expect(topicFacetCounts).toBe(1);
  });
});
