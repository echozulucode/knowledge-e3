import { describe, expect, it } from 'vitest';
import {
  addRecentSearch,
  clearRecentSearches,
  forgetRecentSearch,
  readRecentSearches,
  recentSearchesKey,
  recordRecentSearch,
  removeRecentSearch,
  RECENT_SEARCHES_MAX,
  writeRecentSearches,
  type RecentSearchStorage,
} from './recentSearches.js';

/** An in-memory Storage, so the module is tested without a browser. */
function memoryStorage(initial: Record<string, string> = {}): RecentSearchStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
}

/** Storage that throws on every call — a private window or blocked site data. */
const throwingStorage: RecentSearchStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

const KEY = recentSearchesKey('user-1');

describe('recent searches', () => {
  it('keys the list by account, with a shared signed-out list', () => {
    expect(recentSearchesKey('user-1')).toBe('kp.recentSearches.v1:user-1');
    expect(recentSearchesKey(undefined)).toBe('kp.recentSearches.v1:anon');
    expect(recentSearchesKey('  ')).toBe('kp.recentSearches.v1:anon');
    expect(recentSearchesKey('user-1')).not.toBe(recentSearchesKey('user-2'));
  });

  it('adds the newest search first, trimmed', () => {
    expect(addRecentSearch(['mqtt'], '  broker  ')).toEqual(['broker', 'mqtt']);
  });

  it('ignores a blank search', () => {
    expect(addRecentSearch(['mqtt'], '   ')).toEqual(['mqtt']);
    expect(addRecentSearch([], '')).toEqual([]);
  });

  it('de-dupes case-insensitively and keeps the latest casing at the front', () => {
    expect(addRecentSearch(['broker', 'MQTT', 'gateway'], 'mqtt')).toEqual(['mqtt', 'broker', 'gateway']);
  });

  it('caps the list, dropping the oldest', () => {
    let list: string[] = [];
    for (let i = 1; i <= RECENT_SEARCHES_MAX + 3; i++) list = addRecentSearch(list, `term ${i}`);
    expect(list).toHaveLength(RECENT_SEARCHES_MAX);
    expect(list[0]).toBe(`term ${RECENT_SEARCHES_MAX + 3}`);
    expect(list).not.toContain('term 1');
  });

  it('removes one entry regardless of case or padding', () => {
    expect(removeRecentSearch(['mqtt', 'Broker'], ' broker ')).toEqual(['mqtt']);
    expect(removeRecentSearch(['mqtt'], 'absent')).toEqual(['mqtt']);
  });

  it('round-trips through storage and records most-recent-first', () => {
    const storage = memoryStorage();
    recordRecentSearch(storage, KEY, 'mqtt');
    recordRecentSearch(storage, KEY, 'broker');
    recordRecentSearch(storage, KEY, 'MQTT');
    expect(readRecentSearches(storage, KEY)).toEqual(['MQTT', 'broker']);
    // Another account on the same browser sees nothing of it.
    expect(readRecentSearches(storage, recentSearchesKey('user-2'))).toEqual([]);
    expect(readRecentSearches(storage, recentSearchesKey(null))).toEqual([]);
  });

  it('forgets one entry and clears the whole list', () => {
    const storage = memoryStorage();
    recordRecentSearch(storage, KEY, 'a');
    recordRecentSearch(storage, KEY, 'b');
    expect(forgetRecentSearch(storage, KEY, 'a')).toEqual(['b']);
    expect(readRecentSearches(storage, KEY)).toEqual(['b']);
    clearRecentSearches(storage, KEY);
    expect(readRecentSearches(storage, KEY)).toEqual([]);
    // Clearing removes the key rather than leaving an empty array behind.
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('tolerates corrupt or foreign stored data', () => {
    for (const raw of ['{not json', '"a string"', '{"q":"mqtt"}', 'null', '42']) {
      expect(readRecentSearches(memoryStorage({ [KEY]: raw }), KEY)).toEqual([]);
    }
    // A mixed array keeps its usable strings, normalised.
    const mixed = memoryStorage({ [KEY]: JSON.stringify(['mqtt', 7, null, ' ', 'MQTT', ' broker ']) });
    expect(readRecentSearches(mixed, KEY)).toEqual(['mqtt', 'broker']);
    // And recording over corrupt data replaces it with a valid list.
    const corrupt = memoryStorage({ [KEY]: '{not json' });
    expect(recordRecentSearch(corrupt, KEY, 'mqtt')).toEqual(['mqtt']);
    expect(JSON.parse(corrupt.data.get(KEY)!)).toEqual(['mqtt']);
  });

  it('works without storage: nothing is remembered and nothing throws', () => {
    expect(readRecentSearches(throwingStorage, KEY)).toEqual([]);
    expect(writeRecentSearches(throwingStorage, KEY, ['mqtt'])).toBe(false);
    expect(recordRecentSearch(throwingStorage, KEY, 'mqtt')).toEqual(['mqtt']);
    expect(forgetRecentSearch(throwingStorage, KEY, 'mqtt')).toEqual([]);
    expect(() => clearRecentSearches(throwingStorage, KEY)).not.toThrow();

    expect(readRecentSearches(null, KEY)).toEqual([]);
    expect(recordRecentSearch(undefined, KEY, 'mqtt')).toEqual(['mqtt']);
    expect(writeRecentSearches(null, KEY, ['mqtt'])).toBe(false);
  });
});
