import { describe, it, expect } from 'vitest';
import type { FeedEntry } from '@echozedlabs/knowledge-types';
import { toFeedCard } from './feedCard.js';

const base: FeedEntry = {
  id: 'p1',
  slug: 'hello',
  title: 'Hello',
  status: 'published',
  type: 'Blog Post',
  space_id: null,
  updated_at: '2026-05-02T00:00:00.000Z',
};

describe('toFeedCard', () => {
  it('builds the byline from authors, publish date, and reading time', () => {
    const card = toFeedCard({
      ...base,
      authors: ['Ada', 'Grace'],
      published_at: '2026-03-03T12:00:00.000Z',
      reading_time_minutes: 4,
      description: '  A post  ',
      cover: 'https://img/x.png',
      series: 'intro',
      series_order: 2,
    });
    expect(card.byline[0]).toBe('By Ada, Grace');
    expect(card.byline[1]).toMatch(/2026/);
    expect(card.byline[2]).toBe('4 min read');
    expect(card).toMatchObject({ slug: 'hello', title: 'Hello', preview: 'A post', cover: 'https://img/x.png', series: 'intro', seriesOrder: 2, type: 'Blog Post' });
  });

  it('falls back to the updated date and omits unknown parts', () => {
    const card = toFeedCard(base);
    expect(card.byline).toHaveLength(1);
    expect(card.byline[0]).toMatch(/2026/);
    expect(card).toMatchObject({ preview: null, cover: null, series: null, seriesOrder: null });
  });

  it('treats blank description, cover, and series as absent', () => {
    expect(toFeedCard({ ...base, description: '  ', cover: '', series: ' ' })).toMatchObject({ preview: null, cover: null, series: null });
  });

  it('applies the shared preview rule, not a description-only read (plan R1.4)', () => {
    // NOTE: `toSummary` on the server currently emits only `description`, so a
    // feed row never carries `summary` yet and this fallback cannot fire in
    // production. It is asserted anyway because the rule must be ONE rule: the
    // day the feed payload carries a summary (a one-line server change), the
    // feed shows the same lead sentence as the read page with no client edit.
    expect(toFeedCard({ ...base, summary: 'Imported summary' } as FeedEntry)).toMatchObject({ preview: 'Imported summary' });
  });

  it('carries the lifecycle display state through when nothing is in review', () => {
    expect(toFeedCard({ ...base, display_state: 'needs-review' })).toMatchObject({ displayState: 'needs-review', reviewUrl: null });
    expect(toFeedCard(base)).toMatchObject({ displayState: undefined, reviewUrl: null });
  });

  it('reads in-review with the change-request link while the change request is open', () => {
    const card = toFeedCard({
      ...base,
      status: 'draft',
      display_state: 'draft',
      review: { state: 'open', url: 'https://github.com/acme/kb/pull/12', branch: 'e3/hello-ab12', opened_at: null, closed_at: null },
    });
    expect(card.displayState).toBe('in-review');
    expect(card.reviewUrl).toBe('https://github.com/acme/kb/pull/12');
  });

  it('ignores a change request the host has already settled', () => {
    const card = toFeedCard({
      ...base,
      display_state: 'published',
      review: { state: 'merged', url: 'https://github.com/acme/kb/pull/12', branch: 'e3/hello-ab12', opened_at: null, closed_at: '2026-05-03T00:00:00.000Z' },
    });
    expect(card.displayState).toBe('published');
    expect(card.reviewUrl).toBeNull();
  });
});
