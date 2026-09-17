/**
 * Pure helpers for Freshness ("checked 14 s ago · Refresh",
 * the admin UX review §3.2). Kept out of the component so the
 * wording is unit-testable without a clock or a DOM.
 */

/**
 * How long ago `updatedAt` (epoch ms, e.g. TanStack Query's `dataUpdatedAt`)
 * was, as an admin reads it at a glance: `just now`, `14 s ago`, `3 min ago`,
 * `2 h ago`, `4 d ago`. Null/0 (never fetched) → null so the caller can show
 * nothing rather than "56 years ago".
 */
export function freshnessAgo(updatedAt: number | null | undefined, now: number = Date.now()): string | null {
  if (!updatedAt) return null;
  // A clock skew or a same-tick render can give a small negative: still "just now".
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * How often the label needs re-rendering: every second while it shows seconds,
 * then every 30 s — a page left open for an hour should not re-render 3,600 times.
 */
export function freshnessTickMs(updatedAt: number | null | undefined, now: number = Date.now()): number {
  if (!updatedAt) return 30_000;
  return now - updatedAt < 60_000 ? 1_000 : 30_000;
}
