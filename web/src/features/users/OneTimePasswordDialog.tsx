/**
 * The one-time reveal of a password an admin must hand over: the temporary
 * password from Reset password, or the generated password of a new account.
 *
 * It lives only in the caller's component state - never in the URL, storage, a
 * toast or a log - and is gone on Done. The backdrop does not close it, so a
 * stray click cannot lose the only copy.
 */
import { useId } from 'react';
import { Icon, appIcons } from '../../icons.js';
import { Modal } from '../../components/Modal.js';
import { pushToast } from '../../hooks/useToast.js';

export interface OneTimePasswordDialogProps {
  /** Dialog title, also the accessible name of the password itself. */
  title: string;
  body: string;
  password: string;
  onDone: () => void;
}

export function OneTimePasswordDialog({ title, body, password, onDone }: OneTimePasswordDialogProps): JSX.Element {
  const titleId = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      pushToast({ kind: 'success', message: 'Password copied.' });
    } catch {
      pushToast({ kind: 'error', message: 'Copy failed — select and copy manually.' });
    }
  };
  return (
    <Modal
      onClose={onDone}
      labelledBy={titleId}
      backdropClassName="kp-confirm-backdrop"
      className="kp-confirm AdminUsers__secretDialog"
      closeOnBackdrop={false}
    >
      <h2 id={titleId} className="kp-confirm__title">
        {title}
      </h2>
      <p className="kp-confirm__body">{body}</p>
      <code className="AdminUsers__tempPassword" aria-label={title}>
        {password}
      </code>
      <div className="kp-confirm__actions">
        <button type="button" className="AdminUsers__btn" onClick={copy}>
          <Icon icon={appIcons.copy} /> Copy
        </button>
        <button type="button" className="AdminUsers__btn AdminUsers__btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </Modal>
  );
}
