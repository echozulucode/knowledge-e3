/**
 * In-article series navigation (home plan R2.11, "Inside an article").
 *
 * - `SeriesBox`, near the top: "Part 2 of 5 in <Series title>", linking to the
 *   series page, with a disclosure listing every part and marking this one.
 * - `SeriesPager`, at the end: Previous / Next, each named by the part's title —
 *   the reader who finished part 2 wants part 3, not the series index.
 *
 * Both render nothing unless the article is one of at least two published
 * parts the viewer can see (`seriesPosition`). They read the same cached
 * `GET /feed/series/:slug` response as the series page.
 */
import { useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon, appIcons } from '../../icons.js';
import { useSeriesView } from './queries.js';
import { seriesPosition, seriesTitle } from './seriesModel.js';
import './Series.css';

interface SeriesNavProps {
  /** The article's `series` frontmatter (the series slug). */
  slug: string;
  /** The article's item id, to find its place among the parts. */
  currentId: string;
}

export function SeriesBox({ slug, currentId }: SeriesNavProps) {
  const { data } = useSeriesView(slug);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const parts = data?.items ?? [];
  const position = seriesPosition(parts, currentId);
  if (!position) return null;
  const title = seriesTitle(data, slug);

  return (
    <nav className="kp-series-box" aria-label={`Series: ${title}`} data-testid="series-box">
      <div className="kp-series-box__head">
        <p className="kp-series-box__position">
          <Icon icon={appIcons.layerGroup} fixedWidth={false} />
          <span>
            Part {position.number} of {position.total} in{' '}
            <Link to="/series/$slug" params={{ slug }} className="kp-series-box__title">
              {title}
            </Link>
          </span>
        </p>
        <button
          type="button"
          className="kp-series-box__toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide parts' : 'Show all parts'}
        </button>
      </div>
      <ol id={listId} className="kp-series-box__parts" hidden={!open}>
        {parts.map((part) => (
          <li key={part.id} className="kp-series-box__part" aria-current={part.id === currentId ? 'page' : undefined}>
            {part.id === currentId ? (
              <span>{part.title}</span>
            ) : (
              <Link to="/p/$slug" params={{ slug: part.slug }}>
                {part.title}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SeriesPager({ slug, currentId }: SeriesNavProps) {
  const { data } = useSeriesView(slug);
  const position = seriesPosition(data?.items ?? [], currentId);
  if (!position) return null;
  const { previous, next } = position;

  return (
    <nav className="kp-series-pager" aria-label={`More in ${seriesTitle(data, slug)}`} data-testid="series-pager">
      {previous ? (
        <Link to="/p/$slug" params={{ slug: previous.slug }} rel="prev" className="kp-series-pager__link" data-direction="previous">
          <span className="kp-series-pager__label">
            <Icon icon={appIcons.anglesLeft} fixedWidth={false} /> Previous
          </span>
          <span className="kp-series-pager__title">{previous.title}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next ? (
        <Link to="/p/$slug" params={{ slug: next.slug }} rel="next" className="kp-series-pager__link" data-direction="next">
          <span className="kp-series-pager__label">
            Next <Icon icon={appIcons.anglesRight} fixedWidth={false} />
          </span>
          <span className="kp-series-pager__title">{next.title}</span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
