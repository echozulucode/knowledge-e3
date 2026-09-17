/**
 * The confirm flows for account changes, shared by the Users table's row menu
 * and the user sheet so both ask the same questions with the same consequences.
 *
 * Rule (the admin UX review §3.3): nothing privileged or
 * destructive commits from a table row or a dropdown change. Role changes,
 * disable and reset go through a ConfirmDialog; Enable is the reversible
 * direction and commits straight away. The page renders `dialogs` once, AFTER
 * any open sheet, so a confirm opened from the sheet stacks above it.
 */
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '../../components/admin/ConfirmDialog.js';
import { pushToast } from '../../hooks/useToast.js';
import { useResetUserPassword, useUpdateUser, type AdminUser } from '../../queries.js';
import { OneTimePasswordDialog } from './OneTimePasswordDialog.js';
import { errorText } from './usersModel.js';

/** The action waiting on a confirmation. */
export type PendingAccountAction =
  | { kind: 'role'; user: AdminUser; role: 'user' | 'admin' }
  | { kind: 'disable'; user: AdminUser }
  | { kind: 'reset'; user: AdminUser };

export interface AccountActions {
  ask: (action: PendingAccountAction) => void;
  enable: (user: AdminUser) => void;
  /** The account an action is running on. Per account, not one shared flag:
   * acting on bob must not grey out every other row while it runs. */
  busyUserId: string | null;
  dialogs: ReactNode;
}

export function useAccountActions(): AccountActions {
  const queryClient = useQueryClient();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();
  const [pending, setPending] = useState<PendingAccountAction | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);

  const ask = (action: PendingAccountAction) => {
    setPendingError(null);
    setPending(action);
  };
  const cancel = () => {
    setPending(null);
    setPendingError(null);
  };

  /** Wait for the refreshed list and sheet before closing, so a confirmed change
   * does not show the old value for a frame. */
  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });

  const onConfirm = async () => {
    if (!pending) return;
    const { user } = pending;
    setPendingError(null);
    setBusyUserId(user.id);
    try {
      if (pending.kind === 'reset') {
        const password = await resetPassword.mutateAsync(user.id);
        setPending(null);
        setTempPassword({ username: user.username, password });
      } else if (pending.kind === 'role') {
        await updateUser.mutateAsync({ id: user.id, role: pending.role });
        await refreshUsers();
        setPending(null);
        pushToast({ kind: 'success', message: `${user.username} is now ${pending.role === 'admin' ? 'an admin' : 'a user'}.` });
      } else {
        await updateUser.mutateAsync({ id: user.id, disabled: true });
        await refreshUsers();
        setPending(null);
        pushToast({ kind: 'success', message: `${user.username} disabled.` });
      }
    } catch (err) {
      // Server guardrails ("Cannot remove the last admin.") land in the dialog,
      // next to the action that was refused.
      const fallback =
        pending.kind === 'reset' ? 'Could not reset password.' : pending.kind === 'role' ? 'Could not change role.' : 'Could not update account.';
      setPendingError(errorText(err as { message?: unknown }, fallback));
    } finally {
      setBusyUserId(null);
    }
  };

  const enable = (user: AdminUser) => {
    setBusyUserId(user.id);
    updateUser.mutate(
      { id: user.id, disabled: false },
      {
        onSuccess: () => pushToast({ kind: 'success', message: `${user.username} re-enabled.` }),
        onError: (err) => pushToast({ kind: 'error', message: errorText(err as { message?: unknown }, 'Could not update account.') }),
        onSettled: () => setBusyUserId(null),
      },
    );
  };

  const renderConfirm = (): ReactNode => {
    if (!pending) return null;
    const name = pending.user.username;
    const shared = {
      pending: busyUserId === pending.user.id,
      error: pendingError,
      onConfirm: () => void onConfirm(),
      onCancel: cancel,
    };
    if (pending.kind === 'role' && pending.role === 'admin') {
      return (
        <ConfirmDialog
          {...shared}
          title={`Make ${name} an admin?`}
          body={`${name} will be able to change everything on this instance.`}
          consequences={[
            'Can create, disable and reset other users, and change their roles.',
            'Can change authentication settings, including who can read content.',
            'Can add, edit and remove sources.',
            'Can read the full audit log.',
          ]}
          confirmLabel="Make admin"
        />
      );
    }
    if (pending.kind === 'role') {
      return (
        <ConfirmDialog
          {...shared}
          title={`Remove ${name}'s admin role?`}
          body={`${name} keeps their account and content, but loses access to the admin pages.`}
          confirmLabel="Make user"
        />
      );
    }
    if (pending.kind === 'disable') {
      // Accurate to the server: disabling soft-deletes the account (login
      // refuses it), deletes its sessions, and ApiTokensService.authenticate
      // refuses tokens of a deleted owner - without revoking them.
      return (
        <ConfirmDialog
          {...shared}
          title={`Disable ${name}?`}
          body={`${name} loses access until an admin re-enables the account.`}
          consequences={[
            `Blocks ${name} from signing in.`,
            `Ends all of ${name}'s current sessions.`,
            `Stops ${name}'s API tokens from working. They are not revoked, and work again if the account is re-enabled.`,
          ]}
          confirmLabel="Disable account"
          tone="danger"
        />
      );
    }
    return (
      <ConfirmDialog
        {...shared}
        title={`Reset ${name}'s password?`}
        body="A new temporary password is generated and shown to you once."
        consequences={[
          `Signs ${name} out of every session.`,
          `${name}'s current password stops working.`,
          `${name}'s API tokens are not affected.`,
        ]}
        confirmLabel="Reset password"
        tone="danger"
      />
    );
  };

  const dialogs = (
    <>
      {renderConfirm()}
      {tempPassword ? (
        <OneTimePasswordDialog
          title={`Temporary password for ${tempPassword.username}`}
          body={`Share it securely; it will not be shown again. ${tempPassword.username} was signed out everywhere and should change it after signing in.`}
          password={tempPassword.password}
          onDone={() => setTempPassword(null)}
        />
      ) : null}
    </>
  );

  return { ask, enable, busyUserId, dialogs };
}
