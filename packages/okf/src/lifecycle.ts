/**
 * OKF v0.2 lifecycle helpers (spec §5.4, §5.5).
 *
 * `status` carries the v0.2 vocabulary (`draft | stable | deprecated`); E3's
 * publish flag lives separately under `e3_status` (see the OKF v0.2 migration notes).
 * `stale_after` is an absolute date compared against a caller-supplied `asOf`, so
 * staleness is a pure, reproducible date comparison with no hidden "now".
 */
import type { OkfLifecycle } from './types.js';

const LIFECYCLE_VALUES: ReadonlySet<string> = new Set(['draft', 'stable', 'deprecated']);

/**
 * Return the value iff it is a valid v0.2 lifecycle string, else undefined.
 * Case- and whitespace-insensitive. Used to tell a real lifecycle value from an
 * E3 governance/publish value (which is moved to `review_status` instead).
 */
export function normalizeLifecycle(value: unknown): OkfLifecycle | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  return LIFECYCLE_VALUES.has(s) ? (s as OkfLifecycle) : undefined;
}

/**
 * Derive a v0.2 lifecycle from E3's binary publish flag when the source did not
 * specify one: `published` ⇒ `stable`, anything else (draft/undefined) ⇒ `draft`.
 * E3 has no `deprecated` state, so `deprecated` only ever comes from an explicit
 * source value (preserved on export).
 */
export function deriveLifecycle(e3Status?: string | null): OkfLifecycle {
  return String(e3Status ?? '').trim().toLowerCase() === 'published' ? 'stable' : 'draft';
}

/**
 * E3 governance `review_status` values that mean a concept is no longer current,
 * and so map to the v0.2 lifecycle `deprecated` (the one lifecycle E3's binary
 * publish flag cannot express). See the OKF v0.2 migration notes.
 */
const DEPRECATED_REVIEW_STATUSES: ReadonlySet<string> = new Set(['superseded', 'invalidated']);

/** True iff a governance `review_status` value denotes a deprecated concept. */
export function isDeprecatedReviewStatus(value: unknown): boolean {
  return typeof value === 'string' && DEPRECATED_REVIEW_STATUSES.has(value.trim().toLowerCase());
}

/**
 * A concept is stale when `today >= stale_after` (spec §5.5). `asOf` defaults to
 * the current date; pass an explicit date (`YYYY-MM-DD` or Date) to ask "was this
 * stale as of date X". Returns false when there is no `stale_after`.
 */
export function isStale(staleAfter: unknown, asOf?: string | Date): boolean {
  const cutoff = toDate(staleAfter);
  if (!cutoff) return false;
  const at = asOf ? toDate(asOf) : new Date();
  if (!at) return false;
  return at.getTime() >= cutoff.getTime();
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
