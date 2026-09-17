/**
 * The auto-refresh schedule for System health (review §4.9: "30 s auto-refresh,
 * paused when hidden"), as a React-free scheduler so its three promises are
 * unit-tested with fake timers rather than asserted by watching a network tab:
 *
 *  1. **Paused while the tab is hidden.** A health page left open in a
 *     background tab all weekend should not run the deep probes (a
 *     `PRAGMA quick_check`, a write to the content root) 5,760 times.
 *  2. **Resumed on return, at once if overdue.** Coming back to the tab is
 *     exactly when the operator wants the page to be current.
 *  3. **Never stacked.** A refresh already in flight — ours, or the one the
 *     Refresh button started — is not joined by a second.
 *
 * The clock is the DATA's age (`lastUpdatedAt`, TanStack Query's
 * `dataUpdatedAt`), not the timer's: a manual Refresh at second 25 pushes the
 * next automatic one to second 55 instead of firing a redundant one at 30.
 */

export interface AutoRefreshOptions {
  intervalMs: number;
  /** Start one refresh. The schedule waits for it to settle before arming the next. */
  refresh: () => Promise<unknown> | unknown;
  /** Epoch ms the shown data was fetched; null/0 when there is none yet. */
  lastUpdatedAt: () => number | null | undefined;
  /** A refresh started elsewhere (the Refresh button, the initial load) is in flight. */
  isBusy?: () => boolean;
  isHidden: () => boolean;
  now?: () => number;
}

export interface AutoRefresh {
  start(): void;
  stop(): void;
  /** Call from `visibilitychange`: pauses when hidden, resumes (at once if overdue) when shown. */
  visibilityChanged(): void;
}

/** How long until data fetched at `lastUpdatedAt` is `intervalMs` old; 0 when it already is, or there is none. */
export function nextRefreshDelay(lastUpdatedAt: number | null | undefined, now: number, intervalMs: number): number {
  if (!lastUpdatedAt) return 0;
  return Math.max(0, intervalMs - (now - lastUpdatedAt));
}

export function createAutoRefresh(options: AutoRefreshOptions): AutoRefresh {
  const { intervalMs } = options;
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    clear();
    // Hidden: arm nothing. `visibilityChanged` is what resumes, so a paused
    // page holds no timer at all rather than one that wakes to do nothing.
    if (!running || options.isHidden()) return;
    timer = setTimeout(() => void tick(), delayMs);
  };

  const tick = async () => {
    timer = null;
    if (!running || options.isHidden()) return;
    const due = nextRefreshDelay(options.lastUpdatedAt(), now(), intervalMs);
    // Something else refreshed since this timer was armed; wait out the remainder.
    if (due > 0) return schedule(due);
    if (inFlight || options.isBusy?.()) return schedule(intervalMs);
    inFlight = true;
    try {
      await options.refresh();
    } catch {
      // A failed refresh is the page's to show; the schedule just tries again later.
    } finally {
      inFlight = false;
    }
    // A full interval, not `nextRefreshDelay`: after a FAILED refresh the data
    // is still old, and re-deriving the delay from it would retry in a hot loop.
    schedule(intervalMs);
  };

  return {
    start() {
      running = true;
      schedule(nextRefreshDelay(options.lastUpdatedAt(), now(), intervalMs));
    },
    stop() {
      running = false;
      clear();
    },
    visibilityChanged() {
      if (options.isHidden()) clear();
      else schedule(nextRefreshDelay(options.lastUpdatedAt(), now(), intervalMs));
    },
  };
}
