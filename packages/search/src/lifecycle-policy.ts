/**
 * Lifecycle ranking policy (§3.5 item 3, §5.4).
 *
 * Stable and verified items rank above stale ones; deprecated items are shown
 * but demoted (their successor stays on the row); machine-generated unverified
 * items are demoted slightly. Pure: returns new hit objects, never mutates.
 */
import type { SearchHit } from '@echozedlabs/knowledge-types';

export interface LifecyclePolicyOptions {
  /** Multiplier for stale (`stale` or `needs-review`) hits. Default 0.85. */
  staleFactor?: number;
  /** Multiplier for deprecated / superseded / archived hits. Default 0.6. */
  deprecatedFactor?: number;
  /** Multiplier for `process:`/`agent:` generated hits still `unverified`. Default 0.9. */
  unverifiedMachineFactor?: number;
}

const DEFAULTS: Required<LifecyclePolicyOptions> = {
  staleFactor: 0.85,
  deprecatedFactor: 0.6,
  unverifiedMachineFactor: 0.9,
};

export function applyLifecyclePolicy(hits: SearchHit[], opts: LifecyclePolicyOptions = {}): SearchHit[] {
  const factors = { ...DEFAULTS, ...opts };

  const adjusted = hits.map((hit) => {
    let score = hit.score;
    const reasons = hit.reasons ? [...hit.reasons] : [];

    // Deprecation wins over staleness: a superseded item is not also "needs review".
    const deprecatedLabel = deprecationLabel(hit);
    if (deprecatedLabel) {
      score *= factors.deprecatedFactor;
      reasons.push(`${deprecatedLabel}: score ×${factors.deprecatedFactor}`);
    } else if (hit.stale === true || hit.display_state === 'needs-review') {
      score *= factors.staleFactor;
      reasons.push(`Stale (needs review): score ×${factors.staleFactor}`);
    }

    if (isMachineGenerated(hit.generated_by) && hit.trust_tier === 'unverified') {
      score *= factors.unverifiedMachineFactor;
      reasons.push(`Machine-generated, unverified (${hit.generated_by}): score ×${factors.unverifiedMachineFactor}`);
    }

    return score === hit.score ? hit : { ...hit, score, reasons };
  });

  // Array.prototype.sort is stable, so equal scores keep their incoming order.
  return adjusted.sort((a, b) => b.score - a.score);
}

function deprecationLabel(hit: SearchHit): string | null {
  if (hit.display_state === 'superseded') {
    return hit.superseded_by ? `Superseded by ${hit.superseded_by}` : 'Superseded';
  }
  if (hit.display_state === 'archived') return 'Archived';
  if (hit.lifecycle_status === 'deprecated') {
    return hit.superseded_by ? `Superseded by ${hit.superseded_by}` : 'Deprecated';
  }
  return null;
}

function isMachineGenerated(generatedBy: string | null | undefined): boolean {
  return !!generatedBy && (generatedBy.startsWith('process:') || generatedBy.startsWith('agent:'));
}
