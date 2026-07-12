import { describe, expect, it } from 'vitest';
import type { Page, Topic } from '../../queries.js';
import {
  buildTopicDirectory,
  buildTopicLookup,
  buildTopicOptions,
  describeActiveTopicFilter,
  normalizedFilterCandidates,
  topicForPage,
  topicMatchesFilter,
  UNASSIGNED_TOPIC_VALUE,
} from './topicFilters.js';

function page(overrides: Partial<Page>): Page {
  return {
    id: 'page-1',
    title: 'Page',
    slug: 'page',
    body_markdown: '',
    status: 'draft',
    version_token: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function topic(overrides: Partial<Topic>): Topic {
  return {
    id: 'space_research_lab',
    slug: 'research-lab',
    name: 'Research Lab',
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  };
}

describe('topic filter helpers', () => {
  it('resolves page topics from API ids, frontmatter topic aliases, and legacy space ids', () => {
    const lookup = buildTopicLookup([topic({ id: 'space_research_lab', slug: 'research-lab', name: 'Research Lab' })]);

    expect(topicForPage(page({ space_id: 'space_research_lab' }), lookup)).toBe('Research Lab');
    expect(topicForPage(page({ frontmatter: { topic: 'Product Discovery' } }), lookup)).toBe('Product Discovery');
    expect(topicForPage(page({ frontmatter: { space: 'Legacy Space' } }), lookup)).toBe('Legacy Space');
    expect(topicForPage(page({ space_id: 'space_default' }), lookup)).toBe('Default space');
  });

  it('matches topic filters by slug, display name, and legacy space alias', () => {
    const lookup = buildTopicLookup([topic({ slug: 'research-lab', name: 'Research Lab' })]);
    const apiPage = page({ space_id: 'space_research_lab' });
    const frontmatterPage = page({ frontmatter: { topic: 'Research Lab' } });

    expect(topicMatchesFilter(apiPage, normalizedFilterCandidates('research-lab'), lookup)).toBe(true);
    expect(topicMatchesFilter(frontmatterPage, normalizedFilterCandidates('Research Lab'), lookup)).toBe(true);
    expect(topicMatchesFilter(frontmatterPage, normalizedFilterCandidates('product-discovery'), lookup)).toBe(false);
  });

  it('treats Unassigned as a special topic filter without hiding normal All topics', () => {
    const assigned = page({ frontmatter: { topic: 'Research Lab' } });
    const unassigned = page({ frontmatter: {}, space_id: undefined });
    const candidates = normalizedFilterCandidates(UNASSIGNED_TOPIC_VALUE);

    expect(topicMatchesFilter(unassigned, candidates)).toBe(true);
    expect(topicMatchesFilter(assigned, candidates)).toBe(false);
    expect(topicMatchesFilter(assigned, [])).toBe(true);
    expect(topicMatchesFilter(unassigned, [])).toBe(true);
  });

  it('builds directory rows with counts, descriptions, API-only topics, and unassigned rows', () => {
    const topics = [
      topic({ id: 'space_research_lab', slug: 'research-lab', name: 'Research Lab', description: 'Research notes' }),
      topic({ id: 'space_product', slug: 'product', name: 'Product', description: 'Product strategy' }),
    ];
    const pages = [
      page({ id: 'a', frontmatter: { topic: 'Research Lab' } }),
      page({ id: 'b', space_id: 'space_research_lab' }),
      page({ id: 'c', frontmatter: {} }),
    ];

    expect(buildTopicDirectory({ pages, topics })).toEqual([
      expect.objectContaining({ label: 'Research Lab', slug: 'research-lab', count: 2, description: 'Research notes' }),
      expect.objectContaining({ label: 'Product', slug: 'product', count: 0, description: 'Product strategy' }),
      expect.objectContaining({ label: 'Unassigned', value: UNASSIGNED_TOPIC_VALUE, count: 1 }),
    ]);
  });

  it('describes active topic from preferred topic query, legacy space query, and All topics', () => {
    const lookup = buildTopicLookup([topic({ id: 'space_research_lab', slug: 'research-lab', name: 'Research Lab' })]);

    expect(describeActiveTopicFilter({ topic: 'research-lab' }, lookup)).toEqual({ kind: 'topic', label: 'Research Lab', value: 'research-lab' });
    expect(describeActiveTopicFilter({ space: 'legacy-space' }, lookup)).toEqual({ kind: 'topic', label: 'Legacy Space', value: 'legacy-space' });
    expect(describeActiveTopicFilter({ space: 'space_research_lab' }, lookup)).toEqual({ kind: 'topic', label: 'Research Lab', value: 'space_research_lab' });
    expect(describeActiveTopicFilter({ topic: UNASSIGNED_TOPIC_VALUE }, lookup)).toEqual({ kind: 'unassigned', label: 'Unassigned', value: UNASSIGNED_TOPIC_VALUE });
    expect(describeActiveTopicFilter({}, lookup)).toEqual({ kind: 'all', label: 'All spaces', value: undefined });
  });
});

describe('buildTopicOptions compatibility', () => {
  it('uses authoritative API topics only so composer/dropdowns do not drift from the topic catalog', () => {
    expect(
      buildTopicOptions({
        pages: [page({ frontmatter: { topic: 'Product Discovery' } })],
        topics: [topic({ name: 'Research Lab', slug: 'research-lab' })],
      }),
    ).toEqual(['Research Lab']);
  });

  it('falls back to the topic slug display name when the API topic name is missing', () => {
    expect(
      buildTopicOptions({
        pages: [],
        topics: [topic({ name: '', slug: 'capture-inbox' })],
      }),
    ).toContain('Capture Inbox');
  });
});
