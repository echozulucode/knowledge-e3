/**
 * ArticleReader — an item, read: header, series box, body, series pager,
 * Related. Embeddable wherever an article is read.
 *
 * It was the article column of PageView. It is a component of its own because
 * there are now two places an article is read: the item page (`/p/:slug`), and
 * the reading pane on extra-wide screens, where a result opens beside the list
 * it came from. Both must show the same article the same way, so both render
 * this, and each surface owns only what is truly its own:
 *
 * - `variant="page"` — PageView wraps it with the breadcrumb, the Edit action,
 *   the document title and the right context pane (TOC / Properties / Tags,
 *   including the admin-only "Where this lives").
 * - `variant="pane"` — the pane shell supplies Close / Open full page. With no
 *   context pane beside it, the reader adds an "On this page" outline and the
 *   item's tags itself, and item links can open in the same pane (`onOpenItem`).
 *
 * The reader fetches its item by slug. On the page that is the same cached
 * query PageView reads, so the article is not requested twice.
 */
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react';
import { Article, ArticleHeader, ContentTypeBadge, FreshnessBadge, SourceBadge, TrustBadge } from '@echozedlabs/ui';
import { useContentTypes, useLinkIndex, useMe, usePageBySlug, useTopics } from '../../queries.js';
import { ReadView } from '../../components/ReadView.js';
import { RelatedPanel } from '../../components/RelatedPanel.js';
import { useItemSignals } from '../compose/queries.js';
import { openReviewOf, reviewDisplayState } from '../review/reviewModel.js';
import { readingTimeMinutes } from '../blog/blogMeta.js';
import { SeriesBox, SeriesPager } from '../series/SeriesNav.js';
import { extractCopyableEntries } from '../items/copyableContent.js';
import { buildTopicLookup } from '../topics/topicFilters.js';
import { trustTier } from '../okf/signals.js';
import { useToast } from '../../hooks/useToast.js';
import { Icon, appIcons } from '../../icons.js';
import { articleFacts } from './articleFacts.js';
import { headingOutline } from './headingOutline.js';
import { interceptedItemSlug } from './itemLinkIntercept.js';
import { usePageViewTelemetry } from './pageViewTelemetry.js';
import { ArticleOutline } from './ArticleOutline.js';
import './ArticleReader.css';

export interface ArticleReaderProps {
  slug: string;
  variant: 'page' | 'pane';
  /** Pane only: open another item in the same pane (wiki links, series prev/next, related). When absent, links navigate normally. */
  onOpenItem?: (slug: string) => void;
  /** Pane only: heading id / ref target so the pane can move focus to the title on open. */
  titleId?: string;
}

interface LocalNotice {
  kind: 'success' | 'error';
  message: string;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: number; status?: number } | null)?.statusCode
    ?? (error as { status?: number } | null)?.status;
  return status === 404;
}

