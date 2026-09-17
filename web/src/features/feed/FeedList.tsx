/**
 * FeedList — cards over `GET /feed` (plan §3.3) with cursor-paged "Load more".
 * Shared by /latest (site-wide) and a Topic landing page in the `blog` profile
 * (`topic=<slug>`).
 */
import { Link } from '@tanstack/react-router';
import { ContentTypeBadge, FreshnessBadge, ItemCard, TrustBadge } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { useFeed, type FeedParams, type HomepageFeedEntry } from './queries.js';
import { toFeedCard } from './feedCard.js';
import './Feed.css';

/**
 * A feed entry as the shared `ItemCard` (plan R1.3). The mapping from the API
 * shape stays in `toFeedCard`; what used to be bespoke card markup here is now
 * the same component the Sections grid renders, so the two agree on badge
 * order, preview text and the byline separator without either being told to.
 */
export function FeedCard({ entry }: { entry: HomepageFeedEntry }) {
  const card = toFeedCard(entry);
  return (
    <ItemCard
      testId="feed-card"
      title={card.title}
      href={itemHref(card.slug)}
      renderLink={itemSlugLink(card.slug)}
      cover={card.cover}
      preview={card.preview}
      meta={card.byline}
      badges={
        <>
          {card.type ? <ContentTypeBadge type={card.type} size="sm" /> : null}
          {/* `in-review` (plan §8.2) wins over the lifecycle state and links to the change request. */}
          <FreshnessBadge
            displayState={card.displayState}
            staleAfter={entry.stale_after}
            supersededBy={entry.superseded_by}
            reviewUrl={card.reviewUrl}
          />
          {/* `mark` (home plan R2.4): quiet on an index surface — nothing for
              unverified, a muted check once verified. */}
          {entry.trust_tier ? <TrustBadge tier={entry.trust_tier} generatedBy={entry.generated_by} variant="mark" className="Feed__trust" /> : null}
        </>
      }
      footer={
        card.series ? (
          <Link to="/series/$slug" params={{ slug: card.series }} className="Feed__seriesChip">
            Series: {card.series}{card.seriesOrder != null ? ` · #${card.seriesOrder}` : ''}
          </Link>
        ) : null
      }
    />
  );
}

export function FeedList({ params, emptyText = 'Nothing published yet.' }: { params: FeedParams; emptyText?: string }) {
  const feed = useFeed(params);
  const entries = feed.data?.pages.flatMap((p) => p.items) ?? [];

  if (feed.isLoading) return <p className="Feed__muted">Loading…</p>;
  if (feed.isError) return <p className="Feed__muted" role="alert">Could not load the feed.</p>;
  if (entries.length === 0) return <p className="Feed__muted Feed__empty">{emptyText}</p>;

  return (
    <div className="Feed__list">
      {entries.map((entry) => <FeedCard key={entry.id} entry={entry} />)}
      {feed.hasNextPage ? (
        <button type="button" className="Feed__more" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
          {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
