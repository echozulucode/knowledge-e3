import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@echozedlabs/knowledge-types';
import { groupHits, toGroupedResults } from '../src/grouping.js';

function hit(id: string, type: string | null, score: number): SearchHit {
  return { id, slug: id, title: id, status: 'published', type, space_id: null, updated_at: '2026-09-01T00:00:00Z', score };
}

describe('groupHits', () => {
  it('groups by content type, keeps ranked order inside a group, and labels untyped hits', () => {
    const groups = groupHits([hit('a', 'Runbook', 9), hit('b', 'FAQ', 8), hit('c', 'Runbook', 7), hit('d', null, 6)]);

    expect(groups.map((g) => g.label)).toEqual(['Runbook', 'FAQ', 'Untyped']);
    expect(groups[0]!.hits.map((h) => h.id)).toEqual(['a', 'c']);
    expect(groups[0]!.key).toBe('Runbook');
    expect(groups[2]!.hits.map((h) => h.id)).toEqual(['d']);
  });

  it('caps hits per group at 5 by default while total keeps the full count', () => {
    const hits = Array.from({ length: 7 }, (_, i) => hit(`r${i}`, 'Runbook', 10 - i));
    const [group] = groupHits(hits);

    expect(group!.hits).toHaveLength(5);
    expect(group!.total).toBe(7);
    expect(group!.hits.map((h) => h.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('honours a custom cap', () => {
    const [group] = groupHits([hit('a', 'FAQ', 3), hit('b', 'FAQ', 2), hit('c', 'FAQ', 1)], { capPerGroup: 2 });
    expect(group!.hits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(group!.total).toBe(3);
  });

  it('orders groups by best hit score, with explicitly ordered labels first', () => {
    const hits = [hit('a', 'Blog Post', 5), hit('b', 'Runbook', 9), hit('c', 'FAQ', 7)];

    expect(groupHits(hits).map((g) => g.label)).toEqual(['Runbook', 'FAQ', 'Blog Post']);
    expect(groupHits(hits, { order: ['FAQ', 'Blog Post'] }).map((g) => g.label)).toEqual(['FAQ', 'Blog Post', 'Runbook']);
  });
});

describe('toGroupedResults', () => {
  it('carries the query and the ungrouped total', () => {
    const query = { q: 'docker', limit: 10 };
    const results = toGroupedResults(query, [hit('a', 'Runbook', 2), hit('b', 'FAQ', 1)], { capPerGroup: 1 });

    expect(results.query).toBe(query);
    expect(results.total).toBe(2);
    expect(results.groups).toHaveLength(2);
  });
});
