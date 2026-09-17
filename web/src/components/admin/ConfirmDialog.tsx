/**
 * ConfirmDialog — the one confirmation surface for admin actions
 * (the admin UX review §3.3).
 *
 * The rule it enforces: nothing privileged or destructive commits from a table
 * row or a dropdown change. Confirmation is proportional to impact:
 *   - a plain confirm for reversible but consequential actions (disable, reset,
 *     revoke, archive, promote to admin) - pass `consequences` so the reader
 *     sees what will happen, not just "Are you sure?";
 *   - typed confirmation (`requireText`) for high-impact actions (making the
 *     library public, removing a source) - the confirm button stays disabled
 *     until the exact text is typed.
 *
 * Built on the accessible `Modal` (focus trap, Esc, focus restore). While
 * `pending`, the dialog cannot be dismissed and the confirm button says so; an
 * `error` renders inside the dialog, next to the action that failed, so a
 * refusal is never announced somewhere else on the page.
 */
import { useId, useState, type ReactNode } from 'react';
import { Modal } from '../Modal.js';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  title: string;
  /** One or two sentences: what this does. */
  body: ReactNode;
  /** Plain-language effects, one per line ("Ends all of bob's sessions."). */
  consequences?: string[];
  confirmLabel: string;
  /** `danger` for destructive or exposure-widening actions. */
  tone?: 'default' | 'danger';
  /** Exact text the admin must type before confirming (high-impact actions only). */
  requireText?: string;
  pending?: boolean;
  /** Shown inside the dialog when the confirmed action failed. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  consequences,
  confirmLabel,
  tone = 'default',
  requireText,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const titleId = useId();
  const typedId = useId();
  const [typed, setTyped] = useState('');
  const typedOk = !requireText || typed.trim() === requireText;

  return (
    <Modal
      onClose={() => {
        if (!pending) onCancel();
      }}
      labelledBy={titleId}
      backdropClassName="kp-confirm-backdrop"
      className="kp-confirm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typedOk && !pending) onConfirm();
        }}
      >
        <h2 id={titleId} className="kp-confirm__title">
          {title}
        </h2>
        <div className="kp-confirm__body">{body}</div>
        {consequences && consequences.length > 0 ? (
          <ul className="kp-confirm__consequences">
            {consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        {requireText ? (
          <div className="kp-confirm__typed">
            <label htmlFor={typedId}>
              Type <code>{requireText}</code> to confirm
            </label>
            <input
              id={typedId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
          </div>
        ) : null}
        {error ? (
          <p className="kp-confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="kp-confirm__actions">
          <button type="button" className="kp-confirm__cancel" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="kp-confirm__confirm" data-tone={tone} disabled={!typedOk || pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
