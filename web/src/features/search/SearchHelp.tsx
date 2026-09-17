/**
 * SearchHelp — the "Searching" section of `/help` (reader UX plan §5.7, §5.1
 * defect 15: "no search help anywhere").
 *
 * Two short tables and a handful of rules, nothing else:
 *
 *  - **Query syntax** is rendered from `SUPPORTED_FILTER_HELP` — the table the
 *    "Search tips" on `/search` also render, pinned to the parser's own
 *    `SUPPORTED_SEARCH_FILTERS` by `searchSyntax.test.ts`. Help cannot promise a
 *    key the parser drops.
 *  - **The rules** (phrases, `-` to exclude, prefix matching, repeating a key,
 *    `updated:` forms) are `SEARCH_TIPS`, the same sentences as the tips.
 *  - **The vocabulary** — the axes a search narrows by, one job each, so a
 *    reader knows what "Topic" means before choosing one.
 *
 * Search here is words, filters and ranking over the index; the page describes
 * exactly that and nothing more.
 */
import { Link } from '@tanstack/react-router';
import { SEARCH_TIPS, SUPPORTED_FILTER_HELP } from './searchSyntax.js';
import './SearchHelp.css';

/** The axes, in the order the `/search` filters list them. */
const VOCABULARY: { term: string; meaning: string; filter: string }[] = [
  { term: 'Topic', meaning: 'Where an item lives: the area of the library it belongs to, with its own landing page. Every item has one.', filter: 'topic:' },
  { term: 'Type', meaning: 'What kind of thing it is — a Runbook, an FAQ, a Decision. Results are grouped by it.', filter: 'type:' },
  { term: 'Category', meaning: 'The one curated shelf an item is filed under, the same across every topic.', filter: 'category:' },
  { term: 'Tag', meaning: 'Free keywords an item carries; many per item. Tag groups gather related tags.', filter: 'tag: · group:' },
  { term: 'Trust tier', meaning: 'How far an item has been checked: Unverified, Machine-confirmed, or Human-reviewed. Verified means either of the last two.', filter: 'is:' },
];

export function SearchHelp() {
  return (
    <section className="kp-search-help" aria-labelledby="help-searching-title">
      <h2 id="help-searching-title" className="kp-search-help__title">Searching</h2>
      <p className="kp-search-help__intro">
        Type words to find items that contain them, then narrow with filters — typed into the query, or picked from the filters beside the results on{' '}
        <Link to="/search">Search</Link>. A filtered search is a link you can share.
      </p>

      <h3 className="kp-search-help__heading" id="help-search-syntax">Query syntax</h3>
      <div className="kp-search-help__tableWrap" role="region" aria-labelledby="help-search-syntax" tabIndex={0}>
        <table className="kp-search-help__table">
          <thead>
            <tr>
              <th scope="col">Filter</th>
              <th scope="col">Meaning</th>
              <th scope="col">Example</th>
            </tr>
          </thead>
          <tbody>
            {SUPPORTED_FILTER_HELP.map((filter) => (
              <tr key={filter.key}>
                <th scope="row"><code>{filter.key}:</code></th>
                <td>{filter.description}</td>
                <td><code>{filter.example}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="kp-search-help__heading">Phrases, exclusions and prefixes</h3>
      <ul className="kp-search-help__rules">
        {SEARCH_TIPS.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>

      <h3 className="kp-search-help__heading" id="help-search-vocabulary">What the filters mean</h3>
      <div className="kp-search-help__tableWrap" role="region" aria-labelledby="help-search-vocabulary" tabIndex={0}>
        <table className="kp-search-help__table">
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">What it is</th>
              <th scope="col">Filter</th>
            </tr>
          </thead>
          <tbody>
            {VOCABULARY.map((entry) => (
              <tr key={entry.term}>
                <th scope="row">{entry.term}</th>
                <td>{entry.meaning}</td>
                <td><code>{entry.filter}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
