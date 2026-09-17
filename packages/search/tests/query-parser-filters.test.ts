import { describe, expect, it } from 'vitest';
import { IS_FILTER_VALUES, SUPPORTED_SEARCH_FILTERS, parseSearchQuery, parseUpdatedFilter } from '../src/query-parser.js';

describe('author:, updated: and is:', () => {
  // A fixed clock so relative windows are deterministic: 13 September 2026, noon UTC.
  const NOW = new Date('2026-09-13T12:00:00.000Z');
  const parse = (q: string) => parseSearchQuery(q, { now: NOW });

  it('lists the three keys in the supported-filter table the search tips are generated from', () => {
    const byKey = Object.fromEntries(SUPPORTED_SEARCH_FILTERS.map((spec) => [spec.key, spec]));
    expect(byKey['author']).toMatchObject({ multi: true, negatable: true, example: 'author:"Ada Lovelace"' });
    expect(byKey['updated']).toMatchObject({ multi: false, negatable: false });
    expect(byKey['is']).toMatchObject({ multi: true, negatable: true, values: IS_FILTER_VALUES });
    // Every example parses cleanly: a tip that produces a warning is a broken tip.
    for (const spec of SUPPORTED_SEARCH_FILTERS) expect(parse(spec.example).warnings).toEqual([]);
  });

  describe('author:', () => {
    it('keeps a quoted name together, alongside free text', () => {
      const parsed = parse('author:"Ada Lovelace" mqtt broker');
      expect(parsed.filters).toEqual({ author: ['Ada Lovelace'] });
      expect(parsed.terms).toEqual(['mqtt', 'broker']);
      expect(parsed.prefixTerm).toBe('broker');
      expect(parsed.warnings).toEqual([]);
    });

    it('ORs repeated names, drops a case-only duplicate, and negates', () => {
      expect(parse('author:ada author:grace author:ADA').filters).toEqual({ author: ['ada', 'grace'] });
      const negated = parse('mqtt -author:"Grace Hopper"');
      expect(negated.filters).toEqual({});
      expect(negated.excludedFilters).toEqual({ author: ['Grace Hopper'] });
      expect(negated.terms).toEqual(['mqtt']);
    });

    it('reports an empty author: instead of searching for the word', () => {
      const parsed = parse('author: ada');
      expect(parsed.filters).toEqual({});
      expect(parsed.warnings).toEqual(['Malformed structured filter ignored: author:']);
    });
  });

  describe('updated:', () => {
    const range = (q: string) => parse(q).updated;

    it('reads a day, a month and a year as that whole period', () => {
      expect(range('updated:2026-03-14')).toEqual({ after: '2026-03-14T00:00:00.000Z', before: '2026-03-15T00:00:00.000Z' });
      expect(range('updated:2026-02')).toEqual({ after: '2026-02-01T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z' });
      expect(range('updated:2025-12')).toEqual({ after: '2025-12-01T00:00:00.000Z', before: '2026-01-01T00:00:00.000Z' });
      expect(range('updated:2024')).toEqual({ after: '2024-01-01T00:00:00.000Z', before: '2025-01-01T00:00:00.000Z' });
    });

    it('applies comparators to the edges of the period: after inclusive, before exclusive', () => {
      expect(range('updated:>2026-01-01')).toEqual({ after: '2026-01-02T00:00:00.000Z' });
      expect(range('updated:>=2026-01-01')).toEqual({ after: '2026-01-01T00:00:00.000Z' });
      expect(range('updated:<2026-01-01')).toEqual({ before: '2026-01-01T00:00:00.000Z' });
      expect(range('updated:<=2026-01-01')).toEqual({ before: '2026-01-02T00:00:00.000Z' });
      expect(range('updated:<2025-06')).toEqual({ before: '2025-06-01T00:00:00.000Z' });
      expect(range('updated:<=2025-06')).toEqual({ before: '2025-07-01T00:00:00.000Z' });
      expect(range('updated:>2025')).toEqual({ after: '2026-01-01T00:00:00.000Z' });
    });

    it('reads relative windows as "updated within", counted back from the injected clock', () => {
      expect(range('updated:7d')).toEqual({ after: '2026-09-06T12:00:00.000Z' });
      expect(range('updated:4w')).toEqual({ after: '2026-08-16T12:00:00.000Z' });
      expect(range('updated:6m')).toEqual({ after: '2026-03-13T12:00:00.000Z' });
      expect(range('updated:1y')).toEqual({ after: '2025-09-13T12:00:00.000Z' });
      expect(range('updated:30D')).toEqual({ after: '2026-08-14T12:00:00.000Z' });
      // Calendar months clamp to the month's last day rather than overflowing into March.
      expect(parseUpdatedFilter('6m', new Date('2026-08-31T08:00:00.000Z'))).toEqual({ after: '2026-02-28T08:00:00.000Z' });
      expect(parseUpdatedFilter('1y', new Date('2028-02-29T00:00:00.000Z'))).toEqual({ after: '2027-02-28T00:00:00.000Z' });
    });

    it('keeps the raw value in filters and accepts a quoted value', () => {
      const parsed = parse('updated:">=2026-01-01" runbook');
      expect(parsed.filters).toEqual({ updated: ['>=2026-01-01'] });
      expect(parsed.updated).toEqual({ after: '2026-01-01T00:00:00.000Z' });
      expect(parsed.terms).toEqual(['runbook']);
      expect(parsed.warnings).toEqual([]);
    });

    it('warns about a value it cannot read and ignores the filter instead of guessing', () => {
      for (const bad of ['yesterday', '2026-02-30', '2026-13', '26-01-01', '0d', '>7d', '7h', '=2026', '2026-1-5']) {
        const parsed = parse(`mqtt updated:${bad}`);
        expect(parsed.updated, bad).toBeUndefined();
        expect(parsed.filters, bad).toEqual({});
        expect(parsed.terms, bad).toEqual(['mqtt']);
        expect(parsed.warnings, bad).toHaveLength(1);
        expect(parsed.warnings[0], bad).toContain(`Unrecognised updated: value ignored: updated:${bad}`);
      }
      // A leap day is a real date in a leap year.
      expect(range('updated:2028-02-29')).toEqual({ after: '2028-02-29T00:00:00.000Z', before: '2028-03-01T00:00:00.000Z' });
    });

    it('takes one value only, and cannot be negated', () => {
      const twice = parse('updated:2026 updated:2025');
      expect(twice.filters).toEqual({ updated: ['2026'] });
      expect(twice.updated).toEqual({ after: '2026-01-01T00:00:00.000Z', before: '2027-01-01T00:00:00.000Z' });
      expect(twice.warnings).toEqual(['Only one updated: filter is applied; ignored updated:2025']);

      const negated = parse('-updated:2026 mqtt');
      expect(negated.updated).toBeUndefined();
      expect(negated.excludedFilters).toEqual({});
      expect(negated.warnings).toEqual(['Excluded filters are not supported for this key: -updated:2026']);
    });

    it('lets a readable second value apply when the first was unreadable', () => {
      const parsed = parse('updated:soon updated:2026');
      expect(parsed.updated).toEqual({ after: '2026-01-01T00:00:00.000Z', before: '2027-01-01T00:00:00.000Z' });
      expect(parsed.warnings).toHaveLength(1);
    });
  });

  describe('is:', () => {
    it('accepts every documented value, in any case, in canonical form', () => {
      for (const value of IS_FILTER_VALUES) {
        const parsed = parse(`is:${value.toUpperCase()}`);
        expect(parsed.filters).toEqual({ is: [value] });
        expect(parsed.warnings).toEqual([]);
      }
    });

    it('folds the alias stale to needs-review, and de-duplicates after folding', () => {
      expect(parse('is:stale').filters).toEqual({ is: ['needs-review'] });
      expect(parse('is:needs-review is:stale').filters).toEqual({ is: ['needs-review'] });
    });

    it('ORs repeated values and negates', () => {
      expect(parse('is:human-reviewed is:machine-confirmed kubectl').filters).toEqual({ is: ['human-reviewed', 'machine-confirmed'] });
      const negated = parse('postgres -is:draft -is:needs-review');
      expect(negated.excludedFilters).toEqual({ is: ['draft', 'needs-review'] });
      expect(negated.terms).toEqual(['postgres']);
    });

    it('warns about an unknown value, naming the ones it accepts', () => {
      const parsed = parse('is:superseded mqtt -is:bogus');
      expect(parsed.filters).toEqual({});
      expect(parsed.excludedFilters).toEqual({});
      expect(parsed.terms).toEqual(['mqtt']);
      expect(parsed.warnings).toEqual([
        `Unknown is: value ignored: is:superseded (use ${IS_FILTER_VALUES.join(', ')})`,
        `Unknown is: value ignored: is:bogus (use ${IS_FILTER_VALUES.join(', ')})`,
      ]);
    });

    it('keeps is:draft and status: as independent filters that must both hold', () => {
      const parsed = parse('status:published is:draft');
      expect(parsed.filters).toEqual({ status: ['published'], is: ['draft'] });
      expect(parsed.warnings).toEqual([]);
    });
  });

  it('combines all three with the other keys and free text without disturbing the prefix term', () => {
    const parsed = parse('type:Runbook author:"Ada Lovelace" is:verified updated:6m "broker acl" mqtt brok');
    expect(parsed.filters).toEqual({ type: ['Runbook'], author: ['Ada Lovelace'], is: ['verified'], updated: ['6m'] });
    expect(parsed.updated).toEqual({ after: '2026-03-13T12:00:00.000Z' });
    expect(parsed.phrases).toEqual(['broker acl']);
    expect(parsed.terms).toEqual(['mqtt', 'brok']);
    expect(parsed.prefixTerm).toBe('brok');
    expect(parsed.warnings).toEqual([]);
  });
});
