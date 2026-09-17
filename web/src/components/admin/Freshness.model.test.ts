import { describe, expect, it } from 'vitest';
import { freshnessAgo, freshnessTickMs } from './Freshness.model.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

describe('freshnessAgo', () => {
  it('is null when never fetched', () => {
    expect(freshnessAgo(0, NOW)).toBeNull();
    expect(freshnessAgo(null, NOW)).toBeNull();
    expect(freshnessAgo(undefined, NOW)).toBeNull();
  });

  it('reads seconds, minutes, hours and days', () => {
    expect(freshnessAgo(NOW - 2_000, NOW)).toBe('just now');
    expect(freshnessAgo(NOW + 3_000, NOW)).toBe('just now');
    expect(freshnessAgo(NOW - 14_000, NOW)).toBe('14 s ago');
    expect(freshnessAgo(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(freshnessAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 h ago');
    expect(freshnessAgo(NOW - 4 * 86_400_000, NOW)).toBe('4 d ago');
  });
});

describe('freshnessTickMs', () => {
  it('ticks every second under a minute, then every 30 s', () => {
    expect(freshnessTickMs(NOW - 10_000, NOW)).toBe(1_000);
    expect(freshnessTickMs(NOW - 120_000, NOW)).toBe(30_000);
    expect(freshnessTickMs(0, NOW)).toBe(30_000);
  });
});
