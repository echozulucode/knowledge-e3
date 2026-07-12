import { describe, expect, it } from 'vitest';
import type { Page, Topic } from '../queries.js';
import { buildTopicOptions } from '../features/topics/topicFilters.js';

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
    id: 'space-research-lab',
    slug: 'research-lab',
    name: 'Research Lab',
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  };
}

describe('PageList topic options', () => {
  it('uses authoritative API topics only so the new item composer can select catalog topics without invented fallbacks', () => {
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
