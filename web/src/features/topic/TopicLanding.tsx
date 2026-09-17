/**
 * TopicLanding — `/topics/:slug`, rendered by the topic's presentation profile
 * (plan §3.1): portal (gateway with Section slots), blog (feed), docs (section
 * sub-nav + items), wiki (description, counts, sections list, browse link).
 *
 * Every profile carries the same `TopicUpdates` band (home plan R3) in the same
 * place relative to its content: after the header, the landing intro and Start
 * here, before the curated Sections. What changed and what people read is a
 * fact about the topic, not about how it chose to present itself.
 *
 * Every profile's header also carries a compact "Search in <topic>" box
 * (reader plan §5.6): it submits to `/search?q=…&topic=<slug>`, where the scope
 * is named as a removable chip. Scope is a narrowing the reader chooses here,
 * never a default the product imposes elsewhere.
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { TopicView } from '@echozedlabs/knowledge-types';
import { ReadView } from '../../components/ReadView.js';
import { Icon, appIcons } from '../../icons.js';
import { FeedList } from '../feed/FeedList.js';
import { useRecentSearches } from '../search/useRecentSearches.js';
import { SectionBlock } from './SectionBlock.js';
import { TopicUpdates } from './TopicUpdates.js';
import { useTopicLanding } from './queries.js';
import { orderPortalSections, orderSections } from './slots.js';
import type { ApiError } from '../../api.js';
import './TopicLanding.css';

function Header({ topic, children }: { topic: TopicView; children?: ReactNode }) {
  return (
    <header className="TopicLanding__hero">
      <Link to="/topics" className="TopicLanding__eyebrow"><Icon icon={appIcons.layerGroup} fixedWidth={false} /> Topics</Link>
      <h1 id="topic-topiclanding-title">{topic.name}</h1>
      {topic.description ? <p className="TopicLanding__lead">{topic.description}</p> : null}
      <TopicSearch topic={topic} />
      {children}
    </header>
  );
}

/**
 * "Search in <topic>": the topic's own door into `/search`, scoped to it.
 * Submitting is a search performed, so a non-empty query joins the quick
 * search's recents (recentSearches.ts) — the query only, as everywhere else;
 * an empty submit opens the topic's items on `/search`, newest first.
 */
function TopicSearch({ topic }: { topic: TopicView }) {
  const navigate = useNavigate();
  const { record } = useRecentSearches();
  const [query, setQuery] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) record(q);
    navigate({ to: '/search', search: (q ? { q, topic: topic.slug } : { topic: topic.slug }) as never });
  };
  return (
    <form className="TopicLanding__search" role="search" aria-label={`Search in ${topic.name}`} onSubmit={onSubmit}>
      <span className="TopicLanding__searchIcon" aria-hidden="true">
        <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
      </span>
      <input
        className="TopicLanding__searchInput"
        type="text"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search in ${topic.name}…`}
        aria-label={`Search in ${topic.name}`}
        data-testid="topic-search-input"
      />
      <button type="submit" className="TopicLanding__searchGo">Search</button>
    </form>
  );
}

function StartHere({ topic }: { topic: TopicView }) {
  if (!topic.start_here) return null;
  return (
    <div className="TopicLanding__actions">
      <Link to="/p/$slug" params={{ slug: topic.start_here }} className="TopicLanding__btn">
        Get started <Icon icon={appIcons.arrowRight} fixedWidth={false} />
      </Link>
    </div>
  );
}

function Portal({ topic }: { topic: TopicView }) {
  const slotted = orderPortalSections(topic.sections ?? []);
  return (
    <>
      <Header topic={topic}>
        <StartHere topic={topic} />
      </Header>
      {topic.landing_markdown ? <div className="TopicLanding__prose"><ReadView markdown={topic.landing_markdown} /></div> : null}
      <TopicUpdates topic={topic} />
      {slotted.map(({ section, heading }) => (
        <SectionBlock key={section.slug} section={section} heading={heading} id={`topic-slot-${section.slug}`} />
      ))}
    </>
  );
}

function Blog({ topic }: { topic: TopicView }) {
  return (
    <>
      <Header topic={topic}>
        <div className="TopicLanding__actions">
          <a className="TopicLanding__btn TopicLanding__btn--ghost" href={`/api/v1/feeds/topics/${encodeURIComponent(topic.slug)}.atom`} target="_blank" rel="noreferrer">
            <Icon icon={appIcons.boltLightning} fixedWidth={false} /> Atom feed
          </a>
        </div>
      </Header>
      {/* No "Recently updated" fallback here: the feed below already is that list. */}
      <TopicUpdates topic={topic} fallback={false} />
      <FeedList params={{ topic: topic.slug }} emptyText="No posts yet." />
    </>
  );
}

function Docs({ topic }: { topic: TopicView }) {
  const sections = orderSections(topic.sections ?? []);
  return (
    <>
      <Header topic={topic} />
      <div className="TopicLanding__docs">
        <nav className="TopicLanding__docsNav" aria-label="Sections">
          <ul>
            {sections.map((s) => (
              <li key={s.slug}><a href={`#section-${s.slug}`}>{s.name}</a></li>
            ))}
          </ul>
        </nav>
        <div className="TopicLanding__docsBody">
          {topic.landing_markdown ? <div className="TopicLanding__prose"><ReadView markdown={topic.landing_markdown} /></div> : null}
          <TopicUpdates topic={topic} />
          {sections.map((s) => <SectionBlock key={s.slug} section={s} heading={s.name} id={`topic-section-${s.slug}`} />)}
        </div>
      </div>
    </>
  );
}

