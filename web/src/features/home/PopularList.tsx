/**
 * PopularList — the home page's site-wide "Popular" column: the most-read
 * published items in the server's look-back window, as a compact numbered list.
 *
 * It exists to use the width a large monitor already has inside the page's
 * content cap (Eric: "what is the appropriate display for ultrawide and
 * mobile"). A reading site does not stretch its text across 2560px; it caps the
 * measure and fills the capped width with a third, narrow column. So this is
 * built to be narrow: a rank, a title that wraps to two lines, and one quiet
 * line of `Topic · N readers` — no cover, no brief, nothing that needs room.
 *
 * Presentational only: the page owns the `usePopular` query, because whether
 * this list has anything in it decides the page's column layout (Home.tsx sets
 * `data-popular` from it). An empty list renders nothing at all — including
 * while `GET /popular` does not exist yet or fails — so a fresh instance nobody
 * has read shows no heading over an empty column.
 *
 * Counts are aggregate distinct signed-in readers; the list never says who.
 * Styled by `pages/Home.css`, like the Updates feed.
 */
import type { PopularEntry } from '@echozedlabs/knowledge-types';
import { itemSlugLink, itemHref } from '../../components/itemLink.js';
import { storyTopic } from './storyMeta.js';

/** How many entries the column shows; short enough to sit beside the first rows of the feed. */
export const POPULAR_ITEMS = 5;

function readers(views: number): string {
  return `${views.toLocaleString()} ${views === 1 ? 'reader' : 'readers'}`;
}

export function PopularList({ items, windowDays }: { items: PopularEntry[]; windowDays?: number | null }) {
  const entries = items.slice(0, POPULAR_ITEMS);
  if (entries.length === 0) return null;
  return (
    <section className="Home__popular" aria-labelledby="home-popular" data-testid="home-popular">
      <div className="Home__popularHead">
        <h2 id="home-popular">Popular</h2>
        {windowDays ? <span className="Home__popularWindow">Last {windowDays} days</span> : null}
      </div>
      <ol className="Home__popularList">
        {entries.map((entry, index) => {
          const topic = storyTopic(entry);
          return (
            <li key={entry.id} className="Home__popularItem" data-testid="home-popular-item">
              <span className="Home__popularRank" aria-hidden="true">
                {index + 1}
              </span>
              <div className="Home__popularBody">
                {itemSlugLink(entry.slug)({ href: itemHref(entry.slug), className: 'Home__popularTitle', children: entry.title })}
                {/* The topic is text here, not a link: the row's one target is the
                    story, and a list this dense has no room for a second. */}
                <span className="kp-item-meta Home__popularMeta">
                  {topic ? (
                    <>
                      <span>{topic.name}</span>
                      <span className="kp-item-meta__sep" aria-hidden="true">
                        ·
                      </span>
                    </>
                  ) : null}
                  <span>{readers(entry.views)}</span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
