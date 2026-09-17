/**
 * Home — the front page (the home prototype plan, cut over 2026-09-12).
 *
 * The stance, in one line: **the main page is the publication's front page, not
 * a door to it.** The page it replaced opened with a wordmark, a slogan, a
 * sentence about how the library scales, three buttons and a count of drafts —
 * and not one thing anybody at the company wrote. This page opens with the
 * tenant's name and the most recent thing they published.
 *
 * Top to bottom (home plan revision 2, R2.2, as amended by Eric's second round):
 *   masthead (the tenant's identity, and nothing of ours), with `Start here →`
 *     when the home topic names one
 *   → the first screen: Updates | Key topics | Popular (+ curated links when a
 *     third column fits)
 *   → curated links (when they did not fit up there), the remaining Sections,
 *     the home topic's own prose
 *   → the product's colophon, flush against the bottom of the viewport
 *
 * **No search field.** Search lives in the header on every screen and on
 * `/search`; a second field here was a second door to the same index, and the
 * most prominent thing on a front page should be what the tenant published.
 *
 * The first screen changes shape with the width of THIS page (container queries
 * in Home.css), never with JavaScript measurement. What React contributes is
 * only which regions exist — `data-pins`, `data-popular`, `data-side` — because
 * a column for a list that has nothing in it is a hole, not a layout.
 *
 * Two things it deliberately does NOT do:
 *
 * - **No `usePages({ limit: 1000 })`.** Every block here is server-resolved and
 *   viewer-scoped through `/sections/cross-topic`, `/site/*` and `/feed`. The
 *   page this replaced pulled up to a thousand rows into the browser to show
 *   twelve.
 * - **No second feed mechanism.** The Updates feed is a cross-topic Section —
 *   the machinery that already exists, is tag-filtered, sorted newest-first and
 *   capped by the tenant's own `limit`. Its heading is the Section's own name,
 *   so a tenant who prefers "News" renames it in Admin → Sections and the page
 *   follows. `server/src/seed.ts` writes exactly that configuration on a fresh
 *   instance.
 *
 * There is **one** home page. The `KickoffHome` portal branch, the editorial
 * hero, `?v=next` and `/home-next` are all gone (Eric, 2026-09-12: "I have no
 * desire to go back to the 'Classic home' … there is no need for backward
 * compatibility or an old screen"). A topic's `presentation:` profile no longer
 * decides which front page you get — the front page should not change shape
 * because somebody edited a bundle key.
 */
