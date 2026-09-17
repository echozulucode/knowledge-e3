import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@echozedlabs/knowledge-types';
import { applyLifecyclePolicy } from '../src/lifecycle-policy.js';

function hit(id: string, score: number, over: Partial<SearchHit> = {}): SearchHit {
  return { id, slug: id, title: id, status: 'published', type: null, space_id: null, updated_at: '2026-09-01T00:00:00Z', score, ...over };
}

describe('applyLifecyclePolicy', () => {
  it('leaves stable, human-authored hits untouched', () => {
    const input = hit('a', 10, { display_state: 'published', trust_tier: 'human-reviewed' });
    const [out] = applyLifecyclePolicy([input]);
    expect(out).toBe(input);
    expect(out!.reasons).toBeUndefined();
  });

  it('demotes stale hits by 0.85 and says why', () => {
    const [flagged] = applyLifecyclePolicy([hit('a', 10, { stale: true })]);
    const [needsReview] = applyLifecyclePolicy([hit('b', 10, { display_state: 'needs-review' })]);

    expect(flagged!.score).toBeCloseTo(8.5);
    expect(flagged!.reasons).toEqual(['Stale (needs review): score ×0.85']);
    expect(needsReview!.score).toBeCloseTo(8.5);
  });

  it('demotes superseded, archived, and deprecated hits by 0.6 and names the successor', () => {
    const [superseded, archived, deprecated] = applyLifecyclePolicy([
      hit('s', 10, { display_state: 'superseded', superseded_by: 'new-guide' }),
      hit('a', 10, { display_state: 'archived' }),
      hit('d', 10, { lifecycle_status: 'deprecated' }),
    ]);

    expect(superseded!.score).toBeCloseTo(6);
    expect(superseded!.reasons).toEqual(['Superseded by new-guide: score ×0.6']);
    expect(archived!.reasons).toEqual(['Archived: score ×0.6']);
    expect(deprecated!.reasons).toEqual(['Deprecated: score ×0.6']);
  });

  it('does not stack the stale demotion on a deprecated hit', () => {
    const [out] = applyLifecyclePolicy([hit('a', 10, { lifecycle_status: 'deprecated', stale: true })]);
    expect(out!.score).toBeCloseTo(6);
    expect(out!.reasons).toHaveLength(1);
  });

  it('demotes machine-generated unverified hits by 0.9 for process: and agent: actors only', () => {
    const out = applyLifecyclePolicy([
      hit('p', 10, { generated_by: 'process:nightly', trust_tier: 'unverified' }),
      hit('g', 10, { generated_by: 'agent:claude', trust_tier: 'unverified' }),
      hit('h', 10, { generated_by: 'human:jdoe', trust_tier: 'unverified' }),
      hit('v', 10, { generated_by: 'process:nightly', trust_tier: 'machine-confirmed' }),
    ]);
    const byId = (id: string) => out.find((h) => h.id === id);
    const [process, agent, human, verified] = [byId('p'), byId('g'), byId('h'), byId('v')];

    expect(out.map((h) => h.id)).toEqual(['h', 'v', 'p', 'g']);
    expect(human!.score).toBe(10);
    expect(verified!.score).toBe(10);
    expect(process!.score).toBeCloseTo(9);
    expect(process!.reasons).toEqual(['Machine-generated, unverified (process:nightly): score ×0.9']);
    expect(agent!.score).toBeCloseTo(9);
  });

  it('compounds the machine demotion with a lifecycle demotion', () => {
    const [out] = applyLifecyclePolicy([hit('a', 10, { stale: true, generated_by: 'process:x', trust_tier: 'unverified' })]);
    expect(out!.score).toBeCloseTo(10 * 0.85 * 0.9);
    expect(out!.reasons).toHaveLength(2);
  });

  it('accepts custom factors', () => {
    const [out] = applyLifecyclePolicy([hit('a', 10, { stale: true })], { staleFactor: 0.5 });
    expect(out!.score).toBeCloseTo(5);
    expect(out!.reasons).toEqual(['Stale (needs review): score ×0.5']);
  });

  it('appends to existing reasons and does not mutate the input', () => {
    const input = hit('a', 10, { stale: true, reasons: ['Title match'] });
    const [out] = applyLifecyclePolicy([input]);

    expect(out!.reasons).toEqual(['Title match', 'Stale (needs review): score ×0.85']);
    expect(input.score).toBe(10);
    expect(input.reasons).toEqual(['Title match']);
  });

  it('re-sorts by score descending and keeps the incoming order for ties', () => {
    const out = applyLifecyclePolicy([
      hit('stale-top', 10, { stale: true }),
      hit('second', 9),
      hit('third', 9),
      hit('deprecated', 8.6, { lifecycle_status: 'deprecated' }),
    ]);

    expect(out.map((h) => h.id)).toEqual(['second', 'third', 'stale-top', 'deprecated']);
  });
});
