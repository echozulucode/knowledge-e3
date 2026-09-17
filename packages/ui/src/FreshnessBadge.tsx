/**
 * FreshnessBadge — the derived display state as a quiet chip. Plain `published`
 * renders nothing: the absence of a warning is the signal. "Needs review" uses
 * the warning tone; "Superseded" names the successor (the caller supplies
 * `renderLink` to make it navigable — this package never routes). "In review"
 * (plan §8.2 review mode) uses the info tone and links to the change request
 * when `reviewUrl` is given AND the caller says this reader can act on it.
 *
 * The link used to read "PR" and point at a raw forge URL (reader UX plan §6,
 * R4.2). "PR" is plumbing, and a reader who cannot write has nowhere to go with
 * it, so `canOpenReview` is opt-in: every list surface renders the state as
 * plain text, and only the surfaces that know the reader may act — the article
 * and Compose — offer the link.
 */
import type { ReactNode } from 'react';
import type { DisplayState } from '@echozedlabs/knowledge-types';

/** `DisplayState` plus the review-mode state an item carries while its PR is open. */
export type FreshnessDisplayState = DisplayState | 'in-review';

export interface FreshnessBadgeProps {
  displayState: FreshnessDisplayState | null | undefined;
  /** ISO date after which the item is considered stale; shown as the title for `needs-review`. */
  staleAfter?: string | null;
  /** Successor item id/slug when `superseded`. */
  supersededBy?: string | null;
  /** Renders the successor reference; defaults to plain text. */
  renderLink?: (slug: string) => ReactNode;
  /** Change-request URL when `in-review`; rendered as an external link. */
  reviewUrl?: string | null;
  /** Whether this reader may act on the change; false renders the state as text. */
  canOpenReview?: boolean;
  /** Renders the change-request link; defaults to a plain anchor opening in a new tab. */
  renderReviewLink?: (url: string) => ReactNode;
  className?: string;
}

const STATE_LABELS: Partial<Record<FreshnessDisplayState, string>> = {
  'needs-review': 'Needs review',
  superseded: 'Superseded',
  archived: 'Archived',
  draft: 'Draft',
  'in-review': 'In review',
};

export function FreshnessBadge({
  displayState,
  staleAfter,
  supersededBy,
  renderLink,
  reviewUrl,
  canOpenReview = false,
  renderReviewLink,
  className,
}: FreshnessBadgeProps) {
  const label = displayState ? STATE_LABELS[displayState] : undefined;
  if (!displayState || !label) return null;
  const isWarning = displayState === 'needs-review';
  const successor = displayState === 'superseded' && supersededBy ? supersededBy : null;
  const review = displayState === 'in-review' && canOpenReview && reviewUrl ? reviewUrl : null;
  return (
    <span
      className={className ? `kp-badge ${className}` : 'kp-badge'}
      data-tone={displayState}
      role={isWarning ? 'status' : undefined}
      title={isWarning && staleAfter ? `Stale after ${staleAfter}` : undefined}
    >
      {label}
      {successor ? (
        <>
          {' → '}
          {renderLink ? renderLink(successor) : successor}
        </>
      ) : null}
      {review ? (
        <>
          {' · '}
          {renderReviewLink ? (
            renderReviewLink(review)
          ) : (
            <a href={review} target="_blank" rel="noreferrer">
              View the change
            </a>
          )}
        </>
      ) : null}
    </span>
  );
}
