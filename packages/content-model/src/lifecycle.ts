/**
 * Lifecycle: per-type review horizons and the derived reader-facing display state.
 * See the knowledge hub plan §6.1 (review horizon default per content type) and
 * `DisplayState` in `@echozedlabs/knowledge-types`.
 */
import { deriveLifecycle, normalizeLifecycle, okfSignals } from '@echozedlabs/okf';
import type { DisplayState, LifecycleSignals, LifecycleStatus, PublicationStatus, TrustTier } from '@echozedlabs/knowledge-types';
import { findContentType } from './registry.js';

/** Default days until `stale_after` per registry key. `null` = no freshness review. */
const REVIEW_HORIZON_DAYS: Record<string, number | null> = {
  'how-to': 365,
  concept: 365,
  'glossary-term': 365,
  'architecture-note': 365,
  runbook: 180,
  'troubleshooting-guide': 180,
  faq: 180,
  'known-issue': 90,
  'blog-post': null,
  'release-note': null,
  adr: null,
  series: null,
};

/**
 * Default review horizon (days until `stale_after`) for a content type given as
 * a label or key. `null` for types without a freshness review and for unknown types.
 */
export function reviewHorizonDays(typeLabelOrKey: string): number | null {
  const def = findContentType(typeLabelOrKey);
  return def ? (REVIEW_HORIZON_DAYS[def.key] ?? null) : null;
}

/** `LifecycleSignals` with every field resolved (null = absent) plus the display state. */
export interface DerivedDisplayState extends LifecycleSignals {
  display_state: DisplayState;
  lifecycle_status: LifecycleStatus;
  trust_tier: TrustTier;
  stale: boolean;
  stale_after: string | null;
  last_verified_at: string | null;
  generated_by: string | null;
  superseded_by: string | null;
}

/**
 * Derive what the reader sees from frontmatter and the E3 publication status.
 * Never stored. Rules:
 *   - draft publication ⇒ `draft`
 *   - published, OKF `status: deprecated` with a successor ⇒ `superseded`
 *   - published, deprecated without a successor ⇒ `archived`
 *   - published and past `stale_after` (as of `now`) ⇒ `needs-review`
 *   - otherwise ⇒ `published`
 * The successor is read from `superseded_by`, falling back to `replaced_by`.
 */
export function deriveDisplayState(
  frontmatter: Record<string, unknown>,
  publicationStatus: PublicationStatus,
  now?: Date | string,
): DerivedDisplayState {
  const signals = okfSignals(frontmatter, now);
  const lifecycle = normalizeLifecycle(frontmatter['status']) ?? deriveLifecycle(publicationStatus);
  const supersededBy = nonEmptyString(frontmatter['superseded_by']) ?? nonEmptyString(frontmatter['replaced_by']) ?? null;
  const stale = signals.freshness === 'stale';

  let display: DisplayState;
  if (publicationStatus === 'draft') display = 'draft';
  else if (lifecycle === 'deprecated') display = supersededBy ? 'superseded' : 'archived';
  else if (stale) display = 'needs-review';
  else display = 'published';

  return {
    display_state: display,
    lifecycle_status: lifecycle,
    trust_tier: signals.trustTier,
    stale,
    stale_after: signals.staleAfter ?? null,
    last_verified_at: signals.latestVerifiedAt ?? null,
    generated_by: signals.generatedBy ?? null,
    superseded_by: supersededBy,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
