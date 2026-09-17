/**
 * UpdatesFeed — the home page's feed: a lead story, then a vertical list (home
 * plan R2.2, R2.4, R2.11).
 *
 * The shape is borrowed from how Hashnode's blogs present stories, because Eric
 * asked for it — the pattern, not the look:
 *
 * - **The lead story** is the newest item: a wide 16:9 cover above the title,
 *   the brief, and `Topic · Author · Sep 8 · 4 min read`. Without a cover it is a
 *   text-only card of the same width. There is deliberately **no placeholder
 *   image** — a placeholder is exactly what the first design review read as a
 *   failed load.
 * - **The rows** are title (two lines), brief (one line), the metadata line, and
 *   the cover as a thumbnail on the trailing edge when there is one. A row with
 *   no cover simply has no thumbnail and the text takes the width; a list
 *   tolerates that variance where a grid of cards does not.
 *
 * Why a list and not the grid it replaced: the grid put 15rem cards inside a
 * column that shares the first screen with the pinned topics, and truncated
 * every title to a few words. A list gives every title the column's width.
 *
 * Covers are decorative here (`alt=""`): the title sits beside or under them and
 * carries the meaning. The article page is where an author's `cover_alt` is read.
 *
 * Styled by `pages/Home.css` — this renders only on the home page, so its
 * layout lives with the page's other regions rather than in a second sheet.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { FeedEntry, TrustTier } from '@echozedlabs/knowledge-types';
import { FreshnessBadge, ItemCard, ItemRow, TrustBadge } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { toFeedCard } from '../feed/feedCard.js';
import { storyMetaParts, storyTopic } from './storyMeta.js';

/**
 * One lead story plus five rows. The tenant's Section `limit` still governs
 * what the server resolves; this caps what the first screen shows, and the
 * feed's own "View all" link carries the rest.
 */
export const FEED_ITEMS = 6;

/** Lifecycle states worth a word on an index surface; plain `published` says nothing. */
const SPOKEN_STATES = new Set(['needs-review', 'superseded', 'archived', 'in-review']);

/**
 * The story's topic, first on its metadata line: the feed is cross-topic, so
 * which topic a story belongs to is the first thing a reader sorts it by.
 *
 * A link, because it can be one without breaking the item's single-target
 * rule: in both `ItemCard` and `ItemRow` the metadata line is a SIBLING of the
 * title link, never inside it, so no `<a>` nests in another; and `item.css`
 * already lifts any other link in a row above the row's stretched title
 * overlay, so it stays clickable. Plain text when the payload has a name but no
 * slug — a label that goes nowhere is better than a link that guesses.
 */
function topicPart(entry: FeedEntry): ReactNode {
  const topic = storyTopic(entry);
  if (!topic) return null;
  return topic.slug ? (
    <Link key="topic" to="/topics/$slug" params={{ slug: topic.slug }} className="Home__topic" data-testid="home-topic">
      {topic.name}
    </Link>
  ) : (
    <span key="topic" className="Home__topic" data-testid="home-topic">
      {topic.name}
    </span>
  );
}

/**
 * The metadata line as rendered parts: the topic, the text facts, then — only
 * when there is something to say — the freshness state and the trust mark.
 *
 * Both signals are added conditionally rather than always rendered, because the
 * line joins its parts with `·` and a badge that renders nothing would leave a
 * dangling separator. The trust tier is the `mark` volume (R2.4): nothing for an
 * unverified item, a small muted check at the end of the line once verified.
 */
function metaFor(entry: FeedEntry, lead: boolean): ReactNode[] {
  const card = toFeedCard(entry);
  const topic = topicPart(entry);
  const parts: ReactNode[] = [...(topic ? [topic] : []), ...storyMetaParts(entry, { lead })];
  if (card.displayState && SPOKEN_STATES.has(card.displayState)) {
    parts.push(
      <FreshnessBadge
        key="freshness"
        displayState={card.displayState}
        staleAfter={entry.stale_after}
        supersededBy={entry.superseded_by}
        reviewUrl={card.reviewUrl}
      />,
    );
  }
  const tier: TrustTier | undefined = entry.trust_tier;
  if (tier && tier !== 'unverified') {
    parts.push(<TrustBadge key="trust" tier={tier} variant="mark" />);
  }
  return parts;
}

export function UpdatesFeed({
  heading,
  items,
  more,
}: {
  /** The Section's own name, so a tenant who calls it "News" gets "News". */
  heading: string;
  items: FeedEntry[];
  /** The feed's "View all …" link, already rendered by the page that knows its route. */
  more?: ReactNode;
}) {
  const [lead, ...rows] = items.slice(0, FEED_ITEMS);
  if (!lead) return null;
  const leadCard = toFeedCard(lead);
  return (
    <section className="Home__feed" aria-labelledby="home-feed">
      <div className="Home__feedHead">
        <h2 id="home-feed">{heading}</h2>
      </div>
      <ItemCard
        className="Home__lead"
        testId="home-lead"
        layout="stacked"
        titleAs="h3"
        title={leadCard.title}
        href={itemHref(leadCard.slug)}
        renderLink={itemSlugLink(leadCard.slug)}
        cover={leadCard.cover}
        preview={leadCard.preview}
        meta={metaFor(lead, true)}
      />
      {rows.length > 0 && (
        <ul className="Home__rows" aria-label={heading}>
          {rows.map((item) => {
            const card = toFeedCard(item);
            return (
              <ItemRow
                key={item.id}
                className="Home__row"
                testId="home-row"
                title={card.title}
                href={itemHref(card.slug)}
                renderLink={itemSlugLink(card.slug)}
                preview={card.preview}
                meta={metaFor(item, false)}
                trailing={card.cover ? <img className="Home__thumb" src={card.cover} alt="" loading="lazy" /> : undefined}
              />
            );
          })}
        </ul>
      )}
      {more ? <div className="Home__feedMore">{more}</div> : null}
    </section>
  );
}
