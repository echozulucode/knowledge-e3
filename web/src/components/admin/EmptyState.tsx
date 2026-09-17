/**
 * EmptyState — what a collection shows when there is nothing in it
 * (the admin UX review §3.2).
 *
 * Use it for "no rows yet" (tone `neutral`, with the create action) and for
 * "all clear" results such as an empty lint queue (tone `success`). Pass it as
 * DataTable's `empty`. Do not use it for loading or errors - DataTable owns
 * those states, with a Retry.
 *
 * Copy rule (§3.3): `title` says what is empty in plain words ("No sections
 * yet"); `body` is one sentence on what this list is for or why it is empty
 * (e.g. "No sources match 'git'."); `action` is the single next step, usually
 * the same primary action the page header offers.
 */
import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'success';
}

export function EmptyState({ title, body, action, tone = 'neutral' }: EmptyStateProps): JSX.Element {
  return (
    <div className="kp-empty" data-tone={tone}>
      <svg className="kp-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {tone === 'success' ? (
          <>
            <circle cx="12" cy="12" r="10" />
            <polyline points="16.5 9 10.5 15 7.5 12" />
          </>
        ) : (
          <>
            <path d="M3 13h5l1.5 3h5L16 13h5" />
            <path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
          </>
        )}
      </svg>
      <p className="kp-empty__title">{title}</p>
      {body ? <div className="kp-empty__body">{body}</div> : null}
      {action ? <div className="kp-empty__action">{action}</div> : null}
    </div>
  );
}
