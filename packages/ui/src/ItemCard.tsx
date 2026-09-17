/**
 * ItemCard / ItemRow — the two shapes an item takes in a list
 * (reader UX plan R1.3).
 *
 * Before these, the same item rendered five different ways — different badge
 * sets, different dates, different preview text — because every index surface
 * wrote its own markup: `Home.DocCard`, `FeedList.FeedCard`,
 * `TopicLanding.ItemRow`, `Sections.__article`/`__listItem`, `SearchResultRow`.
 * The indexes are allowed to differ in SHAPE (a blog feed is a card grid, a
 * topic landing is a list); they are not allowed to differ in FACTS. So there
 * are exactly two shapes here and both take the same slots.
 *
 * Two deliberate constraints:
 *
 * - **This package never routes.** Titles are rendered through `renderLink`, the
 *   same escape hatch `FreshnessBadge` uses, so the host supplies its router's
 *   link component and `@echozedlabs/ui` stays free of `@tanstack/react-router`.
 * - **Badges are a slot, not a prop.** The badge components are already shared;
 *   what was NOT shared was the decision of which badges an item shows. Passing
 *   them in as one node keeps that decision at the call site (a search result
 *   legitimately shows fewer than an article header) while the row/card
 *   guarantees they are in the same place, in the same order, with the same
 *   spacing everywhere.
 */
import type { ReactNode } from 'react';

/** Renders the item's title as a link. Defaults to a plain anchor. */
export type RenderItemLink = (link: { href: string; className: string; children: ReactNode }) => ReactNode;

const defaultRenderLink: RenderItemLink = ({ href, className, children }) => (
  <a href={href} className={className}>
    {children}
  </a>
);

interface ItemPresentationProps {
  /** Item title. */
  title: ReactNode;
  /** Destination, e.g. `/p/my-slug`. */
  href: string;
  /** Router-aware link renderer; a plain `<a>` when omitted. */
  renderLink?: RenderItemLink;
  /** One line about the item — always from `itemPreview`, never hand-rolled. */
  preview?: string | null;
  /** Badge row (content type, trust, freshness, source…). */
  badges?: ReactNode;
  /** Byline-ish facts: author, date, reading time. Rendered `·`-separated. */
  meta?: ReactNode[];
  className?: string;
  /** Playwright hook, e.g. `feed-card`. */
  testId?: string;
}

export interface ItemCardProps extends ItemPresentationProps {
  /** Cover image URL. Decorative: the title carries the meaning. */
  cover?: string | null;
  /**
   * Where the cover goes. `row` (default) puts it in a side column — the full
   * width feed card; `stacked` puts it across the top as a 16:9 banner, which
   * is what a narrow card in a `minmax(280px, 1fr)` grid needs. This is a real
   * difference with a real reason, so it is a variant rather than something one
   * of the two call sites has to give up.
   */
  layout?: 'row' | 'stacked';
  /**
   * Heading level for the title. A feed is a flat list of cards under one page
   * heading (h3); a Section's card grid sits under its own section heading and
   * uses h2. The outline is the call site's business, not the card's.
   */
  titleAs?: 'h2' | 'h3';
  /** Extra node after the meta line, e.g. a series chip. */
  footer?: ReactNode;
}

/** `·`-separated metadata line; renders nothing when there is nothing to say. */
function MetaLine({ items, className }: { items?: ReactNode[]; className: string }) {
  const parts = (items ?? []).filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className={className}>
      {parts.map((part, index) => (
        // Index keys are correct here: this is a positional, never-reordered
        // list of already-rendered facts, not identified entities.
        <span key={index} className="kp-item-meta__part">
          {index > 0 ? (
            <span className="kp-item-meta__sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </div>
  );
}

/**
 * The card shape: cover, badges, title, preview, byline. Used wherever items
 * are browsed visually — the Latest feed, a blog topic landing, a publishing
 * Section's grid.
 */
export function ItemCard({
  title,
  href,
  renderLink = defaultRenderLink,
  preview,
  badges,
  meta,
  cover,
  layout = 'row',
  titleAs = 'h3',
  footer,
  className,
  testId,
}: ItemCardProps) {
  const Heading = titleAs;
  return (
    <article
      className={className ? `kp-item-card ${className}` : 'kp-item-card'}
      data-layout={layout}
      data-testid={testId}
    >
      {cover ? <img className="kp-item-card__cover" src={cover} alt="" loading="lazy" /> : null}
      <div className="kp-item-card__body">
        {badges ? <div className="kp-item-badges">{badges}</div> : null}
        <Heading className="kp-item-card__title">
          {renderLink({ href, className: 'kp-item-card__titleLink', children: title })}
        </Heading>
        {preview ? <p className="kp-item-card__preview">{preview}</p> : null}
        <MetaLine items={meta} className="kp-item-meta kp-item-card__meta" />
        {footer ? <div className="kp-item-card__footer">{footer}</div> : null}
      </div>
    </article>
  );
}

export interface ItemRowProps extends ItemPresentationProps {
  /** Trailing affordance pinned to the right, e.g. a chevron. */
  trailing?: ReactNode;
}

/**
 * The row shape: title, badges, preview. Used wherever items are listed
 * densely — a topic landing's Section blocks, a Section's list layout.
 *
 * The whole row is a click target: the title link is stretched over the row by
 * CSS (`item.css`), which is how the previous Sections list behaved by wrapping
 * everything in one `<Link>`. Doing it in CSS instead keeps exactly one link in
 * the accessibility tree, with the title as its name, and leaves room for real
 * interactive children (a badge's PR link) to sit above it.
 */
export function ItemRow({
  title,
  href,
  renderLink = defaultRenderLink,
  preview,
  badges,
  meta,
  trailing,
  className,
  testId,
}: ItemRowProps) {
  return (
    <li className={className ? `kp-item-row ${className}` : 'kp-item-row'} data-testid={testId}>
      <div className="kp-item-row__main">
        <div className="kp-item-row__head">
          {renderLink({ href, className: 'kp-item-row__title', children: title })}
          {badges ? <span className="kp-item-badges kp-item-row__badges">{badges}</span> : null}
        </div>
        {preview ? <p className="kp-item-row__preview">{preview}</p> : null}
        <MetaLine items={meta} className="kp-item-meta kp-item-row__meta" />
      </div>
      {trailing ? <span className="kp-item-row__trailing">{trailing}</span> : null}
    </li>
  );
}