import { useMemo, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import type { FeedEntry } from '@echozedlabs/knowledge-types';
import { PinnedTopicCard } from '@echozedlabs/ui';
import { useMe, useTopics } from '../queries.js';
import { Icon, appIcons } from '../icons.js';
import { ReadView } from '../components/ReadView.js';
import { CuratedLinks } from '../components/shell/CuratedLinks.js';
import { SiteBrand, useSiteBrand, useSiteLinks, usePinnedTopics } from '../components/shell/SiteBrand.js';
import { SiteFooter } from '../components/shell/SiteFooter.js';
import { usablePinnedTopics } from '../components/shell/siteBranding.js';
import { useFeedPage } from '../features/feed/queries.js';
import { TopicIcon, isPinIcon } from '../features/home/topicIcons.js';
import { FEED_ITEMS, UpdatesFeed } from '../features/home/UpdatesFeed.js';
import { POPULAR_ITEMS, PopularList } from '../features/home/PopularList.js';
import { usePopular } from '../features/popular/queries.js';
import { ReadingPaneLayout } from '../features/reading-pane/ReadingPaneLayout.js';
import { SectionBlock } from '../features/topic/SectionBlock.js';
import { orderPortalSections, pickHomeTopic, pickUpdatesSection } from '../features/topic/slots.js';
import {
  useCrossTopicSections,
  useSiteConfig,
  useTopicLanding,
  type TopicListEntry,
} from '../features/topic/queries.js';
import './Home.css';

export function Home() {
  const { data: user } = useMe();
  const canWrite = !!user;
  const isAdmin = user?.role === 'admin';
  // The route root, measured by the reading pane (features/reading-pane).
  const rootRef = useRef<HTMLElement>(null);
  const brand = useSiteBrand();
  const { data: site } = useSiteConfig();
  const { data: topics = [] } = useTopics();
  const { data: crossTopic, isLoading: sectionsLoading } = useCrossTopicSections();
  const { data: pinned } = usePinnedTopics();
  // Site-wide, so it is one request whatever the home topic is. An error (the
  // endpoint missing, or refusing) is the same as an empty list: no column.
  const { data: popular, isError: popularFailed } = usePopular({ limit: POPULAR_ITEMS });

  // The home topic is this page's CONFIG, not its layout: it supplies `links:`,
  // its own Sections, its landing prose and its `start_here` item.
  const homeTopic = pickHomeTopic(topics as TopicListEntry[], site?.home_topic);
  const { data: curatedLinks } = useSiteLinks(homeTopic?.slug);
  const { data: homeLanding } = useTopicLanding(homeTopic?.slug ?? '');

  const { lead, rest } = useMemo(() => pickUpdatesSection(crossTopic), [crossTopic]);
  // The fallback when no cross-topic Section resolves to anything: the same
  // site-wide feed "What's new" used. Fetched only then, so a configured
  // instance pays for one request, not two.
  const { data: recent = [], isLoading: recentLoading } = useFeedPage(
    { homepage: true, limit: FEED_ITEMS },
    !sectionsLoading && !lead,
  );

  const pins = usablePinnedTopics(pinned);
  const belowFold = useMemo(
    () => orderPortalSections([...(homeLanding?.sections ?? []), ...rest]),
    [homeLanding, rest],
  );

  // Four states, and the rule behind all of them: a fresh instance shows
  // content in the SHAPE of the finished page, so a tenant sees what curation
  // will buy them rather than an empty frame.
  const feedItems: FeedEntry[] = lead ? (lead.items ?? []) : recent;
  // Never the tenant's "Updates" heading over items nobody tagged: the fallback
  // says what it actually is.
  const feedHeading = lead ? lead.name : 'Recently published';
  const feedLoading = sectionsLoading || (!lead && recentLoading);

  // The CTA goes where it promises (R2.0): more of THIS feed is the Section's
  // own page. It used to be `Latest >` to `/latest` — every published item, a
  // different list under the same visual promise. The fallback feed IS the
  // site-wide recent list, so there, and only there, `/latest` is right.
  const feedMore = lead ? (
    <Link to="/sections/$slug" params={{ slug: lead.slug }} className="Home__more">
      View all updates <span aria-hidden="true">→</span>
    </Link>
  ) : (
    <Link to="/latest" className="Home__more">
      View all recently published <span aria-hidden="true">→</span>
    </Link>
  );

  const startHere = homeLanding?.start_here?.trim() || null;
  // Restored from the deleted portal branch without its hard-coded "New to
  // AI?", and shown only when the home topic names an item. It sits with the
  // masthead — orientation belongs at the top — rather than in a shortcut row
  // of its own, which with the search field gone would be a row of one.
  const startHereLink = startHere ? (
    <Link to="/p/$slug" params={{ slug: startHere }} className="Home__startHere">
      Start here <span aria-hidden="true">→</span>
    </Link>
  ) : null;

  const popularItems = popularFailed ? [] : (popular?.items ?? []);
  const hasPopular = popularItems.length > 0;
  const hasLinks = (curatedLinks?.length ?? 0) > 0;
  // The third column holds Popular and, when it fits, the curated links. It is
  // rendered whenever either exists; Home.css decides at which widths it shows.
  const hasSide = hasPopular || hasLinks;

  const page = (
    <main ref={rootRef} className="Home" aria-labelledby="home-masthead">
      {/* ---- Masthead: the tenant's configuration, and nothing of ours ----
          The product's own wordmark is already in the rail and the browser tab
          on every screen (Sidebar → SiteBrand → useSiteChrome), so an
          unconfigured instance is not unbranded here — it simply stops
          repeating what the chrome already says, and the first screen starts
          higher.
          `usingDefaultName` exists for exactly this kind of decision. */}
      {brand.usingDefaultName ? (
        <>
          <h1 id="home-masthead" className="Home__srOnly">
            Home
          </h1>
          {startHereLink ? <div className="Home__masthead Home__masthead--bare">{startHereLink}</div> : null}
        </>
      ) : (
        <header className="Home__masthead">
          <h1 id="home-masthead" className="Home__brand">
            <SiteBrand variant="full" logoClassName="Home__logo" nameClassName="Home__name" />
            {brand.tagline ? <span className="Home__tagline">{brand.tagline}</span> : null}
          </h1>
          {startHereLink}
        </header>
      )}

      {/* ---- First screen: Updates | Key topics | Popular ----
          DOM order is reading order on a wide screen. On a phone the key
          topics move above Updates as a chip strip (CSS `order`), because
          there they are the page's navigation rather than a sidebar. */}
      <div
        className="Home__top"
        data-pins={pins.length > 0 ? 'yes' : 'no'}
        data-popular={hasPopular ? 'yes' : 'no'}
        data-side={hasSide ? 'yes' : 'no'}
      >
        <div className="Home__feedCol">
          {feedLoading ? (
            <p className="Home__muted">Loading…</p>
          ) : feedItems.length > 0 ? (
            <UpdatesFeed heading={feedHeading} items={feedItems} more={feedMore} />
          ) : (
            <section className="Home__empty" aria-labelledby="home-feed">
              <h2 id="home-feed">Recently published</h2>
              <p className="Home__muted">Nothing published yet.</p>
              {canWrite && (
                <Link to="/browse" search={{ new: 'concept' } as any} className="Home__cta">
                  <Icon icon={appIcons.plus} fixedWidth={false} /> Create your first item
                </Link>
              )}
            </section>
          )}
          {/* Setup instructions are for the person who can act on them. A
              reader never sees them, and they disappear the moment a
              cross-topic Section resolves to anything. */}
          {!feedLoading && !lead && isAdmin ? (
            <Link to="/admin/sections" className="Home__adminHint">
              Curate an updates feed <Icon icon={appIcons.arrowRight} fixedWidth={false} />
            </Link>
          ) : null}
        </div>

        {pins.length > 0 ? (
          <aside className="Home__pins" aria-label="Key topics">
            <div className="Home__pinGrid">
              {pins.map((pin) => (
                <PinnedTopicCard
                  key={pin.topic}
                  testId="home-pin"
                  name={pin.name}
                  description={pin.description}
                  color={pin.color}
                  // Only a known token becomes an icon: anything else leaves the
                  // slot to the card's own neutral default glyph (R2.5).
                  icon={isPinIcon(pin.icon) ? <TopicIcon token={pin.icon} /> : undefined}
                  cover={pin.cover}
                  coverDark={pin.cover_dark}
                  href={`/topics/${pin.topic}`}
                  renderLink={({ className, children }) => (
                    <Link to="/topics/$slug" params={{ slug: pin.topic }} className={className}>
                      {children}
                    </Link>
                  )}
                />
              ))}
            </div>
            <Link to="/topics" className="Home__more">
              All topics <span aria-hidden="true">→</span>
            </Link>
          </aside>
        ) : null}

        {hasSide ? (
          <div className="Home__side">
            <PopularList items={popularItems} windowDays={popular?.window_days} />
            {/* The curated links' wide-screen home. Rendered here AND below the
                fold, and Home.css shows exactly one of the two for the page's
                width (the other is `display: none`, so out of the
                accessibility tree too): moving one element between two grid
                cells would take either JavaScript measurement or a grid
                template per combination of present regions. */}
            {hasLinks ? (
              <div className="Home__sideLinks">
                <CuratedLinks links={curatedLinks} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---- Below the fold ---- */}
      {hasLinks ? (
        <div className="Home__foldLinks">
          <CuratedLinks links={curatedLinks} />
        </div>
      ) : null}

      {/* What makes this a knowledgebase and not only a blog: "Essential
          guidance", "Known limitations", "Examples / What worked" are already
          slot headings the product understands, so a tenant who curated them
          gets them here for free. */}
      {belowFold.map(({ section, heading }) => (
        <SectionBlock
          key={section.slug}
          section={section}
          heading={heading}
          id={`home-section-${section.slug}`}
          className="Home__section"
        />
      ))}

      {/* The home topic's own prose, last — the least-discovered feature in the
          product, on the front page for free. */}
      {homeLanding?.landing_markdown ? (
        <section className="Home__prose" aria-label="About this site">
          <ReadView markdown={homeLanding.landing_markdown} />
        </section>
      ) : null}

      <SiteFooter />
    </main>
  );

  // On an extra-wide route an Updates or Popular item opens beside the page;
  // otherwise this is the page, unwrapped.
  return <ReadingPaneLayout rootRef={rootRef}>{page}</ReadingPaneLayout>;
}
