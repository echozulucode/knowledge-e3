import { describe, expect, it } from 'vitest';
import { overviewChips, overviewItemMeta, overviewTopics } from './overviewModel.js';

const now = new Date('2026-09-13T12:00:00Z');

describe('overviewTopics', () => {
  const known = [
    { id: 't1', slug: 'architecture', name: 'Architecture' },
    { id: 't2', slug: 'plat-svc', name: 'Platform Service' },
  ];

  it('links a topic by slug when the directory knows it, by name or by slug', () => {
    expect(
      overviewTopics(
        [
          { value: 'architecture', label: 'Architecture', count: 12 },
          { value: 'platform service', label: 'Platform Service', count: 4 },
        ],
        known,
      ),
    ).toEqual([
      { label: 'Architecture', count: 12, searchValue: 'architecture', slug: 'architecture' },
      { label: 'Platform Service', count: 4, searchValue: 'plat-svc', slug: 'plat-svc' },
    ]);
  });

  it('keeps the search link but no page link for a topic it cannot resolve', () => {
    expect(overviewTopics([{ value: 'mystery', label: 'Mystery', count: 1 }], known)).toEqual([
      { label: 'Mystery', count: 1, searchValue: 'Mystery', slug: null },
    ]);
  });
});

describe('overviewItemMeta', () => {
  it('names the topic and the date the list is ordered by', () => {
    const item = { topic: 'architecture', topic_name: 'Architecture', updated_at: '2026-09-01T12:00:00Z', last_verified_at: '2026-09-08T12:00:00Z' };
    expect(overviewItemMeta(item, 'verified', { now, locale: 'en-US' })).toEqual(['Architecture', 'Verified Sep 8']);
    expect(overviewItemMeta(item, 'updated', { now, locale: 'en-US' })).toEqual(['Architecture', 'Updated Sep 1']);
  });

  it('falls back to the slug and to a labelled update date', () => {
    expect(overviewItemMeta({ topic: 'ops', updated_at: '2025-01-02T12:00:00Z', last_verified_at: null }, 'verified', { now, locale: 'en-US' })).toEqual([
      'ops',
      'Updated Jan 2, 2025',
    ]);
    expect(overviewItemMeta({ updated_at: 'not a date' }, 'updated', { now })).toEqual([]);
  });
});

describe('overviewChips', () => {
  it('drops blank and empty values and orders by count', () => {
    expect(
      overviewChips([
        { value: 'a', label: 'A', count: 1 },
        { value: 'b', label: 'B', count: 5 },
        { value: '', label: ' ', count: 9 },
        { value: 'c', label: 'C', count: 0 },
      ]).map((chip) => chip.label),
    ).toEqual(['B', 'A']);
  });
});
