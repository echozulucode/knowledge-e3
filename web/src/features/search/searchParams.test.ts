import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  clearAllFilters,
  clearAxis,
  effectiveSort,
  EMPTY_FILTERS,
  filtersForNewQuery,
  filtersFromParams,
  isFilterActive,
  isValueLabel,
  paramsFromFilters,
  resultCountLabel,
  searchApiParams,
  sortOptionsFor,
  toggleFilterValue,
  toggleStatus,
  topicScopeLabel,
  type SearchFilters,
} from './searchParams.js';

const filters = (overrides: Partial<SearchFilters> = {}): SearchFilters => ({ ...EMPTY_FILTERS, ...overrides });

describe('search URL params', () => {
  it('reads a repeated filter as every value, not just the first', () => {
    const parsed = filtersFromParams({ q: 'mqtt', tag: ['broker', 'gateway'], type: 'Runbook' });

    expect(parsed.tag).toEqual(['broker', 'gateway']);
    expect(parsed.type).toEqual(['Runbook']);
    expect(parsed.q).toBe('mqtt');
    expect(parsed.sort).toBe('relevance');
  });

  it('drops empty values, duplicates and an unknown sort', () => {
    const parsed = filtersFromParams({ tag: ['broker', ' ', 'Broker'], sort: 'sideways' });

    expect(parsed.tag).toEqual(['broker']);
    expect(parsed.sort).toBe('relevance');
  });

  it('round-trips filters through the URL so a filtered search is a link', () => {
    const original = filters({ q: 'mqtt', tag: ['broker', 'gateway'], type: ['Runbook'], sort: 'newest', status: 'draft' });

    expect(filtersFromParams(paramsFromFilters(original))).toEqual(original);
  });

  it('omits what is not set, and keeps the default sort out of the URL', () => {
    expect(paramsFromFilters(filters({ q: 'mqtt' }))).toEqual({ q: 'mqtt' });
    expect(paramsFromFilters(filters({ q: 'mqtt', sort: 'az' }))).toEqual({ q: 'mqtt', sort: 'az' });
  });

  it('sends every filter to the server, repeating a key per value', () => {
    const params = searchApiParams(filters({ q: 'mqtt', tag: ['broker', 'gateway'], topic: ['Platform'], sort: 'newest' }), {
      limit: 100,
      offset: 100,
    });

    expect(params.getAll('tag')).toEqual(['broker', 'gateway']);
    expect(params.get('topic')).toBe('Platform');
    expect(params.get('q')).toBe('mqtt');
    expect(params.get('sort')).toBe('newest');
    expect(params.get('limit')).toBe('100');
    expect(params.get('offset')).toBe('100');
  });

  it('leaves offset off the first page', () => {
    expect(searchApiParams(filters({ q: 'mqtt' }), { limit: 25 }).has('offset')).toBe(false);
  });

  describe('chips', () => {
    it('adds a value, then removes it when it is applied again', () => {
      const one = toggleFilterValue(filters({ q: 'mqtt' }), 'tag', 'broker');
      expect(one.tag).toEqual(['broker']);

      const two = toggleFilterValue(one, 'tag', 'gateway');
      expect(two.tag).toEqual(['broker', 'gateway']);

      expect(toggleFilterValue(two, 'tag', 'broker').tag).toEqual(['gateway']);
    });

    it('matches a value case-insensitively, because a facet key and its label differ only in case', () => {
      const applied = filters({ type: ['Runbook'] });
      expect(isFilterActive(applied, 'type', 'runbook')).toBe(true);
      expect(toggleFilterValue(applied, 'type', 'runbook').type).toEqual([]);
    });

    it('clears one axis without touching the others, and clears them all without losing the query', () => {
      const applied = filters({ q: 'mqtt', tag: ['broker'], type: ['Runbook'], sort: 'newest', status: 'draft' });

      expect(clearAxis(applied, 'tag')).toMatchObject({ tag: [], type: ['Runbook'] });
      expect(clearAllFilters(applied)).toEqual(filters({ q: 'mqtt', sort: 'newest' }));
      expect(activeFilterCount(applied)).toBe(3);
    });
  });

  describe('the result count', () => {
    it('says how many matched, not how many were fetched', () => {
      expect(resultCountLabel(100, 412, 'mqtt')).toBe('100 of 412 results for ‘mqtt’');
      expect(resultCountLabel(3, 3, 'mqtt')).toBe('3 results for ‘mqtt’');
      expect(resultCountLabel(1, 1, 'mqtt')).toBe('1 result for ‘mqtt’');
    });

    it('reads as a plain count when the search was filters only', () => {
      expect(resultCountLabel(4, 4, '')).toBe('4 results');
    });
  });

  describe('trust and status facets', () => {
    it('carries the trust facet as is=, lowercased, round-tripped and sent to the server', () => {
      const parsed = filtersFromParams({ q: 'mqtt', is: ['Human-Reviewed', 'machine-confirmed'] });
      expect(parsed.is).toEqual(['human-reviewed', 'machine-confirmed']);
      expect(filtersFromParams(paramsFromFilters(parsed))).toEqual(parsed);
      expect(searchApiParams(parsed, { limit: 10 }).getAll('is')).toEqual(['human-reviewed', 'machine-confirmed']);
      expect(activeFilterCount(parsed)).toBe(2);
      expect(toggleFilterValue(parsed, 'is', 'human-reviewed').is).toEqual(['machine-confirmed']);
    });

    it('labels is: values for chips', () => {
      expect(isValueLabel('human-reviewed')).toBe('Human-reviewed');
      expect(isValueLabel('verified')).toBe('Verified');
      expect(isValueLabel('needs-review')).toBe('needs-review');
    });

    it('toggles the single-valued status and ignores anything else', () => {
      const drafts = toggleStatus(filters(), 'Draft');
      expect(drafts.status).toBe('draft');
      expect(toggleStatus(drafts, 'draft').status).toBeUndefined();
      expect(toggleStatus(drafts, 'published').status).toBe('published');
      expect(toggleStatus(drafts, 'archived')).toBe(drafts);
    });
  });

  describe('sort', () => {
    it('accepts verified from the URL', () => {
      expect(filtersFromParams({ q: 'x', sort: 'verified' }).sort).toBe('verified');
    });

    it('says Newest, and asks the server for newest, when there is no query to rank by', () => {
      const topicOnly = filters({ topic: ['architecture'] });
      expect(effectiveSort(topicOnly)).toBe('newest');
      expect(searchApiParams(topicOnly, { limit: 10 }).get('sort')).toBe('newest');
      expect(sortOptionsFor(topicOnly).map((option) => option.value)).toEqual(['newest', 'oldest', 'az', 'verified']);
      // The URL keeps the reader's choice; a query brings relevance back.
      expect(paramsFromFilters(topicOnly)).toEqual({ topic: 'architecture' });
      expect(effectiveSort(filters({ q: 'mqtt' }))).toBe('relevance');
      expect(sortOptionsFor(filters({ q: 'mqtt' }))[0]!.value).toBe('relevance');
      expect(effectiveSort(filters({ sort: 'az' }))).toBe('az');
    });
  });

  describe('topic scope', () => {
    it('keeps the topic across a new query and drops the other facets', () => {
      const scoped = filters({ q: 'old', topic: ['architecture'], tag: ['broker'], is: ['unverified'], status: 'draft', sort: 'az' });
      expect(filtersForNewQuery(scoped, 'new')).toEqual(filters({ q: 'new', topic: ['architecture'], sort: 'az' }));
      // "Search everything" still widens past the scope.
      expect(clearAllFilters(scoped).topic).toEqual([]);
    });

    it('names a scope from a slug, an id or a name, and falls back to the value', () => {
      const candidates = [
        { value: 'platform service', label: 'Platform Service' },
        { value: 'plat-svc', label: 'Platform Service' },
        { value: 'space_42', label: 'Architecture' },
      ];
      expect(topicScopeLabel('platform-service', candidates)).toBe('Platform Service');
      expect(topicScopeLabel('plat-svc', candidates)).toBe('Platform Service');
      expect(topicScopeLabel('Platform Service', candidates)).toBe('Platform Service');
      expect(topicScopeLabel('space_42', candidates)).toBe('Architecture');
      expect(topicScopeLabel('unknown-topic', candidates)).toBe('unknown-topic');
    });
  });
});

