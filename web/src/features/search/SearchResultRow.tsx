/**
 * SearchResultRow — one search result: the title (two lines), the snippet, and
 * ONE quiet metadata line (home plan R2.4, applied to search):
 *
 *   `Architecture · Runbook · Updated Sep 8 · [Draft] · [✓]`
 *
 * Shared by the command palette, `/search` and the browse "By type" view; the
 * caller owns the clickable wrapper and routing.
 *
 * The row used to carry a content-type chip beside the title and a row of chips
 * under it — topic, "Published", "Title match", "Body match", "Recently
 * updated", a full locale date — the same clutter the home page's review
 * flagged. What is left, and why:
 *
 * - **Type is text, not a chip.** Every surface that renders this row already
 *   groups results under a type heading; the word in the line is for a row read
 *   out of that context, and it does not need a coloured shape to be read.
 * - **A chip only for a state worth a word** — In review, Draft, Superseded,
 *   Archived, Needs review (`displayStateForHit`). Plain published says nothing,
 *   and recency is the date.
 * - **The trust tier is the `mark` volume**: nothing for unverified, a small
 *   muted check once verified. The article is where the tier is stated in words.
 * - **Match reasons are not shown.** The snippet already shows why a result
 *   matched; which fields matched survives only as `data-match` (e.g.
 *   `"title body"`), for tests and tooling — never as visible or spoken text.
 *
 * - **Where it matched is `<mark>`**, from the server's `highlights` ranges
 *   (`renderHighlighted`), in the title and the snippet. The client never
 *   re-runs a match; no ranges (an older server, a browse row) is plain text.
 *   A snippet the server cut mid-body says so with a leading/trailing `…`.
 *
 * Chips and the mark are added to the line conditionally rather than always
 * rendered, because the line joins its parts with `·` and a badge that renders
 * nothing would leave a dangling separator. The markup is `.kp-item-meta`, so
 * the line has the same size, tone and separators as every other index surface.
 */
import { Children } from 'react';
import type { ReactNode } from 'react';
import type { DisplayState, TrustTier } from '@echozedlabs/knowledge-types';
import { FreshnessBadge, TrustBadge } from '@echozedlabs/ui';
import type { HighlightRange } from '@echozedlabs/knowledge-types';
import { resultMetaParts } from './resultMeta.js';
import { renderHighlighted } from './renderHighlighted.js';
import './SearchResultRow.css';

export interface SearchResultRowProps {
  title: string;
  type?: string | null;
  /** The exceptional state, if any (`displayStateForHit`); `published` renders nothing. */
  displayState: DisplayState | null;
  /** Change-request URL when `displayState` is `in-review` (plan §8.2). */
  reviewUrl?: string | null;
  trustTier?: TrustTier;
  /** The topic's display name. */
  topic?: string | null;
  snippet?: string | null;
  /** Match ranges into `title` / `snippet` exactly as passed (`SearchHit.highlights`). */
  highlights?: { title?: HighlightRange[]; snippet?: HighlightRange[] } | null;
  /** Whether the server cut the snippet out of a longer body, at either end. */
  snippetTruncated?: { start?: boolean; end?: boolean } | null;
  /** ISO timestamp; rendered as `Updated Sep 8`. */
  updatedAt?: string | null;
  /** The fields the query matched (`matched_fields`), kept only as `data-match`. */
  matchedFields?: string[] | null;
  /** Extra metadata parts the caller appends to the line. */
  children?: ReactNode;
}

export function SearchResultRow({
  title,
  type,
  displayState,
  reviewUrl,
  trustTier,
  topic,
  snippet,
  highlights,
  snippetTruncated,
  updatedAt,
  matchedFields,
  children,
}: SearchResultRowProps) {
  const parts: ReactNode[] = resultMetaParts({ topic, type, updatedAt });
  if (displayState && displayState !== 'published') {
    parts.push(<FreshnessBadge key="state" displayState={displayState} reviewUrl={reviewUrl} />);
  }
  if (trustTier && trustTier !== 'unverified') {
    parts.push(<TrustBadge key="trust" tier={trustTier} variant="mark" />);
  }
  parts.push(...Children.toArray(children));

  return (
    <div className="kp-result-row" data-match={matchedFields?.length ? matchedFields.join(' ') : undefined}>
      <span className="kp-result-row__title">{renderHighlighted(title, highlights?.title)}</span>
      {snippet ? (
        <div className="kp-result-row__snippet">
          {/* The ellipses are the server's word that the body goes on; they are
              punctuation to the eye and noise to a screen reader. */}
          {snippetTruncated?.start ? <span aria-hidden="true">…</span> : null}
          {renderHighlighted(snippet, highlights?.snippet)}
          {snippetTruncated?.end ? <span aria-hidden="true">…</span> : null}
        </div>
      ) : null}
      {parts.length ? (
        <div className="kp-item-meta kp-result-row__meta">
          {parts.map((part, index) => (
            // Index keys are correct here: a positional, never-reordered list of
            // already-rendered facts (the same shape as `ItemRow`'s line).
            <span key={index} className="kp-item-meta__part">
              {index > 0 ? (
                <span className="kp-item-meta__sep" aria-hidden="true">
                  ·
                </span>
              ) : null}
              {part}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
