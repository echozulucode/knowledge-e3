/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * TRADE-OFF: in-memory, resets on restart, keyed by an opaque caller id. Fine
 * for the v0.1 trial (10–20 users); a production multi-instance deployment
 * should move this to a shared store (Redis/DB) — same v0.2 note as the login
 * throttle in auth/throttle.ts. The key space is bounded by the number of
 * distinct callers, so the map does not grow without bound in practice.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest in-window hit expires (only meaningful when blocked). */
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly store = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record a hit for `key` and report whether it is within the limit. When the
   * window is already full the hit is NOT recorded (so a blocked caller can't
   * push the window forward forever) and `allowed` is false.
   */
  hit(key: string): RateLimitResult {
    const now = Date.now();
    const hits = (this.store.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (hits.length >= this.limit) {
      this.store.set(key, hits);
      const retryAfterSeconds = Math.max(1, Math.ceil((hits[0]! + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }
    hits.push(now);
    this.store.set(key, hits);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Test/shutdown helper: drop all recorded windows. */
  reset(): void {
    this.store.clear();
  }
}
