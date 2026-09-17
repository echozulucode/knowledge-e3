import { describe, it, expect } from 'vitest';
import type { FeedEntry } from '@echozedlabs/knowledge-types';
import { shortDate, storyMetaParts, storyTopic } from './storyMeta.js';

// Noon UTC, so the calendar day is the same in every timezone the suite runs in.
const NOW = new Date('2026-09-12T12:00:00.000Z');

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'i1',
    slug: 'a-story',
    title: 'A story',
    type: 'Blog Post',
    published_at: '2026-09-08T12:00:00.000Z',
    updated_at: '2026-09-09T12:00:00.000Z',
    ...over,
  } as FeedEntry;
}

describe('shortDate', () => {
  it('drops the year inside the current year and keeps it outside', () => {
    expect(shortDate('2026-09-08T12:00:00.000Z', NOW, 'en-US')).toBe('Sep 8');
    expect(shortDate('2025-09-08T12:00:00.000Z', NOW, 'en-US')).toBe('Sep 8, 2025');
  });

  it('is empty for a missing or unparseable date rather than "Invalid Date"', () => {
    expect(shortDate(null, NOW)).toBe('');
    expect(shortDate('not a date', NOW)).toBe('');
  });
});

describe('storyMetaParts', () => {
  it('gives a row its kind, date and reading time — one line, no chips', () => {
    expect(storyMetaParts(entry({ reading_time_minutes: 4, authors: ['Ada'] }), { now: NOW, locale: 'en-US' })).toEqual([
      'Blog Post',
      'Sep 8',
      '4 min read',
    ]);
  });

  it('gives the lead story its author instead of its kind', () => {
    expect(
      storyMetaParts(entry({ reading_time_minutes: 4, authors: ['Ada Lovelace', 'Grace Hopper'] }), { lead: true, now: NOW, locale: 'en-US' }),
    ).toEqual(['Ada Lovelace, Grace Hopper', 'Sep 8', '4 min read']);
  });

  it('falls back to the kind when the lead has no author, so both lines keep one shape', () => {
    expect(storyMetaParts(entry({ authors: [] }), { lead: true, now: NOW, locale: 'en-US' })).toEqual(['Blog Post', 'Sep 8']);
  });

  it('uses the updated date for an item that was never given a publish date, and omits what is unknown', () => {
    expect(storyMetaParts(entry({ type: null, published_at: null, reading_time_minutes: 0 }), { now: NOW, locale: 'en-US' })).toEqual([
      'Sep 9',
    ]);
  });
});

describe('storyTopic', () => {
  it('labels a story with its topic name and links it by slug', () => {
    expect(storyTopic(entry({ topic: 'architecture', topic_name: 'Architecture' }))).toEqual({ name: 'Architecture', slug: 'architecture' });
  });

  it('keeps the label as plain text when only the name is known', () => {
    expect(storyTopic(entry({ topic_name: ' Architecture ' }))).toEqual({ name: 'Architecture', slug: null });
  });

  it('shows no label rather than a raw slug when the payload carries no name', () => {
    expect(storyTopic(entry({ topic: 'default' }))).toBeNull();
    expect(storyTopic(entry({ topic: 'default', topic_name: '  ' }))).toBeNull();
  });
});
