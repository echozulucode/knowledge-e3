import { describe, it, expect } from 'vitest';
import { extractClaims, scoreClaimHealth, sourceIdsOf, type ClaimGrounding } from '../src/claims.js';

const CONCEPT = `---
type: Metric
title: Revenue
sources:
  - { id: rev-policy, resource: https://x/policy }
stale_after: 2027-01-01
---

# Definition

Recognized revenue sums amount over rows booked to the fiscal year.[^rev-policy]
This second sentence has no citation and should read as unverified.

# Notes

- a list item is ignored
`;

describe('extractClaims', () => {
  it('pulls prose sentences and records their footnote citations', () => {
    const claims = extractClaims(
      'Revenue is recognized on delivery per policy.[^rev-policy]\nAnother uncited sentence about the schema here.',
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]!.citedSourceIds).toEqual(['rev-policy']);
    expect(claims[0]!.text).not.toContain('[^');
    expect(claims[1]!.citedSourceIds).toEqual([]);
  });

  it('ignores headings, list items, and code', () => {
    const claims = extractClaims('# Heading\n\n- a bullet point that is long enough to count\n\n```\ncode line here\n```');
    expect(claims).toHaveLength(0);
  });
});

describe('sourceIdsOf', () => {
  it('collects declared source ids', () => {
    expect(sourceIdsOf({ sources: [{ id: 'a', resource: 'x' }, { id: 'b', resource: 'y' }] })).toEqual(
      new Set(['a', 'b']),
    );
  });
});

describe('scoreClaimHealth (deterministic citation baseline)', () => {
  it('marks a cited claim supported and an uncited claim unverified', () => {
    const h = scoreClaimHealth(CONCEPT, { asOf: '2026-01-01' });
    expect(h.total).toBe(2);
    expect(h.supported).toBe(1);
    expect(h.unverified).toBe(1);
    expect(h.hallucinated).toBe(0);
    expect(h.score).toBeCloseTo(0.5);
  });

  it('reports a supported claim as stale once past stale_after', () => {
    const h = scoreClaimHealth(CONCEPT, { asOf: '2028-01-01' });
    expect(h.stale).toBe(1);
    expect(h.supported).toBe(0);
  });

  it('a grounding that reads sources can flag hallucinations', () => {
    const alwaysHallucinated: ClaimGrounding = { ground: () => 'hallucinated' };
    const h = scoreClaimHealth(CONCEPT, { grounding: alwaysHallucinated });
    expect(h.hallucinated).toBe(2);
    expect(h.score).toBe(0);
  });

  it('scores an empty body as perfectly healthy (no claims)', () => {
    const h = scoreClaimHealth('---\ntype: Note\n---\n\n# Only a heading\n');
    expect(h.total).toBe(0);
    expect(h.score).toBe(1);
  });
});
