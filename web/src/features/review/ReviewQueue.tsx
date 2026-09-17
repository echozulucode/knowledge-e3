/**
 * The review queue at `/review` (plan §8.2): every item currently sitting in a
 * change request, grouped by the source whose policy put it there. Admins see
 * every `review`-mode source and can Refresh or Merge from here; an author who
 * is not an admin sees their own items and the link to each change request.
 */
import { Link } from '@tanstack/react-router';
import type { ApiError } from '../../api.js';
import { Icon, appIcons } from '../../icons.js';
import { useMe } from '../../queries.js';
import { ReviewRow } from '../sources/ReviewsPanel.js';
import { useMergeReview, useRefreshReview, useReviewsBySource, useSources } from '../sources/queries.js';
import { countOpenReviews, groupReviewsBySource, reviewSourceIds } from './reviewModel.js';
import { useMyItemsInReview } from './queries.js';
import './ReviewQueue.css';

export function ReviewQueue() {
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const { data: sources = [], isError: sourcesFailed, error: sourcesError } = useSources();
  const sourceIds = reviewSourceIds(sources);
  const queue = useReviewsBySource(sourceIds);
  const groups = groupReviewsBySource(queue.groups, sources);
  const mine = useMyItemsInReview(Boolean(me) && !isAdmin);
  const refresh = useRefreshReview();
  const merge = useMergeReview();
  const openCount = isAdmin ? countOpenReviews(groups) : (mine.data?.length ?? 0);

  return (
    <main className="ReviewQueue" aria-labelledby="review-queue-title">
      <section className="ReviewQueue__hero">
        <div className="ReviewQueue__eyebrow">
          <Icon icon={appIcons.listCheck} />
          <span>Review</span>
        </div>
        <h1 id="review-queue-title">In review</h1>
        <p>
          Items on their own branch behind a change request. Under a <strong>review</strong> policy the upstream
          reviewers publish; an item flips to Published when its merge arrives back through sync.
        </p>
        <p className="ReviewQueue__count" role="status">
          {openCount === 1 ? '1 item in review' : `${openCount} items in review`}
        </p>
      </section>

      {isAdmin ? (
        sourcesFailed ? (
          <p className="ReviewQueue__muted" role="alert">
            {(sourcesError as ApiError | null)?.message ?? 'Could not load the source registry.'}
          </p>
        ) : sourceIds.length === 0 ? (
          <p className="ReviewQueue__muted">
            No source uses the review policy yet. Set one up in <Link to="/admin/repos">Admin → Sources</Link>.
          </p>
        ) : (
          groups.map((group) => (
            <section className="ReviewQueue__group" key={group.sourceId} aria-label={`Reviews for ${group.sourceId}`}>
              <header className="ReviewQueue__groupHead">
                <h2>{group.sourceId}</h2>
                {group.where ? <code className="ReviewQueue__where">{group.where}</code> : null}
              </header>
              {group.isLoading ? (
                <p className="ReviewQueue__muted">Loading…</p>
              ) : group.isError ? (
                <p className="ReviewQueue__muted">The review queue is unavailable for this source.</p>
              ) : group.reviews.length === 0 ? (
                <p className="ReviewQueue__muted">Nothing in review here.</p>
              ) : (
                <ul className="Sources__reviewList">
                  {group.reviews.map((entry) => (
                    <ReviewRow
                      key={entry.page_id}
                      entry={entry}
                      busy={refresh.isPending || merge.isPending}
                      onRefresh={() =>
                        void refresh
                          .mutateAsync({ sourceId: group.sourceId, pageId: entry.page_id })
                          .catch(() => undefined)
                      }
                      onMerge={() =>
                        void merge
                          .mutateAsync({ sourceId: group.sourceId, pageId: entry.page_id })
                          .catch(() => undefined)
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          ))
        )
      ) : (
        <section className="ReviewQueue__group" aria-label="Your items in review">
          <header className="ReviewQueue__groupHead">
            <h2>Yours</h2>
          </header>
          {mine.isLoading ? (
            <p className="ReviewQueue__muted">Loading…</p>
          ) : (mine.data?.length ?? 0) === 0 ? (
            <p className="ReviewQueue__muted">None of your items is waiting on a review.</p>
          ) : (
            <ul className="Sources__reviewList">
              {(mine.data ?? []).map((entry) => (
                <li className="Sources__review" key={entry.page_id} data-review-page={entry.page_id}>
                  <div className="Sources__reviewMeta">
                    {entry.slug ? (
                      <Link to="/p/$slug" params={{ slug: entry.slug }}>
                        <strong>{entry.title || entry.slug}</strong>
                      </Link>
                    ) : (
                      <strong>{entry.title || entry.page_id}</strong>
                    )}
                    {entry.review.branch ? <code className="Sources__mono">{entry.review.branch}</code> : null}
                    {entry.review.url ? (
                      <a href={entry.review.url} target="_blank" rel="noreferrer">
                        Change request
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
