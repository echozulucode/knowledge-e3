import { describe, it, expect } from 'vitest';
import { CONTENT_TYPES, listContentTypes, findContentType, canonicalTypeLabel, slugifyType } from '../src/index.js';

const EXPECTED_KEYS = [
  'concept',
  'troubleshooting-guide',
  'faq',
  'runbook',
  'how-to',
  'adr',
  'architecture-note',
  'blog-post',
  'series',
  'known-issue',
  'glossary-term',
  'release-note',
];

describe('registry (moved from server/src/content-types)', () => {
  it('exposes the 12 first-class types in their original order', () => {
    expect(CONTENT_TYPES.map((t) => t.key)).toEqual(EXPECTED_KEYS);
    expect(listContentTypes()).toBe(CONTENT_TYPES);
  });

  it('resolves labels and keys case-insensitively', () => {
    expect(findContentType('faq')?.label).toBe('FAQ');
    expect(findContentType('Troubleshooting guide')?.key).toBe('troubleshooting-guide');
    expect(findContentType('nope')).toBeUndefined();
    expect(canonicalTypeLabel('how to')).toBe('How-To');
    expect(canonicalTypeLabel('  Custom Kind ')).toBe('Custom Kind');
    expect(canonicalTypeLabel('')).toBeNull();
    expect(slugifyType('Known Issue')).toBe('known-issue');
  });
});
