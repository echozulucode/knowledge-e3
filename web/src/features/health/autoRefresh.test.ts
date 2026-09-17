import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoRefresh, nextRefreshDelay } from './autoRefresh.js';

const INTERVAL = 30_000;

/** A page over one query: data age, visibility and an in-flight flag the test controls. */
function harness(opts: { updatedAt?: number | null; slowMs?: number } = {}) {
  const state = { hidden: false, busy: false, updatedAt: opts.updatedAt === undefined ? Date.now() : opts.updatedAt, calls: 0 };
  const refresh = vi.fn(async () => {
    state.calls += 1;
    if (opts.slowMs) await new Promise((resolve) => setTimeout(resolve, opts.slowMs));
    state.updatedAt = Date.now();
  });
  const auto = createAutoRefresh({
    intervalMs: INTERVAL,
    refresh,
    lastUpdatedAt: () => state.updatedAt,
    isBusy: () => state.busy,
    isHidden: () => state.hidden,
  });
  return { state, refresh, auto };
}

describe('nextRefreshDelay', () => {
  it('is the rest of the interval for fresh data, and 0 for overdue or absent data', () => {
    expect(nextRefreshDelay(1_000, 11_000, INTERVAL)).toBe(20_000);
    expect(nextRefreshDelay(1_000, 41_000, INTERVAL)).toBe(0);
    expect(nextRefreshDelay(null, 41_000, INTERVAL)).toBe(0);
    expect(nextRefreshDelay(0, 41_000, INTERVAL)).toBe(0);
  });
});

describe('createAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes every 30 s while the tab is visible', async () => {
    const { refresh, auto } = harness();
    auto.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('pauses while hidden, holds no timer, and resumes at once on return when overdue', async () => {
    const { state, refresh, auto } = harness();
    auto.start();
    await vi.advanceTimersByTimeAsync(10_000);

    state.hidden = true;
    auto.visibilityChanged();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();

    state.hidden = false;
    auto.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it('on return before the data is due, waits only for the remainder', async () => {
    const { state, refresh, auto } = harness();
    auto.start();
    await vi.advanceTimersByTimeAsync(5_000);
    state.hidden = true;
    auto.visibilityChanged();
    await vi.advanceTimersByTimeAsync(5_000);
    state.hidden = false;
    auto.visibilityChanged();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it('a timer that fires while hidden (no visibilitychange yet) does nothing', async () => {
    const { state, refresh, auto } = harness();
    auto.start();
    state.hidden = true;
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(refresh).not.toHaveBeenCalled();
    auto.stop();
  });

  it('never stacks: a refresh already in flight elsewhere is not joined', async () => {
    const { state, refresh, auto } = harness();
    auto.start();
    state.busy = true;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(refresh).not.toHaveBeenCalled();
    state.busy = false;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it('never stacks its own: a slow refresh is finished before the next is armed', async () => {
    const { refresh, auto } = harness({ slowMs: 45_000 });
    auto.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Past where a naive setInterval would have fired a second time.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it('a manual refresh pushes the next automatic one a full interval out', async () => {
    const { state, refresh, auto } = harness();
    auto.start();
    await vi.advanceTimersByTimeAsync(25_000);
    state.updatedAt = Date.now(); // the Refresh button landed
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    auto.stop();
  });

  it('a failed refresh retries a full interval later, not in a loop', async () => {
    const failing = vi.fn(async () => {
      throw new Error('503');
    });
    const auto = createAutoRefresh({ intervalMs: INTERVAL, refresh: failing, lastUpdatedAt: () => 0, isHidden: () => false });
    auto.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('stop() leaves nothing armed and ignores a refresh that settles afterwards', async () => {
    const { refresh, auto } = harness({ slowMs: 1_000 });
    auto.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    auto.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
