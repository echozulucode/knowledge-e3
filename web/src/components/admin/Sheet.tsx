/**
 * Sheet — a right-side panel for detail and edit (the admin UX review §3.2).
 *
 * Choose it by size (§3.3): detail with actions or history (a user, a source), or
 * an edit form too big for a dialog but without a live preview. Up to ~5 fields →
 * EditDialog; many or dependent fields, or a preview beside the form → EditPageLayout.
 *
 * Two modes, one component:
 *   - **Detail**: `children` and/or `tabs`; header actions in `headerActions`.
 *   - **Edit**: pass `form` — the body becomes a <form> with a sticky footer
 *     (Cancel + submit), closing while dirty asks "Discard changes?", closing is
 *     refused while saving, and `form.error` renders next to the buttons.
 *
 * Built on Modal (focus trap, Esc, focus restore), anchored to the right edge;
 * full-screen below 640px. The parent owns URL state (e.g. `?user=<id>`) and
 * renders the sheet when it should be open.
 */
import { useId, useState, type ReactNode } from 'react';
import { Modal } from '../Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import './Sheet.css';

export interface SheetTab {
  id: string;
  label: string;
  /** Count shown after the label (e.g. open conflicts). */
  badge?: number;
  content: ReactNode;
}

export interface SheetForm {
  isDirty: boolean;
  isSaving: boolean;
  /** Default: isDirty. */
  canSave?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  error?: string | null;
}

export interface SheetProps {
  title: string;
  subtitle?: ReactNode;
  /** Buttons in the header, e.g. "Sync now", "Edit". */
  headerActions?: ReactNode;
  onClose: () => void;
  tabs?: SheetTab[];
  /** Controlled tab; defaults to the first tab. */
  activeTab?: string;
  onTabChange?: (id: string) => void;
  children?: ReactNode;
  width?: 'md' | 'lg';
  form?: SheetForm;
}

export function Sheet({ title, subtitle, headerActions, onClose, tabs, activeTab, onTabChange, children, width = 'md', form }: SheetProps): JSX.Element {
  const titleId = useId();
  const tabsId = useId();
  const [innerTab, setInnerTab] = useState<string | undefined>(tabs?.[0]?.id);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const currentTab = activeTab ?? innerTab ?? tabs?.[0]?.id;
  const canSave = form ? (form.canSave ?? form.isDirty) : false;

  const requestClose = (): void => {
    if (confirmingDiscard || form?.isSaving) return;
    if (form?.isDirty) setConfirmingDiscard(true);
    else onClose();
  };

  const selectTab = (id: string): void => {
    setInnerTab(id);
    onTabChange?.(id);
  };

  const tabList = tabs && tabs.length > 0 ? (
    <div className="kp-sheet__tabs" role="tablist" aria-label={`${title} sections`}>
      {tabs.map((tab, index) => {
        const selected = tab.id === currentTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${tabsId}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className="kp-sheet__tab"
            onClick={() => selectTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
              e.preventDefault();
              const last = tabs.length - 1;
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : index === 0 ? last : index - 1;
              const nextTab = tabs[next]!;
              selectTab(nextTab.id);
              document.getElementById(`${tabsId}-tab-${nextTab.id}`)?.focus();
            }}
          >
            {tab.label}
            {tab.badge ? <span className="kp-sheet__tabBadge">{tab.badge}</span> : null}
          </button>
        );
      })}
    </div>
  ) : null;

  const panels = tabs?.map((tab) => (
    <div
      key={tab.id}
      role="tabpanel"
      id={`${tabsId}-panel-${tab.id}`}
      aria-labelledby={`${tabsId}-tab-${tab.id}`}
      hidden={tab.id !== currentTab}
      className="kp-sheet__panel"
    >
      {tab.id === currentTab ? tab.content : null}
    </div>
  ));

  const head = (
    <div className="kp-sheet__head">
      <div className="kp-sheet__titles">
        <h2 id={titleId} className="kp-sheet__title">
          {title}
        </h2>
        {subtitle ? <div className="kp-sheet__subtitle">{subtitle}</div> : null}
      </div>
      <div className="kp-sheet__headActions">
        {headerActions}
        <button type="button" className="kp-sheet__close" onClick={requestClose} aria-label={`Close ${title}`} disabled={form?.isSaving}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );

  const body = (
    <div className="kp-sheet__body">
      {tabList}
      {panels}
      {children}
    </div>
  );

  return (
    <>
      <Modal onClose={requestClose} labelledBy={titleId} backdropClassName="kp-sheet-backdrop" className="kp-sheet" closeOnBackdrop>
        <div className="kp-sheet__frame" data-width={width}>
          {form ? (
            <form
              className="kp-sheet__form"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave && !form.isSaving) form.onSubmit();
              }}
            >
              {head}
              {body}
              <div className="kp-sheet__foot">
                {form.error ? (
                  <p className="kp-sheet__error" role="alert">
                    {form.error}
                  </p>
                ) : null}
                <div className="kp-sheet__footActions">
                  <button type="button" className="kp-sheet__button" onClick={requestClose} disabled={form.isSaving}>
                    Cancel
                  </button>
                  <button type="submit" className="kp-sheet__button kp-sheet__button--primary" disabled={!canSave || form.isSaving}>
                    {form.isSaving ? 'Saving…' : form.submitLabel}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <>
              {head}
              {body}
            </>
          )}
        </div>
      </Modal>
      {confirmingDiscard ? (
        <ConfirmDialog
          title="Discard changes?"
          body="Your changes in this panel have not been saved."
          confirmLabel="Discard"
          tone="danger"
          onConfirm={() => {
            setConfirmingDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmingDiscard(false)}
        />
      ) : null}
    </>
  );
}
