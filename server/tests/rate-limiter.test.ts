import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/common/rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('allows hits up to the limit then blocks', () => {
    const rl = new SlidingWindowRateLimiter(3, 60_000);
    expect(rl.hit('u').allowed).toBe(true);
    expect(rl.hit('u').allowed).toBe(true);
    expect(rl.hit('u').allowed).toBe(true);
    const blocked = rl.hit('u');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys windows independently per caller', () => {
    const rl = new SlidingWindowRateLimiter(1, 60_000);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    // A different caller is unaffected.
    expect(rl.hit('b').allowed).toBe(true);
  });

  it('lets the window slide so traffic resumes after it expires', () => {
    const rl = new SlidingWindowRateLimiter(2, 60_000);
    expect(rl.hit('u').allowed).toBe(true);
    expect(rl.hit('u').allowed).toBe(true);
    expect(rl.hit('u').allowed).toBe(false);
    // Advance past the window — the earlier hits expire.
    vi.advanceTimersByTime(60_001);
    expect(rl.hit('u').allowed).toBe(true);
  });

  it('does not advance the window while blocked (retryAfter shrinks over time)', () => {
    const rl = new SlidingWindowRateLimiter(1, 60_000);
    expect(rl.hit('u').allowed).toBe(true);
    const first = rl.hit('u');
    expect(first.allowed).toBe(false);
    vi.advanceTimersByTime(30_000);
    const second = rl.hit('u');
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
  });
});
