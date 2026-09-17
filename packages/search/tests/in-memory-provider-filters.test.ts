import { beforeAll, describe, expect, it } from 'vitest';
import type { SearchHit, SearchQuery, Viewer } from '@echozedlabs/knowledge-types';
import { InMemorySearchProvider } from '../src/in-memory-provider.js';
import { CORPUS } from './fixtures/corpus.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };
const ADMIN: Viewer = { userId: 'admin', role: 'admin' };
/** Friday 5 September 2026, 00:00 UTC — relative `updated:` windows count back from here. */
const NOW = new Date('2026-09-05T00:00:00.000Z');

async function makeProvider(): Promise<InMemorySearchProvider> {
  const provider = new InMemorySearchProvider({ now: () => NOW });
  for (const doc of CORPUS) await provider.index(doc);
  return provider;
}

const ids = (hits: SearchHit[]): string[] => hits.map((hit) => hit.id);

const PUBLISHED = CORPUS.filter((doc) => doc.status === 'published').map((doc) => doc.id);

/**
 * The cases `server/tests/search-provider-conformance.e2e.test.ts` should run
 * against `SearchService` as well: each names the exact result SET (order is not
 * part of conformance). Relative `updated:` cases are absent on purpose — they
 * depend on the clock, which the server run does not inject; the absolute forms
 * exercise the same interval logic.
 */
const CONFORMANCE: { q: string; viewer?: Viewer; expect: string[]; note: string }[] = [
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

describe('InMemorySearchProvider: author:, updated:, is:', () => {
  let provider: InMemorySearchProvider;
  beforeAll(async () => {
    provider = await makeProvider();
  });

  for (const { q, viewer, expect: expected, note } of CONFORMANCE) {
    it(`selects exactly the expected items for \`${q}\` (${note})`, async () => {
      const selected = ids(await provider.query({ q, limit: 100 }, viewer ?? ANON)).sort();
      expect(selected).toEqual([...expected].sort());
    });
  }

  it('counts every published item as verified except the unverified metric', async () => {
    const verified = ids(await provider.query({ q: 'is:verified', limit: 100 }, ANON)).sort();
    expect(verified).toEqual(PUBLISHED.filter((id) => id !== 'metric-weekly-deploy-frequency').sort());
    expect(ids(await provider.query({ q: 'is:published', limit: 100 }, ADMIN)).sort()).toEqual([...PUBLISHED].sort());
  });

  it('counts relative updated: windows back from the injected clock', async () => {
    expect(ids(await provider.query({ q: 'updated:7d' }, ANON))).toEqual(['metric-weekly-deploy-frequency']);
    expect(ids(await provider.query({ q: 'updated:30d' }, ANON))).toEqual([
      'metric-weekly-deploy-frequency',
      'troubleshoot-docker-build-cache',
      'guide-github-actions-ci',
      'guide-sensor-gateway-onboarding',
    ]);
    // The same query three weeks later selects less: the window moved, the data did not.
    const later = new InMemorySearchProvider({ now: () => new Date('2026-09-25T00:00:00.000Z') });
    for (const doc of CORPUS) await later.index(doc);
    expect(ids(await later.query({ q: 'updated:30d' }, ANON))).toEqual(['metric-weekly-deploy-frequency']);
  });

  it('ignores an unreadable updated: or is: value instead of returning nothing', async () => {
    const unfiltered = ids(await provider.query({ q: 'kubectl' }, ANON)).sort();
    expect(ids(await provider.query({ q: 'kubectl updated:soon' }, ANON)).sort()).toEqual(unfiltered);
    expect(ids(await provider.query({ q: 'kubectl is:superseded' }, ANON)).sort()).toEqual(unfiltered);
  });

  it('sorts by verified: most recently verified first, never-verified items last', async () => {
    expect(ids(await provider.query({ space: 'platform', sort: 'verified' }, ANON))).toEqual([
      'troubleshoot-docker-build-cache',
      'guide-github-actions-ci',
      'troubleshoot-node-heap-oom',
      'faq-vpn-access',
      'blog-prisma-to-kysely',
      'blog-sqlite-fts5-search',
      'guide-jenkins-pipelines',
      'metric-weekly-deploy-frequency',
    ]);
    // Newer but unverified still sorts below an older verified item.
    expect(ids(await provider.query({ q: 'tag:postgres', sort: 'verified' }, ADMIN))).toEqual([
      'runbook-postgres-failover',
      'adr-postgres-cloud-edition',
    ]);
    expect(ids(await provider.query({ q: 'tag:postgres', sort: 'newest' }, ADMIN))).toEqual([
      'adr-postgres-cloud-edition',
      'runbook-postgres-failover',
    ]);
  });

  it('ranks the acronym-titled page first and applies the identifier boost only to identifier-like terms', async () => {
    const upper = await provider.query({ q: 'MQTT' }, ANON);
    const lower = await provider.query({ q: 'mqtt' }, ANON);
    expect(ids(upper)[0]).toBe('reference-mqtt-topic-hierarchy');
    expect(ids(lower)[0]).toBe('reference-mqtt-topic-hierarchy');

    const score = (hits: SearchHit[], id: string) => hits.find((hit) => hit.id === id)!.score;
    // Title and tags multiplied for `MQTT`, not for `mqtt`...
    expect(score(upper, 'reference-mqtt-topic-hierarchy')).toBeGreaterThan(score(lower, 'reference-mqtt-topic-hierarchy'));
    // ...and prose never: the gateway guide only mentions it in description and body.
    expect(score(upper, 'guide-sensor-gateway-onboarding')).toBe(score(lower, 'guide-sensor-gateway-onboarding'));
  });

  it('carries authors and last_verified_at through to the hit', async () => {
    const [hit] = await provider.query({ q: 'author:"Ada Lovelace"' }, ANON);
    expect(hit).toMatchObject({ id: 'reference-mqtt-topic-hierarchy', last_verified_at: '2026-06-20T09:00:00Z' });
    expect((hit as SearchHit & { authors?: string[] }).authors).toEqual(['Ada Lovelace', 'Charles Babbage']);
  });

  it('keeps explicit query fields and parsed item filters independent', async () => {
    const query: SearchQuery = { q: 'is:verified', type: 'Guide' };
    expect(ids(await provider.query(query, ANON)).sort()).toEqual([
      'guide-github-actions-ci',
      'guide-jenkins-pipelines',
      'guide-sensor-gateway-onboarding',
    ]);
  });
});
