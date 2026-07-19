import { describe, it, expect } from 'vitest';
import {
  readingTimeMinutes,
  authorsOf,
  coverImageOf,
  publishDateOf,
  displayDateOf,
  bylineParts,
  seriesOf,
} from './blogMeta.js';

describe('blogMeta', () => {
  it('estimates reading time from body words, ignoring code and markup', () => {
    expect(readingTimeMinutes('')).toBe(1); // floor of 1
    expect(readingTimeMinutes(undefined)).toBe(1);
    const words = Array.from({ length: 450 }, () => 'word').join(' ');
    expect(readingTimeMinutes(words)).toBe(2); // 450 / 225
    // Code fences don't inflate the count.
    const withCode = '```\n' + Array.from({ length: 1000 }, () => 'x').join('\n') + '\n```\nreal words here';
    expect(readingTimeMinutes(withCode)).toBe(1);
  });

  it('reads authors from authors[] or a single author string', () => {
    expect(authorsOf({ frontmatter: { authors: ['Ada', 'Grace'] } })).toEqual(['Ada', 'Grace']);
    expect(authorsOf({ frontmatter: { author: 'Ada Lovelace' } })).toEqual(['Ada Lovelace']);
    expect(authorsOf({ authors: ['Fallback'] })).toEqual(['Fallback']);
    expect(authorsOf({ frontmatter: {} })).toEqual([]);
  });

  it('reads a cover image from common frontmatter keys', () => {
    expect(coverImageOf({ frontmatter: { cover: '/assets/x.png' } })).toBe('/assets/x.png');
    expect(coverImageOf({ frontmatter: { cover_image: '/a.jpg' } })).toBe('/a.jpg');
    expect(coverImageOf({ frontmatter: {} })).toBeNull();
  });

  it('reads the series name from frontmatter', () => {
    expect(seriesOf({ frontmatter: { series: 'Building E3' } })).toBe('Building E3');
    expect(seriesOf({ frontmatter: {} })).toBeNull();
  });

  it('prefers the first-class published_at, then frontmatter, for the publish date', () => {
    expect(publishDateOf({ published_at: '2024-01-01T00:00:00Z' })).toBe('2024-01-01T00:00:00Z');
    expect(publishDateOf({ frontmatter: { published_at: '2023-05-05' } })).toBe('2023-05-05');
    expect(publishDateOf({ frontmatter: { date: '2022-02-02' } })).toBe('2022-02-02');
    expect(publishDateOf({ updated_at: '2020-01-01' })).toBeNull(); // updated_at is not a publish date
  });

  it('display date falls back to updated_at so a card is never dateless', () => {
    expect(displayDateOf({ updated_at: '2020-06-06T00:00:00Z' })).toBe('2020-06-06T00:00:00Z');
    expect(displayDateOf({ published_at: '2024-01-01T00:00:00Z', updated_at: '2025-01-01' })).toBe('2024-01-01T00:00:00Z');
  });

  it('builds a byline with the parts it has', () => {
    const parts = bylineParts({
      frontmatter: { author: 'Ada' },
      published_at: '2024-03-03T00:00:00Z',
      body_markdown: Array.from({ length: 225 }, () => 'w').join(' '),
    });
    expect(parts[0]).toBe('By Ada');
    expect(parts[parts.length - 1]).toBe('1 min read');
    expect(parts).toHaveLength(3);

    // No author, no date → just the read time.
    expect(bylineParts({ body_markdown: 'short' })).toEqual(['1 min read']);
  });
});
