/**
 * Article / ArticleHeader — the shell a published item is read in
 * (reader UX plan R1.2).
 *
 * The read page's header used to be a wall of inline `style={{}}` objects
 * inside `PageView.tsx`: a cover `<img>`, a badge row, an `<h1>`, a lead
 * paragraph and a meta line, each with its typography written out by hand. That
 * had two consequences — the article's typography was not in the token system,
 * and nothing else could render an article, so Compose's Preview previewed a
 * different page than the one it was about to publish.
 *
 * So the header is a component, its props are the facts an article header
 * states, and its styling is `Article.css` over the existing tokens. It renders
 * no routes and fetches nothing: badges and meta arrive as nodes, exactly as in
 * `ItemCard`, so the read page, a preview and any future surface put the same
 * facts in the same places.
 */
import type { ReactNode } from 'react';

export interface ArticleHeaderProps {
  /** Item title. The one `<h1>` on the page. */
  title: ReactNode;
  /** Hero image URL, when the item carries one. Decorative. */
  cover?: string | null;
  /** Badge row: content type, trust, freshness, source, "in Topic". */
  badges?: ReactNode;
  /** The item's own one-line description — always from `itemPreview`. */
  description?: string | null;
  /**
   * Publication status. Rendered as a quiet pill; `null` omits it entirely,
   * for surfaces where status is not a fact about the content (a preview of an
   * unsaved draft, say).
   */
  status?: 'published' | 'draft' | null;
  /** Byline facts — author, date, reading time, series. Rendered `·`-separated. */
  meta?: ReactNode[];
  /** A note above the title, e.g. "edits are made upstream". */
  notice?: ReactNode;
  className?: string;
}

const STATUS_LABELS = { published: 'Published', draft: 'Draft' } as const;

export function ArticleHeader({
  title,
  cover,
  badges,
  description,
  status,
  meta,
  notice,
  className,
}: ArticleHeaderProps) {
  const metaParts = (meta ?? []).filter(Boolean);
  return (
    <header className={className ? `kp-article-header ${className}` : 'kp-article-header'}>
      {cover ? <img className="kp-article-header__cover" src={cover} alt="" loading="lazy" /> : null}
      {badges ? <div className="kp-item-badges kp-article-header__badges">{badges}</div> : null}
      {notice ? (
        <p className="kp-article-header__notice" role="note">
          {notice}
        </p>
      ) : null}
      <h1 className="kp-article-header__title">{title}</h1>
      {description ? <p className="kp-article-header__description">{description}</p> : null}
      {status || metaParts.length > 0 ? (
        <div className="kp-article-header__meta">
          {status ? (
            <span className="kp-article-header__status" data-status={status}>
              {STATUS_LABELS[status]}
            </span>
          ) : null}
          {metaParts.map((part, index) => (
            // Positional facts, never reordered — see the same note in ItemCard.
            <span key={index} className="kp-item-meta__part">
              <span className="kp-item-meta__sep" aria-hidden="true">
                ·
              </span>
              {part}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
}

export interface ArticleProps {
  /** Usually an `<ArticleHeader>`. */
  header?: ReactNode;
  /** Anything between the header and the body, e.g. the copyable-content panel. */
  aside?: ReactNode;
  /** The rendered body — `ReadView` on the read page and in a preview. */
  children?: ReactNode;
  /**
   * After the body: where the reading path continues (reader UX plan R4.7).
   * The Related block lives here rather than in the rail because it is the
   * corpus arguing that it is one corpus — suggestions cross repositories, and
   * a reader who has finished the article is who they are for.
   */
  footer?: ReactNode;
  className?: string;
}

/** The article element itself: header, optional aside, body, optional footer. */
export function Article({ header, aside, children, footer, className }: ArticleProps) {
  return (
    <article className={className ? `kp-article ${className}` : 'kp-article'}>
      {header}
      {aside}
      <div className="kp-article__body">{children}</div>
      {footer}
    </article>
  );
}
