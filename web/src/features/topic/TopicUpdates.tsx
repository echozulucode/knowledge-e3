/**
 * TopicUpdates — the band near the top of every topic page (home plan R3):
 * what changed in this topic, beside what people in it actually read.
 *
 * Eric: "When I click on a topic main page, I'd like to see recent updates for
 * that topic and perhaps a top n list of most popular articles or content
 * within that topic."
 *
 * - **Updates** is the site's cross-topic Updates Section narrowed to this topic.
 *   It borrows that Section's tags (and type, if the curator set one) rather than
 *   a tag of its own, so tagging a story `update` puts it on the front page AND
 *   on its topic's page, and a tenant who renames the tag in Admin → Sections
 *   moves both at once. The heading is that Section's own name, as on Home.
 * - **Recently updated** is the fallback when nothing in the topic carries the
 *   tags (or no Updates Section exists): the topic's newest published items, so
 *   a topic page is never empty-handed. A blog topic opts out of the fallback —
 *   its landing IS the newest-first list, directly below.
 * - **Popular in <topic>** ranks by distinct signed-in readers over the server's
 *   default window, and only appears once there is something to rank
 *   (`POPULAR_MIN_ITEMS`). On error it is simply absent: it is a garnish on the
 *   page, not a thing a reader came for.
 *
 * Rows are the shared `ItemRow`, not the home page's `UpdatesFeed`: that
 * component is the front page's lead-story layout, and the topic page wants the
 * plain list.
 */
import { Link } from '@tanstack/react-router';
import type { TopicView } from '@echozedlabs/knowledge-types';
import { ItemRow, itemPreview } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { usePopular } from '../popular/queries.js';
import { useCrossTopicSections, useTopicFeed } from './queries.js';
import { pickUpdatesSection } from './slots.js';
import {
  TOPIC_POPULAR_LIMIT,
  TOPIC_UPDATES_LIMIT,
  popularToShow,
  readersLabel,
  topicUpdateMeta,
  updatesRule,
  viewAllSearch,
} from './topicUpdatesModel.js';
import './TopicLanding.css';

export function TopicUpdates({ topic, fallback = true }: { topic: TopicView; fallback?: boolean }) {
  // Until the Sections answer, the page does not know which list it is showing,
  // so it asks for neither — otherwise the fallback would flash in and then be
  // replaced by the tagged list. A failed Sections request settles as "no rule".
  const { data: crossTopic, isLoading: sectionsLoading } = useCrossTopicSections();
  const ruleKnown = !sectionsLoading;
  const rule = ruleKnown ? updatesRule(pickUpdatesSection(crossTopic).lead) : null;

  const tagged = useTopicFeed(
    { topic: topic.slug, tags: rule?.tags, type: rule?.type, limit: TOPIC_UPDATES_LIMIT },
    ruleKnown && !!rule,
  );
  const taggedItems = rule ? (tagged.data ?? []) : [];
  const taggedSettled = !rule || tagged.isSuccess || tagged.isError;
  const wantFallback = fallback && ruleKnown && taggedSettled && taggedItems.length === 0;
  const recent = useTopicFeed({ topic: topic.slug, limit: TOPIC_UPDATES_LIMIT }, wantFallback);

  const popular = usePopular({ topic: topic.slug, limit: TOPIC_POPULAR_LIMIT });
  const ranked = popular.isError ? [] : popularToShow(popular.data?.items);

  const showTagged = taggedItems.length > 0;
  const items = showTagged ? taggedItems : wantFallback ? (recent.data ?? []) : [];
  if (items.length === 0 && ranked.length === 0) return null;

  const heading = showTagged && rule ? rule.name : 'Recently updated';
  const now = new Date();

  return (
    <div className="TopicLanding__pulse" data-testid="topic-pulse">
      {items.length > 0 ? (
        <section
          className="TopicLanding__updates"
          aria-labelledby="topic-updates-heading"
          data-variant={showTagged ? 'tagged' : 'recent'}
          data-testid="topic-updates"
        >
          <h2 id="topic-updates-heading">{heading}</h2>
          <ul className="TopicLanding__updateRows" aria-label={heading}>
            {items.slice(0, TOPIC_UPDATES_LIMIT).map((item) => (
              <ItemRow
                key={item.id}
                className="TopicLanding__updateRow"
                testId="topic-updates-row"
                title={item.title}
                href={itemHref(item.slug)}
                renderLink={itemSlugLink(item.slug)}
                preview={itemPreview(item)}
                meta={topicUpdateMeta(item, now)}
                trailing={item.cover?.trim() ? <img className="TopicLanding__thumb" src={item.cover.trim()} alt="" loading="lazy" /> : undefined}
              />
            ))}
          </ul>
          <Link
            to="/search"
            search={viewAllSearch(topic.slug, showTagged ? rule?.tags : undefined) as never}
            className="TopicLanding__more"
          >
            {showTagged ? `View all updates in ${topic.name}` : `View all in ${topic.name}`} <span aria-hidden="true">→</span>
          </Link>
        </section>
      ) : null}
      {ranked.length > 0 ? (
        <aside className="TopicLanding__popular" aria-labelledby="topic-popular-heading" data-testid="topic-popular">
          <h2 id="topic-popular-heading">Popular in {topic.name}</h2>
          <ol className="TopicLanding__popularList">
            {ranked.map((item, index) => (
              <li key={item.id} className="TopicLanding__popularRow" data-testid="topic-popular-row">
                {/* The <ol> already announces the position; the numeral is for the eye. */}
                <span className="TopicLanding__rank" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="TopicLanding__popularBody">
                  <Link to="/p/$slug" params={{ slug: item.slug }} className="TopicLanding__popularTitle">
                    {item.title}
                  </Link>
                  <span className="TopicLanding__readers">{readersLabel(item.views)}</span>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
    </div>
  );
}
