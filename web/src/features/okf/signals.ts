/**
 * Client-side derivation of OKF v0.2 trust/freshness signals from a page's
 * frontmatter, for display in the read view. This intentionally mirrors
 * `@echozedlabs/okf`'s `trustTier` / `freshness` / `okfSignals` (spec §5.3, §5.5)
 * — kept as a tiny local copy so the web bundle needs no extra workspace
 * dependency. If it drifts, the package is the source of truth.
 */

export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export interface OkfDisplaySignals {
  trustTier: OkfTrustTier;
  /** True when past `stale_after` as of now. */
  stale: boolean;
  /** The `stale_after` date string, if any. */
  staleAfter?: string;
  /** Count of `sources` entries. */
  sourceCount: number;
}

interface ActorEvent {
  by?: unknown;
}

function verifiedEvents(value: unknown): ActorEvent[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter((e): e is ActorEvent => !!e && typeof e === 'object' && !Array.isArray(e));
}

/** Trust tier from `verified` (spec §5.3): human: prefix ⇒ human-reviewed. */
export function trustTier(frontmatter: Record<string, unknown> | undefined): OkfTrustTier {
  const events = verifiedEvents(frontmatter?.['verified']);
  if (events.length === 0) return 'unverified';
  const anyHuman = events.some((e) => typeof e.by === 'string' && e.by.startsWith('human:'));
  return anyHuman ? 'human-reviewed' : 'machine-confirmed';
}

/** Coerce a `stale_after` value (string or Date) to a YYYY-MM-DD string. */
function staleAfterOf(frontmatter: Record<string, unknown> | undefined): string | undefined {
  const raw = frontmatter?.['stale_after'];
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/** Derive the display signal set from a page's frontmatter, as of now. */
export function okfDisplaySignals(frontmatter: Record<string, unknown> | undefined): OkfDisplaySignals {
  const staleAfter = staleAfterOf(frontmatter);
  const cutoff = staleAfter ? new Date(staleAfter) : undefined;
  const stale = !!cutoff && !Number.isNaN(cutoff.getTime()) && Date.now() >= cutoff.getTime();
  const sources = frontmatter?.['sources'];
  return {
    trustTier: trustTier(frontmatter),
    stale,
    staleAfter,
    sourceCount: Array.isArray(sources) ? sources.length : 0,
  };
}

/** A short human label for a trust tier. */
export function trustTierLabel(tier: OkfTrustTier): string {
  switch (tier) {
    case 'human-reviewed':
      return 'Human-reviewed';
    case 'machine-confirmed':
      return 'Machine-confirmed';
    default:
      return 'Unverified';
  }
}
