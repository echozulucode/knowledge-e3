import { describe, expect, it } from 'vitest';
import { FACET_VISIBLE_LIMIT, visibleFacetValues } from './facets.js';
import type { SearchFacetValue } from './queries.js';

/** Ten topics, counted 10 down to 1, handed over out of order. */
const TOPICS: SearchFacetValue[] = Array.from({ length: 10 }, (_, i) => ({
  value: `topic-${i + 1}`,
  label: `Topic ${i + 1}`,
  count: 10 - i,
})).reverse();

const labels = (options: { label: string }[]) => options.map((o) => o.label);

describe('visibleFacetValues', () => {
  it('shows the top six by count and folds the rest behind the toggle', () => {
    const { shown, hiddenCount, collapsible } = visibleFacetValues(TOPICS, [], { expanded: false });
    expect(FACET_VISIBLE_LIMIT).toBe(6);
    expect(labels(shown)).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4', 'Topic 5', 'Topic 6']);
    expect(hiddenCount).toBe(4);
    expect(collapsible).toBe(true);
  });

  it('shows everything, highest count first, once expanded', () => {
    const { shown, hiddenCount, collapsible } = visibleFacetValues(TOPICS, [], { expanded: true });
    expect(shown).toHaveLength(10);
    expect(shown[0]!.label).toBe('Topic 1');
    expect(hiddenCount).toBe(0);
    expect(collapsible).toBe(true);
  });

  it('keeps an active option visible even below the cut, matching by label or key in any case', () => {
    const { shown, hiddenCount } = visibleFacetValues(TOPICS, ['topic 9'], { expanded: false });
    expect(labels(shown)).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4', 'Topic 5', 'Topic 6', 'Topic 9']);
    expect(shown.at(-1)!.active).toBe(true);
    expect(hiddenCount).toBe(3);
    expect(visibleFacetValues(TOPICS, ['TOPIC-10'], { expanded: false }).shown.at(-1)!.label).toBe('Topic 10');
  });

  it('offers no toggle when nothing would fold', () => {
    const few = TOPICS.slice(0, 6);
    expect(visibleFacetValues(few, [], { expanded: false })).toMatchObject({ hiddenCount: 0, collapsible: false });
    // Seven options, but the seventh is active: all seven show, so nothing folds.
    const seven = TOPICS.slice(3);
    expect(visibleFacetValues(seven, ['Topic 7'], { expanded: false })).toMatchObject({ hiddenCount: 0, collapsible: false });
  });

  it('still shows an active filter the server left out of its capped list, without a count', () => {
    const { shown } = visibleFacetValues(TOPICS.slice(0, 3), ['Rare Topic'], { expanded: false });
    expect(shown.at(-1)).toEqual({ value: 'rare topic', label: 'Rare Topic', count: null, active: true });
  });
});
