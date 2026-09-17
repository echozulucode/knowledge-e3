/**
 * EditPageLayout — a dedicated, linkable edit page (the admin UX review §3.2, §4.1).
 *
 * Choose the edit surface by size (§3.3):
 *   - ≤ ~5 independent fields                                → EditDialog
 *   - detail with actions or history                         → side sheet
 *   - many fields, fields that depend on each other, or a
 *     live preview that must sit beside the form             → THIS (e.g. /admin/sections/$slug)
 *
 * Shape: a sticky header (back link, title, status, Cancel + Save) so Save is
 * always reachable on a long form; a form column of FormSections; an optional
 * `aside` (preview) beside it when the container is ≥ 64rem and below it when
 * narrower (container query); an optional `dangerZone` last, far from Save.
 *
 * Behaviour wired in:
 *   - useUnsavedChangesGuard(isDirty): leaving by link, back button, tab close
 *     or reload asks "Discard unsaved changes?". `onCancel` should navigate
 *     back (the guard then asks) or reset the form.
 *   - Cmd/Ctrl+S calls `onSave` when `canSave` and not saving. The browser's
 *     "Save page" is suppressed on this page either way. Ignored while a dialog
 *     that is not part of this page (a Modal) has focus.
 *   - `errorSummary` (e.g. "2 fields need attention" or a save failure) renders
 *     under the header as role="alert" and takes focus when it appears, so a
 *     failed save is announced where the admin is looking (§3.3: feedback next
 *     to the action, never at the end of the page).
 *   - Save is disabled without `canSave`; the status text beside it says why.
 *
 * `canSave` defaults to `isDirty`. `saveLabel` defaults to "Save".
 */
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { isSaveShortcut, saveStatus } from './EditPageLayout.model.js';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.js';
import './EditPageLayout.css';

export interface EditPageLayoutProps {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: ReactNode;
  isDirty: boolean;
  isSaving: boolean;
  /** Default: isDirty. */
  canSave?: boolean;
  saveLabel?: string;
  onSave: () => void;
  onCancel: () => void;
  /** Preview column; stacks below the form on narrow containers. */
  aside?: ReactNode;
  /** Accessible name of the aside landmark. Default "Preview". */
  asideLabel?: string;
  dangerZone?: ReactNode;
  errorSummary?: string | null;
  children: ReactNode;
  /** Extra header content between the title and the buttons (e.g. a StatusChip). */
  headerMeta?: ReactNode;
}

export function EditPageLayout({
  backTo,
  backLabel,
  title,
  subtitle,
  isDirty,
  isSaving,
  canSave: canSaveProp,
  saveLabel = 'Save',
  onSave,
  onCancel,
  aside,
  asideLabel = 'Preview',
  dangerZone,
  errorSummary,
  children,
  headerMeta,
}: EditPageLayoutProps): JSX.Element {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const canSave = canSaveProp ?? isDirty;
  const saveEnabled = canSave && !isSaving;
  const status = saveStatus({ isDirty, isSaving, canSave });

  useUnsavedChangesGuard(isDirty);

  // Latest values for the window listener without re-subscribing every render.
  const saveRef = useRef({ saveEnabled, onSave });
  saveRef.current = { saveEnabled, onSave };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSaveShortcut(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const dialog = target?.closest('[aria-modal="true"]');
      // A dialog opened over the page (picker, confirm) owns the keyboard.
      if (dialog && !rootRef.current?.contains(dialog)) return;
      event.preventDefault();
      if (saveRef.current.saveEnabled) saveRef.current.onSave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Focus the summary when it appears (not on every re-render with the same text).
  const previousErrorRef = useRef<string | null | undefined>(null);
  useEffect(() => {
    if (errorSummary && errorSummary !== previousErrorRef.current) {
      errorRef.current?.focus();
    }
    previousErrorRef.current = errorSummary;
  }, [errorSummary]);

  return (
    <div ref={rootRef} className="kp-editpage" data-has-aside={aside ? 'true' : undefined}>
      <header className="kp-editpage__header" aria-labelledby={titleId}>
        <div className="kp-editpage__heading">
          <Link to={backTo as never} className="kp-editpage__back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {backLabel}
          </Link>
          <h1 id={titleId} className="kp-editpage__title">
            {title}
          </h1>
          {subtitle ? <div className="kp-editpage__subtitle">{subtitle}</div> : null}
        </div>
        <div className="kp-editpage__actions">
          {headerMeta}
          <span className="kp-editpage__status" data-status={status.status} role="status">
            {status.text}
          </span>
          <button type="button" className="kp-editpage__button" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button
            type="button"
            className="kp-editpage__button kp-editpage__button--primary"
            onClick={() => {
              if (saveEnabled) onSave();
            }}
            disabled={!saveEnabled}
            aria-keyshortcuts="Control+S Meta+S"
          >
            {isSaving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </header>

      {errorSummary ? (
        <div ref={errorRef} className="kp-editpage__error" role="alert" tabIndex={-1}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="7" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{errorSummary}</span>
        </div>
      ) : null}

      <div className="kp-editpage__body">
        <div className="kp-editpage__main">
          {children}
          {dangerZone ? <div className="kp-editpage__danger">{dangerZone}</div> : null}
        </div>
        {aside ? (
          <aside className="kp-editpage__aside" aria-label={asideLabel}>
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
