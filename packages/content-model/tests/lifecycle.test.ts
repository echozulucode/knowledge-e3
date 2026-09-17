import { describe, it, expect } from 'vitest';
import { reviewHorizonDays, deriveDisplayState } from '../src/lifecycle.js';

describe('reviewHorizonDays', () => {
  it.each([
    ['How-To', 365],
    ['concept', 365],
    ['Glossary Term', 365],
    ['architecture-note', 365],
    ['Runbook', 180],
    ['Troubleshooting Guide', 180],
    ['faq', 180],
    ['Known Issue', 90],
    ['Blog Post', null],
    ['Release Note', null],
    ['ADR', null],
    ['Series', null],
    ['Custom Kind', null],
    ['', null],
  ])('%s → %s', (type, days) => {
    expect(reviewHorizonDays(type)).toBe(days);
  });
});

describe('deriveDisplayState', () => {
  const fresh = { title: 'X', stale_after: '2030-01-01' };

  it('draft publication ⇒ draft, regardless of staleness', () => {
    const r = deriveDisplayState({ ...fresh, stale_after: '2020-01-01' }, 'draft', '2026-09-06');
    expect(r.display_state).toBe('draft');
    expect(r.lifecycle_status).toBe('draft');
    expect(r.stale).toBe(true);
  });

  it('published and fresh ⇒ published', () => {
    const r = deriveDisplayState(fresh, 'published', '2026-09-06');
    expect(r).toEqual({
      display_state: 'published',
      lifecycle_status: 'stable',
      trust_tier: 'unverified',
      stale: false,
      stale_after: '2030-01-01',
      last_verified_at: null,
      generated_by: null,
      superseded_by: null,
    });
  });

  it('published and past stale_after ⇒ needs-review (time travel with now)', () => {
    expect(deriveDisplayState(fresh, 'published', '2029-12-31').display_state).toBe('published');
    expect(deriveDisplayState(fresh, 'published', '2030-01-01').display_state).toBe('needs-review');
    expect(deriveDisplayState(fresh, 'published', new Date('2031-06-01')).display_state).toBe('needs-review');
  });

  it('deprecated with a successor ⇒ superseded (superseded_by, then replaced_by)', () => {
    const a = deriveDisplayState({ status: 'deprecated', superseded_by: 'new-page' }, 'published');
    expect(a.display_state).toBe('superseded');
    expect(a.superseded_by).toBe('new-page');
    const b = deriveDisplayState({ status: 'Deprecated', replaced_by: 'other' }, 'published');
    expect(b.display_state).toBe('superseded');
    expect(b.superseded_by).toBe('other');
  });

  it('deprecated without a successor ⇒ archived, even when stale', () => {
    const r = deriveDisplayState({ status: 'deprecated', stale_after: '2000-01-01' }, 'published', '2026-09-06');
    expect(r.display_state).toBe('archived');
    expect(r.lifecycle_status).toBe('deprecated');
  });

  it('carries trust, verification and provenance signals', () => {
    const r = deriveDisplayState(
      {
        status: 'published',
        verified: [{ by: 'human:eric', at: '2026-08-01T00:00:00Z' }],
        generated: { by: 'process:claude-code/1.0' },
        stale_after: new Date('2027-01-01T00:00:00Z'),
      },
      'published',
      '2026-09-06',
    );
    expect(r.lifecycle_status).toBe('stable'); // E3 "published" is not an OKF lifecycle value
    expect(r.trust_tier).toBe('human-reviewed');
    expect(r.last_verified_at).toBe('2026-08-01T00:00:00Z');
    expect(r.generated_by).toBe('process:claude-code/1.0');
    expect(r.stale_after).toBe('2027-01-01');
  });
});