function Wiki({ topic }: { topic: TopicView }) {
  const sections = orderSections(topic.sections ?? []);
  return (
    <>
      <Header topic={topic}>
        <div className="TopicLanding__counts" aria-label="Topic counts">
          <span><b>{topic.counts?.items ?? 0}</b> items</span>
          <span><b>{topic.counts?.published ?? 0}</b> published</span>
        </div>
        <div className="TopicLanding__actions">
          <Link to="/browse" search={{ topic: topic.slug } as never} className="TopicLanding__btn">
            <Icon icon={appIcons.list} fixedWidth={false} /> Browse this topic
          </Link>
          {/*
            Plan §3.4 removed Browse and Tags from the sidebar on the condition
            that both stay "reachable from Search AND from the Topic landing
            page". Search now offers both; this is the landing page's half of
            that promise, and without it the tag view has exactly one door in the
            whole product.
          */}
          <Link to="/browse" search={{ topic: topic.slug, view: 'tags' } as never} className="TopicLanding__btn">
            <Icon icon={appIcons.tag} fixedWidth={false} /> Browse by tag
          </Link>
          <StartHere topic={topic} />
        </div>
      </Header>
      <TopicUpdates topic={topic} />
      {sections.map((s) => <SectionBlock key={s.slug} section={s} heading={s.name} id={`topic-section-${s.slug}`} />)}
    </>
  );
}

export function TopicLanding() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { data: topic, isLoading, isError, error } = useTopicLanding(slug);

  if (isLoading) {
    return <main className="TopicLanding" aria-busy="true"><p className="TopicLanding__muted">Loading…</p></main>;
  }
  if (isError || !topic) {
    const notFound = (error as ApiError | null)?.statusCode === 404 || !isError;
    return (
      <main className="TopicLanding" aria-labelledby="topic-topiclanding-title">
        <div className="TopicLanding__empty">
          <h1 id="topic-topiclanding-title">{notFound ? 'Topic not found' : 'Could not load topic'}</h1>
          <p>{notFound ? 'There is no topic here, or you do not have access to it.' : 'Try again in a moment.'}</p>
          <Link to="/topics" className="TopicLanding__btn TopicLanding__btn--ghost">All topics</Link>
        </div>
      </main>
    );
  }

  const body =
    topic.presentation === 'portal' ? <Portal topic={topic} />
    : topic.presentation === 'blog' ? <Blog topic={topic} />
    : topic.presentation === 'docs' ? <Docs topic={topic} />
    : <Wiki topic={topic} />;

  return (
    <main className="TopicLanding" aria-labelledby="topic-topiclanding-title" data-presentation={topic.presentation}>
      {body}
    </main>
  );
}
