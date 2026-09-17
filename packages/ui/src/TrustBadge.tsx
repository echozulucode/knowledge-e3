/**
 * TrustBadge — the OKF v0.2 trust tier, at one of three volumes.
 *
 * - `chip` (default): "Human-reviewed · date", "Machine-confirmed" or
 *   "Unverified" as a quiet chip. While an item is still unverified and was
 *   produced by a process/agent actor, an extra "AI-generated" chip is shown;
 *   once a human or machine has verified it, provenance stops being a warning.
 * - `mark`: for index surfaces (feeds, Sections, lists, search results). Renders
 *   NOTHING for an unverified item and a small muted check for a verified one.
 *   Eric, 2026-09-12: it is important to know whether an item is verified "when
 *   looking at it, but don't want it to be overbearing" — a warning repeated on
 *   every card trains readers to ignore it, and absence is not a claim.
 * - `inline`: for the article byline, where the decision to trust an item is
 *   made. Always shown, as quiet text with an icon rather than a chip, and it
 *   discloses a short explanation of what the tiers mean (home plan R2.4).
 *
 * The labels are not renamed at any volume: they display the OKF `trust_tier`
 * value.
 */
import { useId, useState } from 'react';
import type { TrustTier } from '@echozedlabs/knowledge-types';

export interface TrustBadgeProps {
  tier: TrustTier;
  /** ISO date of the latest verification; shown for `human-reviewed`. */
  verifiedAt?: string | null;
  /** OKF `generated.by` actor string, e.g. `process:okf-import` or `agent:claude`. */
  generatedBy?: string | null;
  /** How loudly to say it. See the file header. Default `chip`. */
  variant?: 'chip' | 'mark' | 'inline';
  className?: string;
}

const TIER_LABELS: Record<TrustTier, string> = {
  'human-reviewed': 'Human-reviewed',
  'machine-confirmed': 'Machine-confirmed',
  unverified: 'Unverified',
};

/** True when the actor is non-human (`process:` or `agent:` prefix). */
export function isMachineActor(generatedBy: string | null | undefined): boolean {
  return !!generatedBy && /^(process|agent):/.test(generatedBy);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

/** What each tier means, for the `inline` variant's disclosure. */
export const TRUST_TIER_EXPLANATIONS: Record<TrustTier, string> = {
  'human-reviewed': 'A person has reviewed this item against its sources and marked it verified.',
  'machine-confirmed': 'An automated check has confirmed this item against its sources. No person has reviewed it yet.',
  unverified: 'Nobody has reviewed this item yet. It may be accurate, but check important details before relying on it.',
};

function CheckGlyph() {
  return (
    <svg className="kp-trust-glyph" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d="M8 1.2a6.8 6.8 0 1 0 0 13.6A6.8 6.8 0 0 0 8 1.2Zm3.2 5.1-3.8 4a.75.75 0 0 1-1.08.02L4.8 8.8a.75.75 0 1 1 1.06-1.06l1 .99 3.26-3.44a.75.75 0 1 1 1.09 1.02Z" fill="currentColor" />
    </svg>
  );
}

function DotGlyph() {
  return (
    <svg className="kp-trust-glyph" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function TrustBadge({ tier, verifiedAt, generatedBy, variant = 'chip', className }: TrustBadgeProps) {
  const label = TIER_LABELS[tier];
  const text = tier === 'human-reviewed' && verifiedAt ? `${label} · ${formatDate(verifiedAt)}` : label;
  const showAiChip = tier === 'unverified' && isMachineActor(generatedBy);
  const [open, setOpen] = useState(false);
  const explanationId = useId();

  if (variant === 'mark') {
    if (tier === 'unverified') return null;
    return (
      <span
        className={className ? `kp-trust-mark ${className}` : 'kp-trust-mark'}
        data-tone={tier}
        role="img"
        aria-label={text}
        title={text}
      >
        <CheckGlyph />
      </span>
    );
  }

  if (variant === 'inline') {
    return (
      <span className={className ? `kp-trust-inline ${className}` : 'kp-trust-inline'}>
        <button
          type="button"
          className="kp-trust-inline__toggle"
          data-tone={tier}
          aria-expanded={open}
          aria-controls={explanationId}
          onClick={() => setOpen((v) => !v)}
        >
          {tier === 'unverified' ? <DotGlyph /> : <CheckGlyph />}
          <span className="kp-trust-inline__label">{text}</span>
        </button>
        {showAiChip ? (
          <span className="kp-badge" data-tone="ai-generated" title={generatedBy ?? undefined}>
            AI-generated
          </span>
        ) : null}
        <span id={explanationId} className="kp-trust-inline__explanation" role="note" hidden={!open}>
          {TRUST_TIER_EXPLANATIONS[tier]}
        </span>
      </span>
    );
  }

  return (
    <span className={className ? `kp-trust ${className}` : 'kp-trust'}>
      <span className="kp-badge" data-tone={tier} title={verifiedAt ?? undefined}>
        {text}
      </span>
      {showAiChip ? (
        <span className="kp-badge" data-tone="ai-generated" title={generatedBy ?? undefined}>
          AI-generated
        </span>
      ) : null}
    </span>
  );
}
