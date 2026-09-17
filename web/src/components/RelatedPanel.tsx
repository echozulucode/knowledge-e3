/**
 * RelatedPanel — where the reading path continues, at the end of the article
 * (reader UX plan §6, R4.7).
 *
 * The link index is instance-wide and `backlinks()` has no source or topic
 * clause, so several of these suggestions routinely come from a different
 * repository than the article they sit under. Nothing here says so, and that is
 * the feature: the corpus argues that it is one corpus by behaving like one,
 * rather than by hiding that it is not.
 *
 * This replaced a collapsed-by-default panel under the *Tags* tab of the right
 * rail, where the strongest evidence the product had for requirement 4 was two
 * clicks from a reader who had already finished reading.
 */
import { Link } from '@tanstack/react-router';
import { useBacklinks } from '../queries.js';
import './RelatedPanel.css';

export interface RelatedPanelProps {
  pageId: string;
}

/** The snippet is raw body text; a reader has no use for the link's markup. */
function readable(snippet: string): string {
  return snippet.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) => label ?? target).trim();
}

export function RelatedPanel({ pageId }: RelatedPanelProps) {
  const { data: related = [] } = useBacklinks(pageId);
  if (related.length === 0) return null;

  // One entry per linking item: the same item may link here several times.
  const seen = new Set<string>();
  const entries = related.filter((entry) => {
    const slug = entry.source_item_slug || entry.source_slug;
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });

  return (
    <section className="kp-related" aria-labelledby="kp-related-heading">
      <h2 className="kp-related__heading" id="kp-related-heading">
        Related
      </h2>
      <ul className="kp-related__list">
        {entries.map((entry) => {
          const slug = entry.source_item_slug || entry.source_slug;
          return (
            <li key={slug} className="kp-related__item">
              <Link to="/p/$slug" params={{ slug }} className="kp-related__link">
                {entry.source_item_title || entry.source_title}
              </Link>
              {entry.snippet ? <p className="kp-related__snippet">{readable(entry.snippet)}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
