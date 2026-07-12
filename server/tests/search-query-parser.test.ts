import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/search/query-parser.js';

describe('search query parser', () => {
  it('parses exact phrases and plain terms', () => {
    const parsed = parseSearchQuery('"platform service" architecture');

    expect(parsed).toMatchObject({
      raw: '"platform service" architecture',
      terms: ['architecture'],
      phrases: ['platform service'],
      excludedTerms: [],
      filters: {},
      warnings: [],
    });
  });

  it('parses supported filters alongside phrases and warns on unsupported filters', () => {
    const parsed = parseSearchQuery('"release notes" tag:platform modified:this-year');

    expect(parsed).toMatchObject({
      raw: '"release notes" tag:platform modified:this-year',
      terms: [],
      phrases: ['release notes'],
      excludedTerms: [],
      filters: {
        tag: ['platform'],
      },
      warnings: ['Unsupported structured filter ignored: modified:this-year'],
    });
  });

  it('parses excluded terms', () => {
    const parsed = parseSearchQuery('-obsolete docker');

    expect(parsed).toMatchObject({
      raw: '-obsolete docker',
      terms: ['docker'],
      phrases: [],
      excludedTerms: ['obsolete'],
      filters: {},
      warnings: [],
    });
  });

  it('returns a warning for unclosed quotes but keeps parsing terms', () => {
    const parsed = parseSearchQuery('platform "release notes');

    expect(parsed.raw).toBe('platform "release notes');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('Unclosed quote');
    expect(parsed.terms).toEqual(['platform', 'release', 'notes']);
    expect(parsed.phrases).toEqual([]);
    expect(parsed.excludedTerms).toEqual([]);
    expect(parsed.filters).toEqual({});
  });

  it('keeps quoted filter values together', () => {
    const parsed = parseSearchQuery('topic:"Platform Service" tag:embedded');

    expect(parsed.terms).toEqual([]);
    expect(parsed.filters).toEqual({
      topic: ['Platform Service'],
      tag: ['embedded'],
    });
    expect(parsed.warnings).toEqual([]);
  });

  it('warns on malformed supported filters without treating them as text terms', () => {
    const parsed = parseSearchQuery('tag: platform');

    expect(parsed.terms).toEqual(['platform']);
    expect(parsed.filters).toEqual({});
    expect(parsed.warnings).toEqual(['Malformed structured filter ignored: tag:']);
  });

  it('does not silently turn excluded filters into included filters', () => {
    const parsed = parseSearchQuery('-tag:obsolete docker');

    expect(parsed.terms).toEqual(['docker']);
    expect(parsed.filters).toEqual({});
    expect(parsed.excludedTerms).toEqual(['tag:obsolete']);
    expect(parsed.warnings[0]).toContain('Excluded filters are not supported');
  });
});
