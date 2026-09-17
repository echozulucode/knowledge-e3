import { describe, it, expect } from 'vitest';
import { suggestMetadata } from '../src/suggest.js';

const TROUBLESHOOTING_BODY = `---
title: Login loops back to the sign-in page
---

## Symptom

Users are bounced back to sign-in after entering valid credentials.

## Quick checks

- Cookie domain matches.

## Likely causes

Session cookie rejected.

## Fix

Set the cookie domain.

## Verification

Sign in once.
`;

describe('suggestMetadata', () => {
  it('detects a Troubleshooting Guide from its H2 headings', () => {
    const s = suggestMetadata(TROUBLESHOOTING_BODY);
    expect(s.type).toBe('Troubleshooting Guide');
    expect(s.types[0]).toEqual({ label: 'Troubleshooting Guide', score: expect.closeTo(5 / 9, 5) });
    expect(s.types).toHaveLength(12);
    expect(s.duplicate_title).toBe(false);
  });

  it('is deterministic and gives a declared known type a +0.5 boost', () => {
    const raw = '---\ntype: faq\n---\n\n## Symptom\n\nx\n';
    const a = suggestMetadata(raw);
    expect(a).toEqual(suggestMetadata(raw));
    expect(a.type).toBe('FAQ');
    expect(a.types[0]!.score).toBe(0.5);
  });

  it('returns no type when nothing overlaps', () => {
    const s = suggestMetadata('# Just a title\n\nprose\n');
    expect(s.type).toBeUndefined();
    expect(s.types.every((t) => t.score === 0)).toBe(true);
  });

  it('ranks tags and categories by frequency, filtered to the known vocabulary, top 5', () => {
    const similar = [
      { title: 'A', tags: ['auth', 'sso', 'cookies'], categories: ['How-to'] },
      { title: 'B', tags: ['auth', 'cookies'], categories: ['Reference'] },
      { title: 'C', tags: ['auth', 'sso', 'x1', 'x2', 'x3', 'x4'], categories: ['How-to'] },
    ];
    const s = suggestMetadata(TROUBLESHOOTING_BODY, { similar });
    expect(s.tags).toEqual(['auth', 'sso', 'cookies', 'x1', 'x2']);
    expect(s.categories).toEqual(['How-to', 'Reference']);

    const filtered = suggestMetadata(TROUBLESHOOTING_BODY, { similar, known: { tags: ['SSO', 'x3'], categories: ['Reference'] } });
    expect(filtered.tags).toEqual(['sso', 'x3']);
    expect(filtered.categories).toEqual(['Reference']);
  });

  it('flags an exact case-insensitive duplicate title', () => {
    const similar = [{ title: 'login LOOPS back to the sign-in page' }];
    expect(suggestMetadata(TROUBLESHOOTING_BODY, { similar }).duplicate_title).toBe(true);
    expect(suggestMetadata(TROUBLESHOOTING_BODY, { similar: [{ title: 'Other' }] }).duplicate_title).toBe(false);
  });
});
