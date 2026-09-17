import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySearchProvider } from '../src/in-memory-provider.js';
import { evaluate, loadEvalCases } from '../src/eval.js';
import { CORPUS } from './fixtures/corpus.js';

const QUERIES = fileURLToPath(new URL('../eval/queries.yaml', import.meta.url));

async function makeProvider(): Promise<InMemorySearchProvider> {
  const provider = new InMemorySearchProvider();
  for (const doc of CORPUS) await provider.index(doc);
  return provider;
}

describe('eval harness', () => {
  it('passes every sample query on the fixture corpus at k=3', async () => {
    const cases = await loadEvalCases(QUERIES);
    expect(cases.length).toBeGreaterThanOrEqual(6);

    const report = await evaluate(cases, await makeProvider(), { k: 3 });
    const misses = report.cases.filter((c) => !c.hit).map((c) => `${c.query} -> [${c.returned.join(', ')}]`);

    expect(misses).toEqual([]);
    expect(report.k).toBe(3);
    expect(report.total).toBe(cases.length);
    expect(report.passed).toBe(cases.length);
    expect(report.successRate).toBe(1);
    expect(report.cases.every((c) => c.ranks.every((r) => r.rank !== null && r.rank <= 3))).toBe(true);
  });

  it('reports the rank of each expected id and counts a case as a miss when any is absent', async () => {
    const report = await evaluate(
      [{ query: 'docker', expect: ['troubleshoot-docker-build-cache', 'faq-vpn-access'], note: 'deliberate miss' }],
      await makeProvider(),
      { k: 2 },
    );

    expect(report.successRate).toBe(0);
    expect(report.cases[0]).toMatchObject({
      hit: false,
      note: 'deliberate miss',
      ranks: [
        { id: 'troubleshoot-docker-build-cache', rank: 1 },
        { id: 'faq-vpn-access', rank: null },
      ],
    });
    expect(report.cases[0]!.returned).toHaveLength(2);
  });

  it('holds a case with `top` to its own stricter cutoff, and carries its id into the report', async () => {
    const provider = await makeProvider();
    // `docker` ranks the build-cache page first and the CI guide lower down.
    const report = await evaluate(
      [
        { id: 'first', query: 'docker', expect: ['troubleshoot-docker-build-cache'], top: 1 },
        { id: 'not-first', query: 'docker', expect: ['guide-github-actions-ci'], top: 1 },
        { id: 'top-above-k', query: 'docker', expect: ['guide-github-actions-ci'], top: 10 },
      ],
      provider,
      { k: 3 },
    );
    expect(report.cases.map((c) => [c.id, c.hit])).toEqual([
      ['first', true],
      ['not-first', false],
      ['top-above-k', true],
    ]);
    // The rank is still reported for a case that missed its cutoff, so the failure explains itself.
    expect(report.cases[1]!.ranks[0]!.rank).toBeGreaterThan(1);
  });

  it('names every case in queries.yaml that exercises the identifier boost, the new filters or a prefix', async () => {
    const cases = await loadEvalCases(QUERIES);
    expect(cases.filter((c) => c.id).map((c) => c.id)).toEqual([
      'identifier-acronym-title',
      'prefix-plain-trailing',
      'prefix-identifier-trailing',
      'author-exact-name',
      'author-single-field-any-case',
      'updated-year',
      'updated-after-month',
      'is-verified-machine-confirmed',
      'is-unverified',
      'is-needs-review',
    ]);
  });

  it('scores an empty case list as 0 so a missing eval set never reads as green', async () => {
    const report = await evaluate([], await makeProvider());
    expect(report).toMatchObject({ k: 5, total: 0, passed: 0, successRate: 0, cases: [] });
  });

  it('rejects a malformed queries file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-eval-'));

    const noCases = join(dir, 'no-cases.yaml');
    await writeFile(noCases, 'queries: []\n');
    await expect(loadEvalCases(noCases)).rejects.toThrow('expected a top-level `cases` list');

    const emptyExpect = join(dir, 'empty-expect.yaml');
    await writeFile(emptyExpect, 'cases:\n  - query: docker\n    expect: []\n');
    await expect(loadEvalCases(emptyExpect)).rejects.toThrow('case 1 needs a non-empty `expect`');

    const duplicateId = join(dir, 'duplicate-id.yaml');
    await writeFile(duplicateId, 'cases:\n  - id: a\n    query: docker\n    expect: [x]\n  - id: a\n    query: vpn\n    expect: [y]\n');
    await expect(loadEvalCases(duplicateId)).rejects.toThrow('case id `a` is used twice');

    const badTop = join(dir, 'bad-top.yaml');
    await writeFile(badTop, 'cases:\n  - query: docker\n    expect: [x]\n    top: 0\n');
    await expect(loadEvalCases(badTop)).rejects.toThrow('case 1 needs `top` to be a positive integer');
  });
});
