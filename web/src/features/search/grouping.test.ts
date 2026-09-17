import { describe, expect, it } from 'vitest';
import { displayStateForHit, flattenGroups, groupByType, reviewUrlForHit } from './grouping.js';

const openReview = { state: 'open', url: 'https://github.com/acme/kb/pull/12', branch: 'e3/x-1', opened_at: null, closed_at: null } as const;
const mergedReview = { ...openReview, state: 'merged' } as const;

describe('displayStateForHit', () => {
  it('maps a stale hit to needs-review', () => {
    expect(displayStateForHit({ stale: true })).toBe('needs-review');
  });

  it('gives fresh or unknown hits no badge', () => {
    expect(displayStateForHit({ stale: false })).toBeNull();
    expect(displayStateForHit({})).toBeNull();
  });

  it('lets an open change request win over the freshness label', () => {
    expect(displayStateForHit({ review: openReview })).toBe('in-review');
    expect(displayStateForHit({ stale: true, review: openReview })).toBe('in-review');
  });

  it('says Draft for a draft, ahead of staleness but behind an open change request', () => {
    expect(displayStateForHit({ status: 'draft' })).toBe('draft');
    expect(displayStateForHit({ status: 'draft', stale: true })).toBe('draft');
    expect(displayStateForHit({ status: 'draft', review: openReview })).toBe('in-review');
  });

  it('gives a plain published hit no chip, and honours a spoken display_state when one is sent', () => {
    expect(displayStateForHit({ status: 'published' })).toBeNull();
    expect(displayStateForHit({ status: 'published', display_state: 'published' })).toBeNull();
    expect(displayStateForHit({ status: 'published', display_state: 'superseded' })).toBe('superseded');
    expect(displayStateForHit({ display_state: 'archived', stale: true })).toBe('archived');
  });

  it('ignores a settled change request', () => {
    expect(displayStateForHit({ review: mergedReview })).toBeNull();
    expect(displayStateForHit({ stale: true, review: mergedReview })).toBe('needs-review');
  });
});

describe('reviewUrlForHit', () => {
  it('links only while the change request is open', () => {
    expect(reviewUrlForHit({ review: openReview })).toBe('https://github.com/acme/kb/pull/12');
    expect(reviewUrlForHit({ review: mergedReview })).toBeNull();
    expect(reviewUrlForHit({})).toBeNull();
  });
});

describe('flattenGroups', () => {
  it('walks groups in visual order and records where each group starts', () => {
    const groups = [
      { label: 'Runbook', hits: ['r1', 'r2'] },
      { label: 'Concept', hits: ['c1'] },
      { label: 'FAQ', hits: ['f1', 'f2', 'f3'] },
    ];
    expect(flattenGroups(groups)).toEqual({ flat: ['r1', 'r2', 'c1', 'f1', 'f2', 'f3'], starts: [0, 2, 3] });
  });

  it('handles empty groups without skipping the start index', () => {
    expect(flattenGroups([{ hits: [] }, { hits: ['a'] }])).toEqual({ flat: ['a'], starts: [0, 0] });
    expect(flattenGroups([])).toEqual({ flat: [], starts: [] });
  });
});

describe('groupByType', () => {
  it('keeps first-seen group order and ranked order within a group, counting the uncapped total', () => {
    const items = [
      { id: 1, type: 'Runbook' },
      { id: 2, type: 'Concept' },
      { id: 3, type: 'Runbook' },
      { id: 4, type: 'Runbook' },
      { id: 5, type: null },
    ];
    expect(groupByType(items, 2)).toEqual([
      { key: 'Runbook', label: 'Runbook', hits: [items[0], items[2]], total: 3 },
      { key: 'Concept', label: 'Concept', hits: [items[1]], total: 1 },
      { key: 'Untyped', label: 'Untyped', hits: [items[4]], total: 1 },
    ]);
  });
});
