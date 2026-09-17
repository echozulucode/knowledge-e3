import { beforeAll, describe, expect, it } from 'vitest';
import type { SearchHit, Viewer } from '@echozedlabs/knowledge-types';
import { InMemorySearchProvider, tokenize } from '../src/in-memory-provider.js';
import { CORPUS } from './fixtures/corpus.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };
const USER: Viewer = { userId: 'u1', role: 'user' };
const ADMIN: Viewer = { userId: 'admin', role: 'admin' };

async function makeProvider(): Promise<InMemorySearchProvider> {
  const provider = new InMemorySearchProvider();
  for (const doc of CORPUS) await provider.index(doc);
  return provider;
}

const ids = (hits: SearchHit[]): string[] => hits.map((hit) => hit.id);

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops single-character tokens', () => {
    expect(tokenize('Node.js "heap" a --max-old-space-size=4096')).toEqual(['node', 'js', 'heap', 'max', 'old', 'space', 'size', '4096']);
  });
});

describe('InMemorySearchProvider', () => {
  let provider: InMemorySearchProvider;
  beforeAll(async () => {
    provider = await makeProvider();
  });

  it('ranks title matches first and reports matched fields and a score', async () => {
    const hits = await provider.query({ q: 'docker' }, ANON);

    expect(hits[0]!.id).toBe('troubleshoot-docker-build-cache');
    expect(hits[0]!.matched_fields).toEqual(['title', 'tags', 'body']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(ids(hits)).toContain('guide-github-actions-ci');
    expect(hits[0]).not.toHaveProperty('body_text');
  });

  it('returns nothing when no document matches', async () => {
    expect(await provider.query({ q: 'zzzqux' }, ANON)).toEqual([]);
  });

  it('hides drafts unless the viewer is admin or include_drafts is set', async () => {
    expect(ids(await provider.query({ q: 'postgres' }, ANON))).not.toContain('adr-postgres-cloud-edition');
    expect(ids(await provider.query({ q: 'postgres' }, USER))).not.toContain('adr-postgres-cloud-edition');
    expect(ids(await provider.query({ q: 'postgres' }, ADMIN))).toContain('adr-postgres-cloud-edition');
    expect(ids(await provider.query({ q: 'postgres', include_drafts: true }, ANON))).toContain('adr-postgres-cloud-edition');
  });

  it('applies parsed tag: filters, with explicit query fields taking precedence', async () => {
    expect(ids(await provider.query({ q: 'ci tag:jenkins' }, ANON))).toEqual(['guide-jenkins-pipelines']);
    expect(ids(await provider.query({ q: 'ci tag:jenkins', tag: 'github-actions' }, ANON))).toEqual(['guide-github-actions-ci']);
  });

  it('filters by space, category, group, type, status, and since', async () => {
    // No free-text signal: every document that passes the filters, newest first.
    expect(ids(await provider.query({ space: 'sre' }, ANON))).toEqual([
      'runbook-kubernetes-node-drain',
      'runbook-postgres-failover',
      'runbook-tls-cert-renewal',
    ]);
    // `topic:` and `space:` are one axis: repeating it ORs, never drops all
    // but the first value (reader UX plan §5.2).
    const sre = ids(await provider.query({ space: 'sre' }, ANON));
    const platform = ids(await provider.query({ space: 'platform' }, ANON));
    expect(ids(await provider.query({ q: 'space:sre topic:platform' }, ANON)).sort()).toEqual(
      [...sre, ...platform].sort(),
    );
    expect(ids(await provider.query({ category: 'operations' }, ANON))).toHaveLength(3);
    expect(ids(await provider.query({ group: 'platform-eng' }, ANON)).sort()).toEqual(['guide-github-actions-ci', 'troubleshoot-docker-build-cache']);
    expect(ids(await provider.query({ type: 'runbook' }, ANON))).toHaveLength(3);
    expect(ids(await provider.query({ status: 'draft' }, ANON))).toEqual([]);
    expect(ids(await provider.query({ status: 'draft' }, ADMIN))).toEqual(['adr-postgres-cloud-edition']);
    expect(ids(await provider.query({ q: 'status:draft' }, ADMIN))).toEqual(['adr-postgres-cloud-edition']);
    expect(ids(await provider.query({ since: '2026-08-15T00:00:00Z' }, ANON))).toEqual([
      'metric-weekly-deploy-frequency',
      'troubleshoot-docker-build-cache',
      'guide-github-actions-ci',
    ]);
  });

  it('drops documents that contain an excluded term', async () => {
    const hits = ids(await provider.query({ q: 'ci -jenkins' }, ANON));
    expect(hits).toContain('guide-github-actions-ci');
    expect(hits).not.toContain('guide-jenkins-pipelines');
  });

  it('matches quoted phrases verbatim', async () => {
    expect(ids(await provider.query({ q: '"pg_ctl promote"' }, ANON))).toEqual(['runbook-postgres-failover']);
    expect(ids(await provider.query({ q: '"promote pg_ctl"' }, ANON))).toEqual([]);
  });

  it('sorts by newest, oldest, and title when asked', async () => {
    const newest = ['runbook-kubernetes-node-drain', 'runbook-postgres-failover', 'runbook-tls-cert-renewal'];
    expect(ids(await provider.query({ q: 'runbook', sort: 'newest' }, ANON))).toEqual(newest);
    expect(ids(await provider.query({ q: 'runbook', sort: 'oldest' }, ANON))).toEqual([...newest].reverse());
    expect(ids(await provider.query({ q: 'runbook', sort: 'az' }, ANON))).toEqual([
      'runbook-kubernetes-node-drain',
      'runbook-postgres-failover',
      'runbook-tls-cert-renewal',
    ]);
  });

  it('applies limit and offset to the ranked list', async () => {
    const all = ids(await provider.query({ q: 'runbook' }, ANON));
    expect(all).toHaveLength(3);
    expect(ids(await provider.query({ q: 'runbook', limit: 2 }, ANON))).toEqual(all.slice(0, 2));
    expect(ids(await provider.query({ q: 'runbook', limit: 2, offset: 2 }, ANON))).toEqual(all.slice(2));
  });

  it('builds a snippet around the first body match', async () => {
    const [hit] = await provider.query({ q: 'promote' }, ANON);

    expect(hit!.id).toBe('runbook-postgres-failover');
    expect(hit!.snippet).toContain('Step 2: promote the replica with pg_ctl promote');
    expect(hit!.snippet!.startsWith('…')).toBe(true);
    expect(hit!.snippet!.endsWith('…')).toBe(true);
  });

  it('falls back to the opening of the body when only the description matched', async () => {
    const [hit] = await provider.query({ q: 'orm' }, ANON);

    expect(hit!.id).toBe('blog-prisma-to-kysely');
    expect(hit!.matched_fields).toEqual(['description']);
    expect(hit!.snippet!.startsWith('Prisma served us well')).toBe(true);
    expect(hit!.snippet!.endsWith('…')).toBe(true);
  });

  it('ORs repeated filter values and ANDs across keys', async () => {
    expect(ids(await provider.query({ q: 'tag:kubernetes tag:postgres' }, ANON)).sort()).toEqual([
      'runbook-kubernetes-node-drain',
      'runbook-postgres-failover',
      'runbook-tls-cert-renewal',
    ]);
    expect(ids(await provider.query({ q: 'tag:kubernetes category:operations' }, ANON)).sort()).toEqual([
      'runbook-kubernetes-node-drain',
      'runbook-tls-cert-renewal',
    ]);
  });

  it('applies type: from the query text, case-insensitively', async () => {
    expect(ids(await provider.query({ q: 'type:runbook' }, ANON))).toHaveLength(3);
    expect(ids(await provider.query({ q: 'type:Runbook type:FAQ' }, ANON))).toHaveLength(4);
  });

  it('excludes a filter value with -key:value', async () => {
    const kept = ids(await provider.query({ q: 'ci -tag:jenkins' }, ANON));
    expect(kept).toContain('guide-github-actions-ci');
    expect(kept).not.toContain('guide-jenkins-pipelines');
    expect(ids(await provider.query({ q: 'category:operations -tag:postgres' }, ANON)).sort()).toEqual([
      'runbook-kubernetes-node-drain',
      'runbook-tls-cert-renewal',
    ]);
  });

  it('excludes a quoted phrase as a phrase, not as its separate words', async () => {
    const kept = ids(await provider.query({ q: 'kubectl -"pod disruption budgets"' }, ANON));
    expect(kept).toContain('runbook-tls-cert-renewal');
    expect(kept).not.toContain('runbook-kubernetes-node-drain');
  });

  it('matches the trailing word as a prefix, and scores it below the finished word', async () => {
    expect(ids(await provider.query({ q: 'kube' }, ANON))).toContain('runbook-kubernetes-node-drain');
    expect(ids(await provider.query({ q: 'postgr' }, ANON))).toContain('runbook-postgres-failover');
    // A quoted phrase is never prefix-expanded.
    expect(ids(await provider.query({ q: '"kube"' }, ANON))).toEqual([]);

    const [prefixHit] = await provider.query({ q: 'kubernete' }, ANON);
    const [exactHit] = await provider.query({ q: 'kubernetes' }, ANON);
    expect(prefixHit!.id).toBe(exactHit!.id);
    expect(prefixHit!.score).toBeLessThan(exactHit!.score);
  });

  it('requires every term to be present, the same implicit AND FTS5 applies', async () => {
    // "cache" alone matches the Node heap page ("unbounded caches"); with
    // "docker" it must not, or a two-word query would widen the results.
    expect(ids(await provider.query({ q: 'cache' }, ANON))).toContain('troubleshoot-node-heap-oom');
    expect(ids(await provider.query({ q: 'docker cache' }, ANON))).not.toContain('troubleshoot-node-heap-oom');
  });

  it('remove() drops a document from the index', async () => {
    const own = await makeProvider();
    await own.remove('troubleshoot-docker-build-cache');
    expect(ids(await own.query({ q: 'docker' }, ANON))).not.toContain('troubleshoot-docker-build-cache');
  });
});
