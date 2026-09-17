import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../src/query-parser.js';

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

  it('parses an excluded filter as an exclusion, not as an included filter', () => {
    const parsed = parseSearchQuery('-tag:obsolete docker');

    expect(parsed.terms).toEqual(['docker']);
    expect(parsed.filters).toEqual({});
    expect(parsed.excludedFilters).toEqual({ tag: ['obsolete'] });
    expect(parsed.excludedTerms).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it('reports the keys it cannot negate instead of ignoring the minus sign', () => {
    const parsed = parseSearchQuery('-status:draft docker');

    expect(parsed.filters).toEqual({});
    expect(parsed.excludedFilters).toEqual({});
    expect(parsed.warnings).toEqual(['Excluded filters are not supported for this key: -status:draft']);
  });

  it('ORs repeated filter values instead of keeping only the first', () => {
    const parsed = parseSearchQuery('tag:mqtt tag:modbus type:Runbook type:FAQ');

    expect(parsed.filters).toEqual({ tag: ['mqtt', 'modbus'], type: ['Runbook', 'FAQ'] });
    expect(parsed.warnings).toEqual([]);
  });

  it('accepts type: — the facet /search offers — rather than warning it away', () => {
    const parsed = parseSearchQuery('type:Runbook mqtt');

    expect(parsed.filters).toEqual({ type: ['Runbook'] });
    expect(parsed.terms).toEqual(['mqtt']);
    expect(parsed.warnings).toEqual([]);
  });

  it('reports a second value for a single-value key rather than dropping it in silence', () => {
    const parsed = parseSearchQuery('status:draft status:published');

    expect(parsed.filters).toEqual({ status: ['draft'] });
    expect(parsed.warnings).toEqual(['Only one status: filter is applied; ignored status:published']);
  });

  it('excludes a quoted phrase as a phrase, not as its separate words', () => {
    const parsed = parseSearchQuery('docker -"build cache"');

    expect(parsed.terms).toEqual(['docker']);
    expect(parsed.excludedPhrases).toEqual(['build cache']);
    expect(parsed.excludedTerms).toEqual([]);
  });

  describe('trailing prefix term', () => {
    it('marks the word still being typed so a provider can match it as a prefix', () => {
      expect(parseSearchQuery('modb').prefixTerm).toBe('modb');
      expect(parseSearchQuery('mqtt broker conf').prefixTerm).toBe('conf');
    });

    it('never expands a quoted phrase, a filter, or a one-character token', () => {
      expect(parseSearchQuery('"modbus gateway"').prefixTerm).toBeNull();
      expect(parseSearchQuery('mqtt tag:broker').prefixTerm).toBeNull();
      expect(parseSearchQuery('mqtt a').prefixTerm).toBeNull();
      expect(parseSearchQuery('mqtt -broker').prefixTerm).toBeNull();
    });
  });
});
