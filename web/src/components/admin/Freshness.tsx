/**
 * Freshness — "checked 14 s ago · Refresh" (the admin UX review §3.2).
 *
 * Use it on any admin page whose body is a snapshot the server computed
 * (Content health, System health): it says how old the numbers are and offers
 * the one way to get new ones. Pass it as AdminPageHeader's `meta` or
 * `secondaryActions`.
 *
 * `updatedAt` is epoch ms — TanStack Query's `dataUpdatedAt` fits directly; for
 * several queries pass the OLDEST (the page is only as fresh as its stalest part).
 * While `refreshing`, the button is disabled and says so in text, and the label
 * is announced politely so a screen-reader user hears the refresh land.
 */
import { useEffect, useState } from 'react';
import { freshnessAgo, freshnessTickMs } from './Freshness.model.js';
import './Freshness.css';

export interface FreshnessProps {
  updatedAt: number | null | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Verb before the age: "checked" (default), "updated", "fetched". */
  verb?: string;
}

export function Freshness({ updatedAt, onRefresh, refreshing = false, verb = 'checked' }: FreshnessProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setTimeout(() => setNow(Date.now()), freshnessTickMs(updatedAt, Date.now()));
    return () => window.clearTimeout(id);
    // `now` in the deps re-arms the timer after each tick with the right interval.
  }, [updatedAt, now]);

  // A refetch lands with a newer updatedAt before the next tick: never show a
  // negative age or a stale "3 min ago" for data fetched this instant.
  const ago = freshnessAgo(updatedAt, Math.max(now, updatedAt ?? 0));
  const absolute = updatedAt ? new Date(updatedAt).toLocaleString() : undefined;
  return (
    <span className="kp-freshness" data-testid="freshness">
      <span className="kp-freshness__label" aria-live="polite" title={absolute}>
        {refreshing ? 'Refreshing…' : ago ? `${capitalise(verb)} ${ago}` : 'Not checked yet'}
      </span>
      {onRefresh ? (
        <>
          <span className="kp-freshness__sep" aria-hidden="true">·</span>
          <button type="button" className="kp-freshness__refresh" onClick={onRefresh} disabled={refreshing}>
            Refresh
          </button>
        </>
      ) : null}
    </span>
  );
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
