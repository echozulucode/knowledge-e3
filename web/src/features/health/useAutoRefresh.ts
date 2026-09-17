/**
 * `createAutoRefresh` bound to the document's visibility, for a page over one
 * TanStack query. See autoRefresh.ts for the schedule's rules; this only wires
 * it to React's lifecycle and to `visibilitychange`.
 */
import { useEffect, useRef } from 'react';
import { createAutoRefresh } from './autoRefresh.js';

export interface UseAutoRefreshOptions {
  intervalMs: number;
  refresh: () => Promise<unknown> | unknown;
  /** `dataUpdatedAt`. */
  updatedAt: number | null | undefined;
  /** `isFetching`: a refresh already in flight is never joined by another. */
  busy: boolean;
  enabled?: boolean;
}

export function useAutoRefresh({ intervalMs, refresh, updatedAt, busy, enabled = true }: UseAutoRefreshOptions): void {
  // The scheduler outlives renders; it reads the latest values through a ref
  // rather than being torn down and re-armed (and its clock reset) on each one.
  const latest = useRef({ refresh, updatedAt, busy });
  latest.current = { refresh, updatedAt, busy };

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const auto = createAutoRefresh({
      intervalMs,
      refresh: () => latest.current.refresh(),
      lastUpdatedAt: () => latest.current.updatedAt,
      isBusy: () => latest.current.busy,
      isHidden: () => document.visibilityState === 'hidden',
    });
    const onVisibility = () => auto.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    auto.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      auto.stop();
    };
  }, [intervalMs, enabled]);
}
