/**
 * useRecentSearches — the current account's MRU list (see `recentSearches.ts`
 * for the storage decision and what counts as a search).
 *
 * The account comes from `useMe()`: a resolved user reads their own key, a
 * failed `/me` (a signed-out visitor in public read mode) reads `anon`, and
 * while `/me` is still loading there is NO key — recording is a no-op and the
 * list is empty, so a signed-in reader never briefly sees the anonymous list.
 *
 * The palette and `/search` both write, in different components; a same-tab
 * event keeps every mounted copy in step, and the browser's own `storage`
 * event does the same across tabs.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../../queries.js';
import {
  browserStorage,
  clearRecentSearches,
  forgetRecentSearch,
  readRecentSearches,
  recentSearchesKey,
  recordRecentSearch,
} from './recentSearches.js';

const CHANGED_EVENT = 'kp:recent-searches-changed';

export interface RecentSearchesApi {
  /** Most recent first; empty when storage is unavailable or the account is unknown yet. */
  searches: string[];
  record: (query: string) => void;
  remove: (query: string) => void;
  clear: () => void;
}

export function useRecentSearches(): RecentSearchesApi {
  const { data: user, isLoading } = useMe();
  const key = isLoading ? null : recentSearchesKey(user?.id);

  const [searches, setSearches] = useState<string[]>(() => (key ? readRecentSearches(browserStorage(), key) : []));

  useEffect(() => {
    if (!key) {
      setSearches([]);
      return;
    }
    const refresh = () => setSearches(readRecentSearches(browserStorage(), key));
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    window.addEventListener(CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  const apply = useCallback(
    (change: (storageKey: string) => string[]) => {
      if (!key) return;
      setSearches(change(key));
      window.dispatchEvent(new Event(CHANGED_EVENT));
    },
    [key],
  );

  const record = useCallback((query: string) => apply((k) => recordRecentSearch(browserStorage(), k, query)), [apply]);
  const remove = useCallback((query: string) => apply((k) => forgetRecentSearch(browserStorage(), k, query)), [apply]);
  const clear = useCallback(
    () =>
      apply((k) => {
        clearRecentSearches(browserStorage(), k);
        return [];
      }),
    [apply],
  );

  return { searches, record, remove, clear };
}
