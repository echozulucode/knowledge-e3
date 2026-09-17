/**
 * Pure helpers for Admin → Audit: who a row names as its actor, and how the
 * page's date filter (a preset, or local From/To days) becomes the instants the
 * server filters on. Kept out of the page so they can be unit-tested without a
 * router.
 */
import type { AuditRecord } from './queries.js';

export type AuditActor =
  /** A current account; `username` can drive the Actor filter. */
  | { kind: 'user'; label: string; username: string }
  /** Nobody was signed in: a failed or throttled sign-in. */
  | { kind: 'anonymous'; label: string }
  /** An account id with no matching user any more; `id` still filters. */
  | { kind: 'deleted'; label: string; id: string }
  /** Written by the server itself (retention, backup drills). */
  | { kind: 'system'; label: string };

export const ANONYMOUS_LABEL = '(anonymous)';

/**
 * The actor as an administrator should read it.
 *
 * Everything needed is already on the row. The server writes `actor_id: null`
 * for sign-in failures on purpose (auth.controller.ts: the id would say whether
 * the account exists). Labelling those "system" said the product did something
 * that a stranger at the login form actually did. The name they TRIED is not
 * who they are, so it is not the actor either: it belongs to the summary
 * (`as "bob" from 10.0.0.9`), where it reads as what was attempted. A non-null
 * `actor_id` that resolves to no username is an account that is gone - that is
 * a person, not the system, either.
 */
export function auditActor(row: Pick<AuditRecord, 'actor_id' | 'actor_username' | 'action' | 'payload'>): AuditActor {
  if (row.actor_username) return { kind: 'user', label: row.actor_username, username: row.actor_username };
  if (row.actor_id) return { kind: 'deleted', label: 'deleted account', id: row.actor_id };
  if (row.action.startsWith('auth.')) return { kind: 'anonymous', label: ANONYMOUS_LABEL };
  return { kind: 'system', label: 'system' };
}

/** Minutes EAST of UTC in effect at an instant (UTC−5 → -300). */
export type ZoneOffset = (at: Date) => number;

/** This browser's zone. `getTimezoneOffset` is positive WEST of UTC, hence the flip. */
export const browserZone: ZoneOffset = (at) => -at.getTimezoneOffset();

/** A zone with no DST, for tests and for callers that know the offset. */
export function fixedZone(minutesEast: number): ZoneOffset {
  return () => minutesEast;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A `YYYY-MM-DD` day as the instant it starts in `zone` (the browser's, by
 * default); `offsetDays` shifts the day first, for an exclusive upper bound.
 *
 * The server reads a bare date as UTC midnight, but the table labels each row
 * with its local date: west of UTC an evening entry labelled "Sep 11" is already
 * Sep 12 in UTC, so "To: Sep 11" silently dropped it. The day is shifted on the
 * calendar (not by adding 24h), and the offset is read AT the resulting instant
 * and settled once more, so a day that is 23 or 25 hours long across a DST
 * change still ends at the next local midnight.
 *
 * Anything that is not a bare date (an ISO instant from a shared link) is passed
 * through unchanged; the server validates it.
 */
export function localDayInstant(value: string, offsetDays = 0, zone: ZoneOffset = browserZone): string {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) return value;
  const [, y, m, d] = match;
  const wall = Date.UTC(Number(y), Number(m) - 1, Number(d) + offsetDays);
  if (Number.isNaN(wall)) return value;
  const first = wall - zone(new Date(wall)) * 60_000;
  const settled = wall - zone(new Date(first)) * 60_000;
  return new Date(settled).toISOString();
}

/** `since` → start of that local day (inclusive); `until` → start of the NEXT
 * local day (exclusive), so the whole chosen day is included. */
export function auditWindow(
  filters: { since?: string; until?: string },
  zone: ZoneOffset = browserZone,
): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  if (filters.since?.trim()) out.since = localDayInstant(filters.since, 0, zone);
  if (filters.until?.trim()) out.until = localDayInstant(filters.until, 1, zone);
  return out;
}

export type AuditRangePreset = '24h' | '7d' | '30d';

export const RANGE_PRESETS: readonly { value: AuditRangePreset; label: string; hours: number }[] = [
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 7 * 24 },
  { value: '30d', label: 'Last 30 days', hours: 30 * 24 },
];

/**
 * A preset is a ROLLING window ending now: "last 24 hours" at 09:00 includes
 * yesterday 10:00, which a "since the start of yesterday" reading would
 * disagree about by a whole morning. `at` is pinned by the caller for a whole
 * paging session, so "Load older" does not move the window under the cursor.
 */
export function presetSince(preset: AuditRangePreset, at: number): string {
  const hours = RANGE_PRESETS.find((p) => p.value === preset)?.hours ?? 24;
  return new Date(at - hours * 60 * 60 * 1000).toISOString();
}

/**
 * "UTC−5", "UTC+5:30", "UTC" for the offset in effect at `at`. Uses the true
 * minus sign.
 */
export function utcOffsetLabel(at: Date = new Date(), zone: ZoneOffset = browserZone): string {
  const minutes = zone(at);
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/** Short local time for the table: "Sep 13, 20:12". */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Full local time for the detail: "2026-09-13 18:02:11". Built from local fields so it sorts and reads the same everywhere. */
export function exactLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The same instant in UTC: "23:02:11 UTC", with the date when it differs from the local one. */
export function exactUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const [date, time] = d.toISOString().split('T') as [string, string];
  const localDate = exactLocal(iso).slice(0, 10);
  return `${date === localDate ? '' : `${date} `}${time.slice(0, 8)} UTC`;
}