describe('the reading pane rides along with the search', () => {
  it('carries peek through a filter change exactly once, and ignores it when reading filters', () => {
    const current = { q: 'mqtt', tag: 'broker', peek: 'broker-setup' };
    const parsed = filtersFromParams(current);
    expect(parsed).toEqual(filters({ q: 'mqtt', tag: ['broker'] }));

    const next = paramsFromFilters(toggleFilterValue(parsed, 'tag', 'gateway'), current);
    expect(next).toEqual({ q: 'mqtt', tag: ['broker', 'gateway'], peek: 'broker-setup' });
    expect(Object.keys(next).filter((key) => key === 'peek')).toHaveLength(1);
  });

  it('keeps peek across a new query, and a link without carry starts with nothing open', () => {
    const current = { q: 'mqtt', peek: 'broker-setup' };
    expect(paramsFromFilters(filtersForNewQuery(filtersFromParams(current), 'kafka'), current)).toEqual({ q: 'kafka', peek: 'broker-setup' });
    expect(paramsFromFilters(filtersFromParams(current))).toEqual({ q: 'mqtt' });
  });

  it('never sends peek to the server, and reads a JSON-decoded numeric slug as a string', () => {
    const current = { q: 'mqtt', peek: 2024 as unknown as string };
    expect(searchApiParams(filtersFromParams(current), { limit: 10 }).has('peek')).toBe(false);
    expect(paramsFromFilters(filtersFromParams(current), current).peek).toBe('2024');
  });
});
