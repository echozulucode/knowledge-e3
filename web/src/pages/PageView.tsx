/**
 * PageView — the item page (`/p/:slug`, and the `/items/:id` deep link).
 *
 * The article itself is `ArticleReader` (features/article), the same component
 * the reading pane embeds, so an item reads identically on its page and beside
 * a result list. What this route adds around it is what only a page has:
 *
 * 1. PageChrome (top) — breadcrumb and the Edit action
 * 2. The article column — `<ArticleReader variant="page">`, centred in the
 *    space beside the context pane at every width
 * 3. Right context pane: TOC / Properties (incl. the admin-only "Where this
 *    lives") / Tags. Beside the article at >=1180px, where each scrolls on its
 *    own; stacked below it under that.
 *
 * Authoring lives in Compose (`/p/:slug/edit`), which owns dirty state, saving,
 * conflicts and rename. Edit navigates there, and the legacy `?edit=1` deep link
 * — which used to open an editor inline on this page — forwards to the same
 * place rather than dead-ending.
 */

import { Link, useParams, useSearch, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { usePageBySlug, usePage, useTopics, useMe, useContentTypes } from '../queries.js';
import { PageChrome } from '../components/PageChrome.js';
import { seriesTitle } from '../features/series/seriesModel.js';
import { useSeriesView } from '../features/series/queries.js';
import { RightContextPane, type PaneProperty } from '../components/RightContextPane.js';
import { buildTopicLookup, displayFromSlug } from '../features/topics/topicFilters.js';
import { okfDisplaySignals, trustTierLabel } from '../features/okf/signals.js';
import { itemLocation } from '../features/sources/itemLocation.js';
import { ArticleReader } from '../features/article/ArticleReader.js';
import { articleFacts } from '../features/article/articleFacts.js';
import { headingOutline } from '../features/article/headingOutline.js';
import type { Frontmatter } from '@echozedlabs/codec';
import './PageView.css';

function propertyValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(propertyValueText).filter(Boolean).join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function visiblePropertyEntries(frontmatter: Frontmatter | undefined): Array<[string, string]> {
  return Object.entries((frontmatter ?? {}) as Record<string, unknown>)
    .map(([key, value]) => [key, propertyValueText(value).trim()] as [string, string])
    .filter(([, value]) => value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function propertyLabel(key: string): string {
  return displayFromSlug(key);
}

export function PageView() {
  const params = useParams({ strict: false }) as { slug?: string; id?: string };
  const routeItemId = params.id;
  const routeSlug = params.slug ?? '';
  const searchParams = useSearch({ strict: false }) as { edit?: string } | undefined;
  const { data: pageByRouteId, isLoading: pageByIdLoading } = usePage(routeItemId ?? '');
  const { data: pageByRouteSlug, isLoading: pageBySlugLoading } = usePageBySlug(routeItemId ? '' : routeSlug);
  const page = routeItemId ? pageByRouteId : pageByRouteSlug;
  const pageLoading = routeItemId ? pageByIdLoading : pageBySlugLoading;
  const { data: topics = [] } = useTopics();
  const { data: currentUser } = useMe();
  // A `read-only` source writes nothing back (plan §8.2), so the Edit
  // affordance is withdrawn here rather than letting the author discover the
  // 403 by saving; the hero offers the upstream link in its place.
  const upstreamOnly = page?.source?.mode === 'read-only';
  const canWrite = !!currentUser && !upstreamOnly; // anonymous (public read mode) is view-only
  const navigate = useNavigate();

  const [railCollapsed, setRailCollapsed] = useState(false);
  const editSearchValue = String(searchParams?.edit ?? '').replaceAll('"', '');
  const shouldAutoEdit = editSearchValue === '1' || editSearchValue === 'true';

  const topicLookup = useMemo(() => buildTopicLookup(topics), [topics]);

  // Page-view telemetry is NOT fired here any more: ArticleReader records it,
  // so the item page and the reading pane count a read the same way, once.

  useEffect(() => {
    document.title = page?.title || 'Untitled';
  }, [page?.title]);

  const openCompose = useCallback(() => {
    if (!page) return;
    void navigate({ to: '/p/$slug/edit', params: { slug: page.slug } });
  }, [page, navigate]);

  // `?edit=1` opened the retired inline editor (links from browse, from item
  // creation, and anything a user bookmarked). It now forwards to Compose, and
  // `replace` keeps Back going where the author came from rather than bouncing
  // through the redirect. Viewers who cannot write simply read the page.
  useEffect(() => {
    if (!shouldAutoEdit || !canWrite || !page) return;
    void navigate({ to: '/p/$slug/edit', params: { slug: page.slug }, replace: true });
  }, [shouldAutoEdit, canWrite, page, navigate]);

  // Content types feed the article facts the Properties pane repeats. Called
  // here, with the other hooks and BEFORE any early return, so hook order is
  // stable across renders (Rules of Hooks).
  const { data: contentTypes = [] } = useContentTypes();
  const facts = useMemo(() => (page ? articleFacts(page, topicLookup, contentTypes) : null), [page, topicLookup, contentTypes]);
  // The series this item belongs to, for the Properties pane's linked title.
  // Same cached response the series box and pager read; disabled when the item
  // names no series. Before the early returns, like every hook here.
  const { data: seriesView } = useSeriesView(facts?.series);

  if (pageLoading) {
    return <div className="text-center text-slate-500">Loading...</div>;
  }

  if (!page || !facts) {
    return <div className="text-center text-slate-500">Page not found</div>;
  }

  const visibleFrontmatter = facts.frontmatter;
  const propertyEntries = visiblePropertyEntries(visibleFrontmatter);

  // Table of contents for the right context pane — the same outline the
  // reading pane's "On this page" lists (ids match ReadView's heading anchors).
  const toc = headingOutline(page.body_markdown);

  /**
   * The Properties pane is an ALLOW-LIST (reader UX plan §6, R4.4). It used to
   * be a deny-list, so every frontmatter key anyone ever invented — `e3_id`,
   * `okf_version`, `generated`, a raw `source` ref — landed on a reader's
   * screen the day it was introduced. That is a leak generator rather than a
   * leak, so what a reader sees by default is stated here and everything else
   * goes behind the closed "Show all properties" disclosure.
   */
  const paneProperties: PaneProperty[] = (() => {
    const fm = (visibleFrontmatter ?? {}) as Record<string, unknown>;
    const out: PaneProperty[] = [
      { label: 'Type', value: page.type || '—' },
      { label: 'Status', value: facts.status },
      { label: 'Topic', value: facts.topic || '—' },
      { label: 'Updated', value: new Date(page.updated_at).toLocaleDateString() },
    ];
    if (facts.authors.length) out.push({ label: 'Authors', value: facts.authors.join(', ') });
    if (facts.series) {
      out.push({
        label: 'Series',
        value: (
          <Link to="/series/$slug" params={{ slug: facts.series }}>
            {seriesTitle(seriesView, facts.series)}
          </Link>
        ),
      });
    }
    // OKF v0.2 derived trust/freshness signals (§5.3, §5.5). Only surfaced when
    // the concept actually carries the relevant frontmatter, so plain pages stay
    // uncluttered.
    const okf = okfDisplaySignals(fm);
    if (fm['verified'] !== undefined) out.push({ label: 'Trust', value: trustTierLabel(okf.trustTier) });
    if (okf.staleAfter) {
      out.push({ label: 'Freshness', value: okf.stale ? `Stale (since ${okf.staleAfter})` : `Fresh (until ${okf.staleAfter})` });
    }
    if (okf.sourceCount > 0) out.push({ label: 'Sources cited', value: String(okf.sourceCount) });
    if (page.tags?.length) out.push({ label: 'Tags', value: page.tags.join(', ') });
    // Where this lives (plan B1). What arrives here is already decided by the
    // server's redaction ladder — the path reaches an admin and nobody else —
    // so this renders what it was given rather than asking about the role and
    // risking a second answer that disagrees with the first. `data-operator-
    // location` marks the one part of a reader's page that is deliberately
    // about the plumbing; external-source.spec.ts reads it.
    const location = itemLocation(page.source);
    if (location) {
      out.push({
        label: 'Where this lives',
        value: (
          <span className="kp-page-location" data-operator-location="true">
            <code>{location.id}</code>
            {location.path ? <code>{location.path}</code> : null}
            {location.url ? (
              <a href={location.url} target="_blank" rel="noreferrer noopener">
                Open the file on its host
              </a>
            ) : null}
          </span>
        ),
      });
    }
    return out;
  })();

  /** Everything the allow-list does not name, behind the disclosure. */
  const extraProperties: PaneProperty[] = propertyEntries.map(([key, value]) => ({
    label: propertyLabel(key),
    value,
    mono: key === 'source' || key === 'e3_id',
  }));

  const scrollToHeading = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="kp-pageview" data-mode="read" data-rail-collapsed={railCollapsed ? 'true' : 'false'}>
      {/* PageChrome: breadcrumb + the single Edit action, which opens Compose */}
      <PageChrome slug={page.slug} canEdit={canWrite} onEdit={openCompose} />

      {/* Responsive grid: article over the context pane, side by side at >=1180px */}
      <div className="kp-pageview-grid">
        {/* The body is the article's scroll container and full-width surface;
            the reader inside it is the centred, capped column. The route's slug
            is passed as-is on `/p/:slug` so the reader shares this page's cached
            query (a renamed item's old slug still resolves to the same entry);
            the id deep link hands over the item's own slug. */}
        <div className="kp-pageview-body">
          <ArticleReader slug={routeItemId ? page.slug : routeSlug} variant="page" />
        </div>

        {/* Right context pane: TOC / Properties / Tags — Obsidian-style, scrolls
            independently from the article. */}
        <aside className="kp-pageview-rail">
          <RightContextPane
            toc={toc}
            properties={paneProperties}
            extraProperties={extraProperties}
            tags={page.tags ?? []}
            collapsed={railCollapsed}
            onToggleCollapsed={() => setRailCollapsed((v) => !v)}
            onScrollTo={scrollToHeading}
            // One ranked, faceted surface answers "everything about this",
            // wherever it lives (plan §6, R4.7) — /browse answered only part of it.
            onTagClick={(tag) => navigate({ to: '/search', search: { tag } as any })}
          />
        </aside>
      </div>
    </div>
  );
}
