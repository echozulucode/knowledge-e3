/**
 * Open change requests for one `review`-mode source (plan §8.2) — the Change
 * requests tab of the source's detail sheet. Each item's
 * work sits on its own `e3/<item-slug>-<shortid>` branch behind a PR/MR:
 * follow the link to review it upstream, Refresh to re-read the host's state,
 * or Merge — the in-app convenience that calls the host's merge API.
 */
import { Link } from '@tanstack/react-router';
import type { ApiError } from '../../api.js';
import { Icon, appIcons } from '../../icons.js';
import { useMergeReview, useRefreshReview, useSourceReviews } from './queries.js';
import { formatSyncedAt } from './sourceModel.js';
import type { ReviewEntry } from './types.js';
import './Sources.css';

export interface ReviewsPanelProps {
  sourceId: string;
}

export function ReviewsPanel({ sourceId }: ReviewsPanelProps) {
  const { data: reviews = [], isLoading, isError, error } = useSourceReviews(sourceId);
  const refresh = useRefreshReview();
  const merge = useMergeReview();

  return (
    <section className="Sources__tabPanel" aria-label={`Reviews for ${sourceId}`}>
      <p className="Sources__muted">
        Items on their own branch behind a change request. They flip to Published when the merge arrives back through
        sync.
      </p>
      {isLoading ? (
        <p className="Sources__muted" role="status">
          Loading change requests…
        </p>
      ) : isError ? (
        <p className="Sources__muted">
          {(error as ApiError | null)?.message ?? 'The review queue is unavailable for this source.'}
        </p>
      ) : reviews.length === 0 ? (
        <p className="Sources__muted">Nothing is in review for this source.</p>
      ) : (
        <ul className="Sources__reviewList">
          {reviews.map((entry) => (
            <ReviewRow
              key={entry.page_id}
              entry={entry}
              busy={refresh.isPending || merge.isPending}
              onRefresh={() => void refresh.mutateAsync({ sourceId, pageId: entry.page_id }).catch(() => undefined)}
              onMerge={() => void merge.mutateAsync({ sourceId, pageId: entry.page_id }).catch(() => undefined)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface ReviewRowProps {
  entry: ReviewEntry;
  busy?: boolean;
  onRefresh: () => void;
  onMerge: () => void;
}

/**
 * One change request: title (linked to the item), branch, PR link, and the two
 * actions. A proposed REMOVAL has no item left to link to — the row was deleted
 * the moment the removal was staged — so it is labelled instead of linked.
 */
export function ReviewRow({ entry, busy, onRefresh, onMerge }: ReviewRowProps) {
  const label = entry.title || entry.slug || entry.page_id;
  return (
    <li className="Sources__review" data-review-page={entry.page_id}>
      <div className="Sources__reviewMeta">
        {entry.slug && !entry.deleted ? (
          <Link to="/p/$slug" params={{ slug: entry.slug }}>
            <strong>{label}</strong>
          </Link>
        ) : (
          <strong>{label}</strong>
        )}
        {entry.deleted ? (
          <span className="Sources__chip" data-tone="pending" title="This change request proposes deleting the item's file upstream.">
            removal
          </span>
        ) : null}
        <span className="Sources__chip" data-tone={entry.review.state === 'open' ? 'pending' : 'ok'}>
          {entry.review.state}
        </span>
        {entry.review.branch ? <code className="Sources__mono">{entry.review.branch}</code> : null}
        {entry.review.url ? (
          <a href={entry.review.url} target="_blank" rel="noreferrer">
            Change request
          </a>
        ) : (
          <span className="Sources__muted">No change-request link yet</span>
        )}
        {entry.review.opened_at ? (
          <span className="Sources__muted">Opened {formatSyncedAt(entry.review.opened_at)}</span>
        ) : null}
      </div>
      <div className="Sources__rowActions">
        <button type="button" onClick={onRefresh} disabled={busy}>
          <Icon icon={appIcons.clockRotateLeft} /> Refresh
        </button>
        <button type="button" onClick={onMerge} disabled={busy}>
          <Icon icon={appIcons.arrowRight} /> Merge
        </button>
      </div>
    </li>
  );
}
