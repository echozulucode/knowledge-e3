/**
 * OKF v0.2 trust-tier and freshness derivation (spec §5.2, §5.3, §5.5).
 *
 * These signals are DERIVED from frontmatter, never stored — the same posture as
 * okf-mcp. A concept with no trust frontmatter is still fully consumable; nothing
 * here rejects a concept. Freshness is a pure `asOf` date comparison, so "what was
 * stale on date X" is answerable and reproducible.
 */
import type { OkfActorEvent, OkfFrontmatter, OkfTrustTier } from './types.js';
import { isHumanActor } from './actor.js';
import { isStale } from './lifecycle.js';

/**
 * Normalize the `verified` field to a list of events. A single verifier MAY be a
 * bare `{ by, at }` mapping; consumers MUST treat it as a one-element list
 * (spec §5.2/§11).
 */
export function normalizeVerified(value: unknown): OkfActorEvent[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: OkfActorEvent[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const by = (raw as Record<string, unknown>)['by'];
    if (typeof by !== 'string' || by.trim() === '') continue;
    const at = (raw as Record<string, unknown>)['at'];
    out.push(typeof at === 'string' ? { by, at } : at instanceof Date ? { by, at: at.toISOString() } : { by });
  }
  return out;
}

/**
 * Derive the trust tier from `verified` (spec §5.3), lowest to highest:
 * - no verification ⇒ `unverified`
 * - verified by non-`human:` actors only ⇒ `machine-confirmed`
 * - verified by at least one `human:<id>` actor ⇒ `human-reviewed`
 */
export function trustTier(fm: Record<string, unknown>): OkfTrustTier {
  const events = normalizeVerified(fm['verified']);
  if (events.length === 0) return 'unverified';
  return events.some((e) => isHumanActor(e.by)) ? 'human-reviewed' : 'machine-confirmed';
}

/** The most recent verification datetime (ISO string), or undefined. */
export function latestVerifiedAt(fm: Record<string, unknown>): string | undefined {
  const times = normalizeVerified(fm['verified'])
    .map((e) => e.at)
    .filter((a): a is string => typeof a === 'string')
    .sort();
  return times.length > 0 ? times[times.length - 1] : undefined;
}

/** A concept's derived freshness against an `asOf` date. */
export type Freshness = 'fresh' | 'stale';
export function freshness(fm: Record<string, unknown>, asOf?: string | Date): Freshness {
  return isStale(fm['stale_after'], asOf) ? 'stale' : 'fresh';
}

/**
 * A compact bundle of the derived + raw trust/provenance signals a consumer
 * (search index, read view, admin panel) needs. All optional-family absences are
 * represented, never rejected.
 */
export interface OkfSignals {
  trustTier: OkfTrustTier;
  freshness: Freshness;
  /** `generated.by`, when present. */
  generatedBy?: string;
  /** The distinct actors in `verified[]`. */
  verifiedBy: string[];
  latestVerifiedAt?: string;
  hasSources: boolean;
  staleAfter?: string;
}

/** Derive the full signal set for a concept's frontmatter as of `asOf`. */
export function okfSignals(fm: Record<string, unknown>, asOf?: string | Date): OkfSignals {
  const events = normalizeVerified(fm['verified']);
  const generated = fm['generated'];
  const generatedBy =
    generated && typeof generated === 'object' && !Array.isArray(generated)
      ? (() => {
          const by = (generated as Record<string, unknown>)['by'];
          return typeof by === 'string' ? by : undefined;
        })()
      : undefined;
  const staleAfterRaw = fm['stale_after'];
  const staleAfter =
    staleAfterRaw instanceof Date
      ? staleAfterRaw.toISOString().slice(0, 10)
      : typeof staleAfterRaw === 'string'
        ? staleAfterRaw
        : undefined;
  return {
    trustTier: events.some((e) => isHumanActor(e.by)) ? 'human-reviewed' : events.length ? 'machine-confirmed' : 'unverified',
    freshness: isStale(staleAfterRaw, asOf) ? 'stale' : 'fresh',
    generatedBy,
    verifiedBy: [...new Set(events.map((e) => e.by))],
    latestVerifiedAt: latestVerifiedAt(fm),
    hasSources: Array.isArray(fm['sources']) && (fm['sources'] as unknown[]).length > 0,
    staleAfter,
  };
}
