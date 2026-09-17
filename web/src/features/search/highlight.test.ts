import { describe, expect, it } from 'vitest';
import { highlightSegments, normalizeHighlightRanges } from './highlight.js';

const marked = (text: string, ranges: unknown) =>
  highlightSegments(text, ranges)
    .map((segment) => (segment.marked ? `[${segment.text}]` : segment.text))
    .join('');

describe('highlightSegments', () => {
  it('wraps each range and keeps the text whole and in order', () => {
    expect(marked('MQTT broker setup', [[0, 4], [12, 17]])).toBe('[MQTT] broker [setup]');
    expect(highlightSegments('MQTT broker', [[0, 4]])).toEqual([
      { text: 'MQTT', marked: true },
      { text: ' broker', marked: false },
    ]);
  });

  it('returns one plain segment when there are no ranges', () => {
    expect(highlightSegments('plain', undefined)).toEqual([{ text: 'plain', marked: false }]);
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', marked: false }]);
    expect(highlightSegments('', [[0, 1]])).toEqual([]);
  });

  it('sorts, merges overlapping and touching ranges', () => {
    expect(marked('abcdefghij', [[6, 8], [0, 2], [1, 3], [3, 4]])).toBe('[abcd]ef[gh]ij');
  });

  it('clamps out-of-bounds ranges and drops empty or inverted ones', () => {
    expect(marked('abcdef', [[-5, 2], [4, 99]])).toBe('[ab]cd[ef]');
    expect(marked('abcdef', [[3, 3], [5, 2], [10, 12]])).toBe('abcdef');
  });

  it('treats a malformed payload as plain text rather than trusting part of it', () => {
    expect(marked('abcdef', 'nope')).toBe('abcdef');
    expect(marked('abcdef', [[0, 2], ['1', 3]])).toBe('abcdef');
    expect(marked('abcdef', [[0, Number.NaN]])).toBe('abcdef');
    expect(marked('abcdef', [[0]])).toBe('abcdef');
    expect(normalizeHighlightRanges('abcdef', { 0: [0, 1] })).toBeNull();
  });

  it('counts in UTF-16 code units, so astral characters before a match do not shift it', () => {
    // "🚀" is two UTF-16 units: "Deploy" starts at 3, not 2.
    const text = '🚀 Deploy runbook';
    expect(marked(text, [[3, 9]])).toBe('🚀 [Deploy] runbook');
  });

  it('never splits a surrogate pair: a boundary inside one widens to the whole character', () => {
    const text = 'go 🚀 now';
    // 🚀 occupies units 3–4; ranges that cut it in half mark all of it.
    expect(marked(text, [[4, 5]])).toBe('go [🚀] now');
    expect(marked(text, [[0, 4]])).toBe('[go 🚀] now');
    for (const segment of highlightSegments(text, [[4, 7]])) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(segment.text)).toBe(false);
    }
  });
});
