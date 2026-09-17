import { describe, expect, it } from 'vitest';
import { resultMetaParts } from './resultMeta.js';

// Noon UTC, so the calendar day is the same in every timezone the suite runs in.
const NOW = new Date('2026-09-12T12:00:00.000Z');
const opts = { now: NOW, locale: 'en-US' };

describe('resultMetaParts', () => {
  it('reads topic, then type, then the short updated date — one line, no chips', () => {
    expect(resultMetaParts({ topic: 'Architecture', type: 'Runbook', updatedAt: '2026-09-08T12:00:00.000Z' }, opts)).toEqual([
      'Architecture',
      'Runbook',
      'Updated Sep 8',
    ]);
  });

  it('keeps the year only outside the current one, like the home feed', () => {
    expect(resultMetaParts({ updatedAt: '2025-03-02T12:00:00.000Z' }, opts)).toEqual(['Updated Mar 2, 2025']);
  });

  it('omits what is unknown rather than rendering an empty part or "Invalid Date"', () => {
    expect(resultMetaParts({ topic: '  ', type: null, updatedAt: 'not a date' }, opts)).toEqual([]);
    expect(resultMetaParts({ topic: 'Platform', updatedAt: null }, opts)).toEqual(['Platform']);
  });
});
