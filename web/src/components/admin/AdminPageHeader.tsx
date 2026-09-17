/**
 * AdminPageHeader — the one page header for every admin page
 * (the admin UX review §3.1): title, one sentence, the page's
 * primary action top-right, optional secondary actions, "Learn more" and meta
 * (counts, freshness). Replaces the per-page gradient heroes. Copy rule: the
 * description is ONE sentence; explanation belongs in field helper text or
 * behind `learnMore`.
 */
import type { ReactNode } from 'react';
import './AdminPageHeader.css';

export interface AdminPageHeaderProps {
  title: string;
  /** One sentence. */
  description?: ReactNode;
  /** Muted line under the description: counts, freshness. */
  meta?: ReactNode;
  /** The page's primary action (e.g. a "New section" button or link). */
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  /** A disclosure or link with the longer explanation. */
  learnMore?: ReactNode;
  /** Breadcrumb/back link rendered above the title (edit pages). */
  back?: ReactNode;
  /** Id for the <h1>, so the page's landmark can be `aria-labelledby` it. */
  titleId?: string;
}

export function AdminPageHeader({ title, description, meta, primaryAction, secondaryActions, learnMore, back, titleId }: AdminPageHeaderProps): JSX.Element {
  return (
    <header className="kp-admin-header">
      {back ? <div className="kp-admin-header__back">{back}</div> : null}
      <div className="kp-admin-header__row">
        <div className="kp-admin-header__text">
          <h1 className="kp-admin-header__title" id={titleId}>{title}</h1>
          {description ? <p className="kp-admin-header__description">{description}</p> : null}
          {meta ? <p className="kp-admin-header__meta">{meta}</p> : null}
          {learnMore ? <div className="kp-admin-header__learn">{learnMore}</div> : null}
        </div>
        {primaryAction || secondaryActions ? (
          <div className="kp-admin-header__actions">
            {secondaryActions}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </header>
  );
}