export function ArticleReader({ slug, variant, onOpenItem, titleId }: ArticleReaderProps) {
  const { data: page, isLoading, isError, error, refetch } = usePageBySlug(slug);
  const { data: topics = [] } = useTopics();
  const { data: currentUser } = useMe();
  const { data: knownSlugs } = useLinkIndex();
  const { data: contentTypes = [] } = useContentTypes();
  // Trust/freshness signals are derived on GET /items/:id only (not /pages/*).
  const { data: itemSignals } = useItemSignals(page?.id);
  const { push: pushToast } = useToast();
  const [localNotice, setLocalNotice] = useState<LocalNotice | null>(null);
  // State, not a ref: the outline needs a re-render once the root exists.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  usePageViewTelemetry(page?.id);

  useEffect(() => {
    if (localNotice?.kind !== 'success') return;
    const timeout = window.setTimeout(() => setLocalNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [localNotice]);

  const topicLookup = useMemo(() => buildTopicLookup(topics), [topics]);
  const facts = useMemo(() => (page ? articleFacts(page, topicLookup, contentTypes) : null), [page, topicLookup, contentTypes]);
  const outline = useMemo(() => (variant === 'pane' ? headingOutline(page?.body_markdown) : []), [variant, page?.body_markdown]);

  // The pane moves focus to the title when it opens an item. `ArticleHeader`
  // owns the <h1> and takes no id, so the id is put on the rendered heading
  // here — in a layout effect, so it is in place before any effect of the
  // pane's runs after the article appears.
  useLayoutEffect(() => {
    if (!titleId || !root) return;
    const heading = root.querySelector<HTMLElement>('.kp-article-header__title');
    if (!heading) return;
    heading.id = titleId;
    heading.tabIndex = -1;
  }, [titleId, root, page?.id]);

  const handleReadCopy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ kind: 'success', message: 'Copied to clipboard.' });
    } catch {
      setLocalNotice({ kind: 'error', message: 'Copy failed. Check browser clipboard permissions and try again.' });
      pushToast({ kind: 'error', message: 'Copy failed. Check browser clipboard permissions and try again.' });
    }
  }, [pushToast]);

  // One delegated handler for every item link in the article (see
  // itemLinkIntercept.ts). CAPTURE phase on purpose: a router <Link> handles
  // its own click on the anchor during bubbling, and it stands down when the
  // event is already default-prevented — so deciding first, here, is what lets
  // a series or Related link open in the pane without either component knowing.
  const handleClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!onOpenItem) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor) return;
    const target = interceptedItemSlug(
      event,
      { href: anchor.getAttribute('href'), target: anchor.getAttribute('target'), download: anchor.hasAttribute('download') },
      window.location.origin,
    );
    if (!target) return;
    event.preventDefault();
    onOpenItem(target);
  }, [onOpenItem]);

  if (isLoading) {
    return (
      <div className="kp-article-reader kp-article-reader--status text-center text-slate-500" data-variant={variant} role="status">
        Loading...
      </div>
    );
  }

  if (isError && !isNotFound(error)) {
    return (
      <div className="kp-article-reader kp-article-reader--status text-center text-slate-500" data-variant={variant} role="alert">
        <p>This page could not be loaded.</p>
        <button type="button" className="kp-article-reader__retry" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  if (!page || !facts) {
    return (
      <div className="kp-article-reader kp-article-reader--status text-center text-slate-500" data-variant={variant}>
        Page not found
      </div>
    );
  }

  // A `read-only` source writes nothing back (plan §8.2); the header says who
  // makes changes instead of leaving the reader to wonder.
  const upstreamOnly = page.source?.mode === 'read-only';
  const readCopyableEntries = extractCopyableEntries(page).filter((entry) => entry.source === 'frontmatter');
  const tags = page.tags ?? [];

  return (
    <div
      ref={setRoot}
      className="kp-article-reader"
      data-variant={variant}
      onClickCapture={onOpenItem ? handleClickCapture : undefined}
    >
      {/*
        The article shell and its header are `@echozedlabs/ui`'s (plan R1.2).
        What used to be here was ~120 lines of inline `style={{}}` objects, so
        the read page's typography lived outside the token system and nothing
        else — Compose's Preview above all — could render an article. The
        facts are unchanged; only their owner is. `kp-page-hero` is kept as a
        class so existing selectors (and specs) still find the header.
      */}
      <Article
        className="kp-article-reader__article"
        header={
          <>
            {/* The cover is rendered here rather than by ArticleHeader, whose
                cover is always decorative (`alt=""`) — right on a card, where the
                title sits beside it, but an author who wrote `cover_alt` for the
                article page meant it to be read (home plan R2.11). The classes
                are ArticleHeader's own, so it looks exactly as it did. */}
            {facts.isArticle && facts.cover ? (
              <div className="kp-page-cover">
                <img className="kp-article-header__cover" src={facts.cover} alt={facts.coverAlt ?? ''} loading="lazy" />
              </div>
            ) : null}
            <ArticleHeader
              className="kp-page-hero"
              title={page.title || 'Untitled'}
              cover={null}
              description={facts.summary}
              status={facts.statusTone}
              notice={upstreamOnly ? 'Changes to this page are made by the team that owns it.' : null}
              badges={
                <>
                  {page.type ? <ContentTypeBadge type={page.type} /> : null}
                  {/* While the item's change request is open (plan §8.2) the badge
                      reads "In review". The link to the change is offered only to
                      a reader who could act on it (plan §6, R4.2). */}
                  <FreshnessBadge
                    displayState={reviewDisplayState(itemSignals?.display_state, openReviewOf(itemSignals))}
                    staleAfter={itemSignals?.stale_after}
                    supersededBy={itemSignals?.superseded_by}
                    reviewUrl={openReviewOf(itemSignals)?.url}
                    canOpenReview={Boolean(currentUser)}
                    renderLink={(target) => <Link to="/p/$slug" params={{ slug: target }}>{target}</Link>}
                  />
                  {/* The content is maintained somewhere else, and that is the
                      whole of what the reader is told (plan §6, R4.1). */}
                  <SourceBadge source={page.source} />
                  {facts.topic ? (
                    <span className="kp-page-hero__topic">
                      in <b>{facts.topic}</b>
                      {/* Opens /search scoped to this topic with no query: its
                          items newest first, and a box to narrow them. */}
                      <Link
                        to="/search"
                        search={{ topic: facts.topicSearchValue } as never}
                        className="kp-page-hero__topicSearch"
                        aria-label={`Search in ${facts.topic}`}
                        title={`Search in ${facts.topic}`}
                      >
                        <Icon icon={appIcons.magnifyingGlass} fixedWidth={false} />
                        <span>Search</span>
                      </Link>
                    </span>
                  ) : null}
                </>
              }
              meta={[
                ...(facts.isArticle
                  ? [
                      facts.authors.length ? `By ${facts.authors.join(', ')}` : null,
                      facts.date || null,
                      `${readingTimeMinutes(page.body_markdown)} min read`,
                    ]
                  : [page.updated_at ? `Updated ${new Date(page.updated_at).toLocaleDateString()}` : null]),
                // The trust tier, stated plainly as part of the byline on every
                // item page — quiet text with an explanation behind it, never a
                // chip (home plan R2.4). Last, so opening the explanation wraps
                // below the byline instead of pushing the other facts apart.
                <TrustBadge
                  key="trust"
                  variant="inline"
                  tier={itemSignals?.trust_tier ?? trustTier(facts.frontmatter as Record<string, unknown>)}
                  verifiedAt={itemSignals?.last_verified_at}
                  generatedBy={itemSignals?.generated_by}
                />,
              ]}
            />
          </>
        }
        aside={
          <>
            {/* "Part 2 of 5 in <Series>" replaces the old `Series: <slug>` byline
                string; renders nothing unless this is one of 2+ visible parts. */}
            {facts.series ? <SeriesBox slug={facts.series} currentId={page.id} /> : null}
            {variant === 'pane' ? <ArticleOutline entries={outline} root={root} /> : null}
            {readCopyableEntries.length > 0 ? (
              <section className="kp-copyable-panel" aria-label="Copyable content">
                <div className="kp-copyable-panel-header">
                  <p className="kp-copyable-eyebrow">Copyable content</p>
                  <h2>Quick copy</h2>
                </div>
                <div className="kp-copyable-list">
                  {readCopyableEntries.map((entry) => (
                    <button
                      key={`${entry.label}:${entry.value}`}
                      type="button"
                      className="kp-copyable-entry"
                      onClick={() => void handleReadCopy(entry.value)}
                      title={entry.value}
                      aria-label={`Copy ${entry.label}`}
                    >
                      <span className="kp-copyable-entry-label">{entry.label}</span>
                      <code>{entry.value}</code>
                      <Icon icon={appIcons.copy} />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        }
        footer={
          <>
            {facts.series ? <SeriesPager slug={facts.series} currentId={page.id} /> : null}
            <RelatedPanel pageId={page.id} />
            {/* On the page the tags are the context pane's Tags tab; the pane
                has no context pane, so they close the article instead. Tag
                links are searches, never items, so they navigate normally. */}
            {variant === 'pane' && tags.length > 0 ? (
              <nav className="kp-article-reader__tags" aria-label="Tags">
                {tags.map((tag) => (
                  <Link key={tag} to="/search" search={{ tag } as never} className="kp-article-reader__tag">
                    #{tag}
                  </Link>
                ))}
              </nav>
            ) : null}
          </>
        }
      >
        <ReadView markdown={page.body_markdown ?? ''} knownSlugs={knownSlugs} />
      </Article>

      {localNotice && (
        <div className="kp-local-notice" role={localNotice.kind === 'error' ? 'alert' : 'status'}>
          <span>{localNotice.message}</span>
        </div>
      )}
    </div>
  );
}
