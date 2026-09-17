/**
 * SeriesPage — `/series/:slug` (home plan R2.11).
 *
 * The published `Series` item with this slug IS the series: its title,
 * description and cover head the page. The parts are the items whose `series`
 * names the slug, numbered in the server's reading order (`series_order`) — the
 * Series item's own hand-written *Parts* list is not a second source of order.
 * With no Series item the page still lists the parts, under the slug humanised
 * (`getting-started` → "Getting started") rather than shown raw.
 *
 * Moving between parts is the article's job (its series box and pager), so the
 * rows here are plain: thumbnail, title, brief, reading time.
 */
import { Link, useParams } from '@tanstack/react-router';
import { ItemRow } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { Icon, appIcons } from '../../icons.js';
import { useSeriesView } from '../series/queries.js';
import { seriesSummaryLine, seriesTitle } from '../series/seriesModel.js';
import { toFeedCard } from './feedCard.js';
import './Feed.css';
import '../series/Series.css';

export function SeriesPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { data, isLoading, isError } = useSeriesView(slug);
  const items = data?.items ?? [];
  const landing = data?.series_item ?? null;
  const title = seriesTitle(data, slug);

  return (
    <main className="Feed Series" aria-labelledby="feed-seriespage-title">
      {landing?.cover ? <img className="Series__cover" src={landing.cover} alt={landing.cover_alt ?? ''} /> : null}
      <header className="Feed__header">
        <div>
          <span className="Feed__eyebrow">Series</span>
          <h1 id="feed-seriespage-title">{isLoading ? '' : title}</h1>
          {landing?.description ? <p className="Series__description">{landing.description}</p> : null}
          <p className="Feed__lead" data-testid="series-summary">{items.length ? seriesSummaryLine(items) : ''}</p>
        </div>
        <Link to="/latest" className="Feed__atom">
          <Icon icon={appIcons.clock} fixedWidth={false} /> Latest
        </Link>
      </header>

      {isLoading ? (
        <p className="Feed__muted">Loading…</p>
      ) : isError ? (
        <p className="Feed__muted" role="alert">Could not load this series.</p>
      ) : items.length === 0 ? (
        <p className="Feed__muted Feed__empty">No published items in this series yet.</p>
      ) : (
        <ol className="Series__parts" aria-label={`Parts of ${title}`}>
          {items.map((entry) => {
            const card = toFeedCard(entry);
            return (
              <ItemRow
                key={entry.id}
                testId="series-part"
                title={card.title}
                href={itemHref(card.slug)}
                renderLink={itemSlugLink(card.slug)}
                preview={card.preview}
                meta={entry.reading_time_minutes ? [`${entry.reading_time_minutes} min read`] : undefined}
                // Decorative: the title beside it carries the meaning.
                trailing={card.cover ? <img className="Series__thumb" src={card.cover} alt="" loading="lazy" /> : undefined}
              />
            );
          })}
        </ol>
      )}
    </main>
  );
}
