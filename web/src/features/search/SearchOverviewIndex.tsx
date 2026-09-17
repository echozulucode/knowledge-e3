/**
 * SearchOverviewIndex — what `/search` shows before anything is typed or
 * filtered (reader plan R12, UX plan §5.7).
 *
 * It replaced one muted sentence. A reader who does not know the right word is
 * now one click from the vocabulary: every content type, topic and category and
 * the most-used tags, each counted and each a ready-made `/search` URL, plus
 * the recently verified and recently updated items.
 *
 * Tags are a chip list at ONE size, not a font-size cloud: the count beside
 * each chip carries the weight, readably and to a screen reader, where a
 * cloud's type sizes only say "bigger" to someone who can see them.
 *
 * The cells sit in an intrinsic grid (1 → 2 → 3 columns as the page widens,
 * SearchPage.css). A section with nothing in it is left out; a failed or
 * missing `GET /search/overview` renders the old one-line prompt instead, so an
 * older server costs the reader an index, never the page.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ItemRow } from '@echozedlabs/ui';
import type { ItemSummary, SearchFacetValue } from '@echozedlabs/knowledge-types';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { useTopics } from '../../queries.js';
import { overviewChips, overviewItemMeta, overviewTopics } from './overviewModel.js';
import { useSearchOverview } from './queries.js';

const PROMPT = 'Type a term to search every item you can read — or pick a way into the library below.';

export function SearchOverviewIndex() {
  const { data: overview, isError, isLoading } = useSearchOverview();
  const { data: topicDirectory = [] } = useTopics();

  if (isLoading || isError || !overview) {
    return <p className="Search__muted">{PROMPT}</p>;
  }

  const types = overviewChips(overview.types);
  const topics = overviewTopics(overviewChips(overview.topics), topicDirectory);
  const categories = overviewChips(overview.categories);
  const tags = overviewChips(overview.tags);
  const verified = overview.recently_verified.filter((item) => item.slug);
  const updated = overview.recently_updated.filter((item) => item.slug);
  const hasAnything = types.length + topics.length + categories.length + tags.length + verified.length + updated.length > 0;

  return (
    <section className="Search__index" aria-labelledby="search-index-title" data-testid="search-overview">
      <div className="Search__indexHead">
        <h2 id="search-index-title" className="Search__indexTitle">The library at a glance</h2>
        <p className="Search__muted">
          {overview.total === 1 ? '1 item' : `${overview.total} items`} you can read. Type above, or start from a type, topic or tag.
        </p>
      </div>

      {hasAnything ? (
        <div className="Search__indexGrid">
          {types.length ? (
            <IndexCell id="search-index-types" title="Browse by type">
              <ChipList label="Content types" values={types} to={(value) => ({ type: value.label })} />
            </IndexCell>
          ) : null}

          {topics.length ? (
            <IndexCell id="search-index-topics" title="Topics">
              <ul className="Search__indexTopics" role="list">
                {topics.map((topic) => (
                  <li key={topic.searchValue} className="Search__indexTopic">
                    <Link to="/search" search={{ topic: topic.searchValue } as never} className="Search__indexTopicLink">
                      <span className="Search__facetLabel">{topic.label}</span>
                      <span className="Search__facetCount">{topic.count}</span>
                    </Link>
                    {/* Secondary: the topic's own page, for a reader who wants
                        its curated front door rather than a result list. */}
                    {topic.slug ? (
                      <Link to="/topics/$slug" params={{ slug: topic.slug }} className="Search__indexTopicPage" aria-label={`${topic.label} topic page`}>
                        Topic page
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </IndexCell>
          ) : null}

          {categories.length ? (
            <IndexCell id="search-index-categories" title="Categories">
              <ChipList label="Categories" values={categories} to={(value) => ({ category: value.label })} />
            </IndexCell>
          ) : null}

          {tags.length ? (
            <IndexCell id="search-index-tags" title="Popular tags">
              <ChipList label="Popular tags" values={tags} to={(value) => ({ tag: value.label })} />
            </IndexCell>
          ) : null}

          {verified.length ? (
            <IndexCell id="search-index-verified" title="Recently verified">
              <ItemList items={verified} list="verified" testId="search-overview-verified" />
            </IndexCell>
          ) : null}

          {updated.length ? (
            <IndexCell id="search-index-updated" title="Recently updated">
              <ItemList items={updated} list="updated" testId="search-overview-updated" />
            </IndexCell>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function IndexCell({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="Search__indexCell" aria-labelledby={id}>
      <h3 id={id} className="Search__facetHeading">{title}</h3>
      {children}
    </section>
  );
}

function ChipList({ label, values, to }: { label: string; values: SearchFacetValue[]; to: (value: SearchFacetValue) => Record<string, string> }) {
  return (
    <ul className="Search__indexChips" role="list" aria-label={label}>
      {values.map((value) => (
        <li key={value.value || value.label}>
          <Link to="/search" search={to(value) as never} className="Search__indexChip">
            <span className="Search__facetLabel">{value.label}</span>
            <span className="Search__facetCount">{value.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ItemList({ items, list, testId }: { items: ItemSummary[]; list: 'verified' | 'updated'; testId: string }) {
  return (
    <ul className="Search__indexItems" role="list" data-testid={testId}>
      {items.map((item) => (
        <ItemRow
          key={item.id}
          className="Search__indexItem"
          title={item.title}
          href={itemHref(item.slug)}
          renderLink={itemSlugLink(item.slug)}
          meta={overviewItemMeta(item, list)}
        />
      ))}
    </ul>
  );
}
