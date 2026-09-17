/**
 * EditDialog — a small create/edit form in a dialog (the admin UX review §3.2).
 *
 * Choose it by size (§3.3): up to ~5 independent fields with no live preview
 * (create a token, rename a tag group, pin a topic). More fields, fields that
 * depend on each other, or a preview → EditPageLayout; detail with actions or
 * history → a side sheet.
 *
 * Behaviour:
 *   - Built on Modal: focus moves in, Tab is trapped, focus returns on close.
 *   - The body is a <form>: Enter in a text field submits (when `canSave` and
 *     not saving). `canSave` defaults to `isDirty`.
 *   - Closing while dirty (Esc, backdrop, Cancel) asks "Discard changes?" in a
 *     ConfirmDialog; closing is refused while `isSaving`.
 *   - `error` (e.g. the server refused) renders inside the dialog next to the
 *     buttons as role="alert" (§3.3: feedback next to the action).
 *
 * Render it with `open`; the parent owns the field state and resets it on open.
 */
import { useId, useState, type ReactNode } from 'react';
import { Modal } from '../Modal.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import './EditDialog.css';

export interface EditDialogProps {
  title: string;
  description?: ReactNode;
  open: boolean;
  isDirty: boolean;
  isSaving: boolean;
  /** Default: isDirty. */
  canSave?: boolean;
  submitLabel: string;
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
  width?: 'sm' | 'md';
}

export function EditDialog({ title, description, open, isDirty, isSaving, canSave: canSaveProp, submitLabel, error, onSubmit, onClose, children, width = 'sm' }: EditDialogProps): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const canSave = canSaveProp ?? isDirty;

  if (!open) return null;

  const requestClose = (): void => {
    // Both Modals see Esc (each listens on document); while the discard
    // question is up, the question owns it.
    if (confirmingDiscard || isSaving) return;
    if (isDirty) setConfirmingDiscard(true);
    else onClose();
  };

  return (
    <>
      <Modal onClose={requestClose} labelledBy={titleId} backdropClassName="kp-edit-dialog-backdrop" className="kp-edit-dialog">
        <form
          className="kp-edit-dialog__form"
          data-width={width}
          aria-describedby={description ? descriptionId : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !isSaving) onSubmit();
          }}
        >
          <div className="kp-edit-dialog__head">
            <h2 id={titleId} className="kp-edit-dialog__title">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="kp-edit-dialog__description">
                {description}
              </div>
            ) : null}
          </div>
          <div className="kp-edit-dialog__body">{children}</div>
          {error ? (
            <p className="kp-edit-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="kp-edit-dialog__actions">
            <button type="button" className="kp-edit-dialog__button" onClick={requestClose} disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="kp-edit-dialog__button kp-edit-dialog__button--primary" disabled={!canSave || isSaving}>
              {isSaving ? 'Saving…' : submitLabel}
            </button>
          </div>
        </form>
      </Modal>
      {confirmingDiscard ? (
        <ConfirmDialog
          title="Discard changes?"
          body="Your changes in this form have not been saved."
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
