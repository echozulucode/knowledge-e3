/**
 * Recent searches — the MRU list the header's quick search shows on an empty
 * query (Eric, 2026-09-12: "a quick search that has an MRU like search text or
 * searches performed by the user").
 *
 * STORAGE DECISION. Recents live in this browser's `localStorage` only, under
 * `kp.recentSearches.v1:<userId|anon>`:
 *
 *  - **Per browser, not per server.** What people search for is not retained
 *    anywhere new: no endpoint, no table, nothing an admin or a backup can read.
 *    Clearing site data (or "Clear recent searches") is a complete erase.
 *  - **Keyed by account.** Two people who share a machine each see only their
 *    own list; a signed-out visitor gets the `anon` list, which a signed-in
 *    account never reads.
 *  - **Versioned key** (`v1`), so a later shape change starts clean instead of
 *    misreading old data.
 *  - **Storage is optional.** Private windows, blocked storage and quota errors
 *    all throw; every read and write here is wrapped, and the palette simply
 *    shows no recents rather than breaking search.
 *
 * WHAT COUNTS AS A SEARCH is decided by the callers, not here: submitting to
 * `/search` (from the palette or the page's own box), or opening a result from
 * the palette while the query is non-empty. Typing alone never records.
 *
 * Everything below except `browserStorage` is pure, so it is unit-tested with a
 * fake storage in `recentSearches.test.ts`.
 */

/** The MRU is a jump list, not a history: eight is what fits without scrolling. */
export const RECENT_SEARCHES_MAX = 8;

const KEY_PREFIX = 'kp.recentSearches.v1:';

/** The slice of `Storage` this module needs — a fake satisfies it in tests. */
export type RecentSearchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The storage key for one account, or the shared signed-out list. */
export function recentSearchesKey(userId: string | null | undefined): string {
  const id = typeof userId === 'string' ? userId.trim() : '';
  return `${KEY_PREFIX}${id || 'anon'}`;
}

/**
 * `query` at the front, any case-insensitive duplicate dropped (the latest
 * casing wins, because it is what the reader typed last), capped at `max`.
 * A blank query changes nothing.
 */
export function addRecentSearch(list: readonly string[], query: string, max = RECENT_SEARCHES_MAX): string[] {
  const trimmed = query.trim();
  if (!trimmed) return normalizeList(list, max);
  return normalizeList([trimmed, ...list], max);
}

/** Drop one entry, compared the same way `addRecentSearch` de-dupes. */
export function removeRecentSearch(list: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return list.filter((entry) => entry.trim().toLowerCase() !== needle);
}

/**
 * The stored list, most recent first. Anything that is not a JSON array of
 * strings — hand-edited, truncated, from another version — reads as empty
 * rather than throwing into the header.
 */
export function readRecentSearches(storage: RecentSearchStorage | null | undefined, key: string): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeList(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return [];
  }
}

/** Persist `list`; returns false when storage refused (the caller keeps going). */
export function writeRecentSearches(storage: RecentSearchStorage | null | undefined, key: string, list: readonly string[]): boolean {
  if (!storage) return false;
  try {
    if (list.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(normalizeList(list)));
    return true;
  } catch {
    return false;
  }
}

/** Read, add, write. Returns the new list even if the write failed. */
export function recordRecentSearch(storage: RecentSearchStorage | null | undefined, key: string, query: string): string[] {
  const next = addRecentSearch(readRecentSearches(storage, key), query);
  writeRecentSearches(storage, key, next);
  return next;
}

/** Read, remove one, write. */
export function forgetRecentSearch(storage: RecentSearchStorage | null | undefined, key: string, query: string): string[] {
  const next = removeRecentSearch(readRecentSearches(storage, key), query);
  writeRecentSearches(storage, key, next);
  return next;
}

/** Erase this account's list entirely (the key is removed, not set to `[]`). */
export function clearRecentSearches(storage: RecentSearchStorage | null | undefined, key: string): void {
  writeRecentSearches(storage, key, []);
}

/**
 * `window.localStorage`, or null where merely touching it throws (sandboxed
 * iframes, some privacy modes) or where there is no window (tests, SSR).
 */
export function browserStorage(): RecentSearchStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function normalizeList(list: readonly string[], max = RECENT_SEARCHES_MAX): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    const trimmed = entry.trim();
    const folded = trimmed.toLowerCase();
    if (!trimmed || seen.has(folded)) continue;
    seen.add(folded);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}
