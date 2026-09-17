import { describe, it, expect } from 'vitest';
import { trustTier, freshness, okfSignals, latestVerifiedAt, normalizeVerified } from '../src/trust.js';
import { auditBundle } from '../src/audit.js';

describe('trust tiers (§5.3)', () => {
  it('is unverified with no verified events', () => {
    expect(trustTier({ type: 'Metric' })).toBe('unverified');
  });

  it('is machine-confirmed when only non-human actors verified', () => {
    expect(trustTier({ verified: [{ by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' }] })).toBe(
      'machine-confirmed',
    );
  });

  it('is human-reviewed when any human actor verified', () => {
    expect(
      trustTier({
        verified: [
          { by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' },
          { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
        ],
      }),
    ).toBe('human-reviewed');
  });

  it('treats a bare verified mapping as a one-element list (§5.2)', () => {
    expect(normalizeVerified({ by: 'human:x', at: '2026-01-01T00:00:00Z' })).toHaveLength(1);
    expect(trustTier({ verified: { by: 'human:x', at: '2026-01-01T00:00:00Z' } })).toBe('human-reviewed');
  });

  it('returns the latest verification time', () => {
    expect(
      latestVerifiedAt({
        verified: [
          { by: 'human:a', at: '2026-06-25T09:00:00Z' },
          { by: 'process:p', at: '2026-06-26T02:00:00Z' },
        ],
      }),
    ).toBe('2026-06-26T02:00:00Z');
  });
});

describe('freshness (§5.5) is a pure asOf comparison', () => {
  it('is fresh before and stale on/after the date', () => {
    expect(freshness({ stale_after: '2026-09-23' }, '2026-09-22')).toBe('fresh');
    expect(freshness({ stale_after: '2026-09-23' }, '2026-09-23')).toBe('stale');
    expect(freshness({}, '2030-01-01')).toBe('fresh'); // no stale_after ⇒ never stale
  });
});

describe('okfSignals bundles the derived + raw signals', () => {
  it('collects tier, freshness, actors, sources', () => {
    const fm = {
      type: 'Metric',
      generated: { by: 'reference_agent/gemini-2.5-pro', at: '2026-06-20T22:53:05Z' },
      verified: [{ by: 'human:ericjzim', at: '2026-06-25T09:00:00Z' }],
      stale_after: '2026-09-23',
      sources: [{ id: 'p', resource: 'https://x' }],
    };
    const s = okfSignals(fm, '2026-10-01');
    expect(s.trustTier).toBe('human-reviewed');
    expect(s.freshness).toBe('stale');
    expect(s.generatedBy).toBe('reference_agent/gemini-2.5-pro');
    expect(s.verifiedBy).toEqual(['human:ericjzim']);
    expect(s.hasSources).toBe(true);
    expect(s.staleAfter).toBe('2026-09-23');
  });
});

describe('auditBundle three-tier split', () => {
  const bare = '---\ntype: Note\n---\n\nBody.\n';
  const rich =
    '---\ntype: Metric\ntitle: T\ndescription: d\ngenerated: { by: human:a, at: 2026-06-20T00:00:00Z }\nverified:\n  - { by: human:a, at: 2026-06-25T00:00:00Z }\nsources:\n  - { id: p, resource: https://x }\n---\n\nBody.\n';

  it('keeps a bare-but-valid concept conformant while raising advisories/policy', () => {
    const report = auditBundle({ files: [{ path: 'concepts/bare.md', content: bare }] });
    expect(report.conformant).toBe(true); // valid: has a type
    expect(report.policy.length).toBeGreaterThan(0); // missing title/description
    expect(report.advisories.some((a) => /Unverified/.test(a.message))).toBe(true);
    expect(report.advisories.some((a) => /No `sources`/.test(a.message))).toBe(true);
  });

  it('raises no advisories/policy for a fully-populated fresh concept', () => {
    const report = auditBundle(
      { files: [{ path: 'concepts/rich.md', content: rich }] },
      { asOf: '2026-07-01' },
    );
    expect(report.conformant).toBe(true);
    expect(report.policy).toHaveLength(0);
    expect(report.advisories).toHaveLength(0);
  });

  it('still rejects a concept with no type (conformance tier)', () => {
    const report = auditBundle({ files: [{ path: 'concepts/x.md', content: '---\ntitle: no type\n---\n\nb\n' }] });
    expect(report.conformant).toBe(false);
    expect(report.conformance.length).toBeGreaterThan(0);
  });
});
