/**
 * Per-username login rate-limiting using a sliding-window counter.
 *
 * TRADE-OFF: In-memory storage, swept periodically. Resets on server restart.
 * This is fine for v0.1 (10–20 person trial). Production should use a
 * persistent store (Redis, DB row) to survive restarts. See the throttle()
 * function's reset-on-restart comment for a v0.2 issue marker.
 *
 * The throttle is keyed by **lowercase username only** — NOT IP. This way:
 * 1. An attacker can't bypass by rotating IPs.
 * 2. Other users on the same NAT aren't affected.
 */

interface ThrottleEntry {
  failures: number[]; // array of failure timestamps (ms since epoch)
}

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

export interface FailureResult {
  /** Total recorded failures within the window after this one is recorded. */
  count: number;
  /** Seconds remaining on the lockout, derived from the oldest failure in window. */
  retryAfterSeconds: number;
  /** True iff `count > MAX_FAILURES` — caller should respond 429 instead of 401. */
  throttled: boolean;
}

/**
 * Singleton throttle store.
 * TODO (v0.2): Move to a persistent store (Redis or DB) to survive restarts.
 */
class LoginThrottle {
  private store = new Map<string, ThrottleEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup.
    this.startCleanup();
  }

  /**
   * Record a failed login attempt for a username.
   *
   * IMPORTANT: only call this AFTER an actual failed authentication —
   * never as a pre-check, since that would also count successful logins.
   * The caller decides whether to respond 401 or 429 based on `throttled`.
   */
  recordFailure(username: string): FailureResult {
    const now = Date.now();
    const key = username.toLowerCase();
    let entry = this.store.get(key);

    if (!entry) {
      entry = { failures: [] };
      this.store.set(key, entry);
    }

    // Remove stale failures outside the window, then add this one.
    entry.failures = entry.failures.filter((ts) => now - ts < WINDOW_MS);
    entry.failures.push(now);

    const count = entry.failures.length;
    const oldest = entry.failures[0]!;
    const retryAtMs = oldest + WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAtMs - now) / 1000));

    // The Nth failure where N === MAX_FAILURES (e.g. the 5th) still gets
    // a normal 401 — only the (N+1)th and beyond get throttled. This matches
    // the spec's "first 5 return 401, 6th returns 429" semantics.
    return { count, retryAfterSeconds, throttled: count > MAX_FAILURES };
  }

  /**
   * Reset the counter for a username (call on successful login).
   */
  resetFailures(username: string): void {
    const key = username.toLowerCase();
    this.store.delete(key);
  }

  /**
   * Cleanup stale entries periodically.
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        entry.failures = entry.failures.filter((ts) => now - ts < WINDOW_MS);
        if (entry.failures.length === 0) {
          this.store.delete(key);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    // Don't keep the process alive just for this timer.
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Stop the cleanup timer (for testing/shutdown).
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const loginThrottle = new LoginThrottle();
