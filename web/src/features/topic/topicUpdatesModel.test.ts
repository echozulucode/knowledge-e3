import { describe, it, expect } from 'vitest';
import type { FeedEntry, PopularEntry, SectionView } from '@echozedlabs/knowledge-types';
import {
  POPULAR_MIN_ITEMS,
  popularToShow,
  readersLabel,
  shortDate,
  topicFeedPath,
  topicUpdateMeta,
  updatesRule,
  viewAllSearch,
} from './topicUpdatesModel.js';

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return { id: 'i', slug: 's', title: 'T', status: 'published', type: 'Blog Post', space_id: null, updated_at: '2026-01-01T00:00:00.000Z', ...over };
}

function popular(views: number, i: number): PopularEntry {
  return { ...entry({ id: `p${i}`, slug: `p${i}`, title: `P${i}` }), views };
}

describe('topicFeedPath', () => {
  it('asks for every type unless the Updates Section names one', () => {
    expect(topicFeedPath({ topic: 'ai', tags: ['update'] })).toBe('/feed?topic=ai&tags=update&all_types=1&limit=5');
    expect(topicFeedPath({ topic: 'ai', tags: ['update', 'news'], type: 'Blog Post', limit: 3 })).toBe(
      '/feed?topic=ai&tags=update%2Cnews&types=Blog+Post&limit=3',
    );
  });

  it('omits tags for the "Recently updated" fallback', () => {
    expect(topicFeedPath({ topic: 'ai' })).toBe('/feed?topic=ai&all_types=1&limit=5');
  });
});

describe('updatesRule', () => {
  const section = (over: Partial<SectionView>): SectionView => ({ slug: 'updates', name: 'Updates', ...over });

  it('mirrors the Section name, tags and type', () => {
    expect(updatesRule(section({ tags: [' update ', ''], type: 'Blog Post' }))).toEqual({ name: 'Updates', tags: ['update'], type: 'Blog Post' });
    expect(updatesRule(section({ name: 'News', tags: ['news'] }))).toEqual({ name: 'News', tags: ['news'] });
  });

  it('is null without a Section, or for a Section with no tags', () => {
    expect(updatesRule(undefined)).toBeNull();
    expect(updatesRule(section({ type: 'Blog Post' }))).toBeNull();
    expect(updatesRule(section({ tags: [] }))).toBeNull();
  });
});

describe('topicUpdateMeta', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('is date then reading time, with no topic label', () => {
    const parts = topicUpdateMeta(entry({ published_at: '2026-09-08T12:00:00.000Z', reading_time_minutes: 4, topic: 'ai', topic_name: 'AI' }), now, 'en-US');
    expect(parts).toEqual(['Sep 8', '4 min read']);
  });

  it('adds the year outside the current one and drops what it does not know', () => {
    expect(topicUpdateMeta(entry({ published_at: '2025-03-02T12:00:00.000Z' }), now, 'en-US')).toEqual(['Mar 2, 2025']);
    expect(topicUpdateMeta(entry({ published_at: 'nope', updated_at: 'nope' }), now, 'en-US')).toEqual([]);
    expect(shortDate(null, now)).toBe('');
  });
});

describe('popular helpers', () => {
  it('shows nothing below the threshold and every ranked item at or above it', () => {
    const below = Array.from({ length: POPULAR_MIN_ITEMS - 1 }, (_, i) => popular(5, i));
    expect(popularToShow(below)).toEqual([]);
    const at = Array.from({ length: POPULAR_MIN_ITEMS }, (_, i) => popular(POPULAR_MIN_ITEMS - i, i));
    expect(popularToShow(at)).toHaveLength(POPULAR_MIN_ITEMS);
    expect(popularToShow(undefined)).toEqual([]);
  });

  it('does not count zero-view items toward the threshold', () => {
    expect(popularToShow([popular(2, 1), popular(1, 2), popular(0, 3)])).toEqual([]);
  });

  it('pluralises readers', () => {
    expect(readersLabel(1)).toBe('1 reader');
    expect(readersLabel(3)).toBe('3 readers');
  });
});

describe('viewAllSearch', () => {
  it('narrows search to the topic, newest first, and the tags when there are any', () => {
    expect(viewAllSearch('ai')).toEqual({ topic: 'ai', sort: 'newest' });
    expect(viewAllSearch('ai', ['update'])).toEqual({ topic: 'ai', sort: 'newest', tag: 'update' });
    expect(viewAllSearch('ai', ['update', 'news'])).toEqual({ topic: 'ai', sort: 'newest', tag: ['update', 'news'] });
  });
});
