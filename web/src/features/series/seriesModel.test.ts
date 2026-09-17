import { describe, it, expect } from 'vitest';
import { humaniseSlug, seriesPosition, seriesSummaryLine, seriesTitle, totalReadingMinutes } from './seriesModel.js';

const part = (id: string, minutes?: number) => ({ id, slug: `slug-${id}`, title: `Title ${id}`, reading_time_minutes: minutes });

describe('humaniseSlug', () => {
  it('turns a slug into a sentence-case heading', () => {
    expect(humaniseSlug('getting-started')).toBe('Getting started');
    expect(humaniseSlug('okf_v0.2--deep-dive')).toBe('Okf v0.2 deep dive');
    expect(humaniseSlug('intro')).toBe('Intro');
    expect(humaniseSlug('--')).toBe('');
  });
});

describe('seriesTitle', () => {
  it("prefers the Series item's title and falls back to the humanised slug", () => {
    const item = { id: 's', slug: 'getting-started', title: 'Getting Started with the Hub', description: null, cover: null, cover_alt: null, space_id: null };
    expect(seriesTitle({ series_item: item }, 'getting-started')).toBe('Getting Started with the Hub');
    expect(seriesTitle({ series_item: null }, 'getting-started')).toBe('Getting started');
    expect(seriesTitle(undefined, 'getting-started')).toBe('Getting started');
  });
});

describe('seriesPosition', () => {
  const parts = [part('a'), part('b'), part('c')];

  it('numbers the current part and names its neighbours', () => {
    expect(seriesPosition(parts, 'b')).toEqual({ number: 2, total: 3, previous: parts[0], next: parts[2] });
    expect(seriesPosition(parts, 'a')).toMatchObject({ number: 1, previous: null, next: parts[1] });
    expect(seriesPosition(parts, 'c')).toMatchObject({ number: 3, previous: parts[1], next: null });
  });

  it('is null for a series of one, or an item that is not a visible part', () => {
    expect(seriesPosition([part('a')], 'a')).toBeNull();
    expect(seriesPosition([], 'a')).toBeNull();
    expect(seriesPosition(parts, 'draft')).toBeNull();
  });
});

describe('reading time totals', () => {
  it('sums reading minutes, counting an unknown estimate as one minute', () => {
    expect(totalReadingMinutes([part('a', 4), part('b', 3), part('c')])).toBe(8);
    expect(seriesSummaryLine([part('a', 4), part('b', 3)])).toBe('2 parts · 7 min total');
    expect(seriesSummaryLine([part('a', 5)])).toBe('1 part · 5 min total');
  });
});
