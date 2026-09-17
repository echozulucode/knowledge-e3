/**
 * The user sheet (`/admin/users?user=<id>`, the admin UX review §4.3):
 * one account's role, recent activity, security and danger zone.
 *
 * Save commits ONLY the role, and only after the same confirmation the old
 * inline select asked for. Reset password, Disable and Enable are actions, not
 * edits: each runs its own confirm flow (useAccountActions) straight from its
 * section and never waits for Save.
 *
 * The lockout guardrails the server enforces (no changing your own role or
 * disabling yourself; the only active admin cannot be demoted or disabled) are
 * stated as text before the admin tries (§3.3: disabled controls explain why).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FormSection } from '../../components/admin/FormSection.js';
import { Sheet } from '../../components/admin/Sheet.js';
import { StatusChip } from '../../components/admin/StatusChip.js';
import type { AdminUser } from '../../queries.js';
import { useAdminTokensPage } from '../tokens/queries.js';
import { useUserRecentActivity } from './queries.js';
import type { AccountActions } from './useAccountActions.js';
import { absoluteTime, accountRules, relativeTime, shortDate } from './usersModel.js';

const ROLE_OPTIONS: { value: 'user' | 'admin'; label: string; explanation: string }[] = [
  { value: 'user', label: 'User', explanation: 'Reads and writes content. No access to the admin pages.' },
  { value: 'admin', label: 'Admin', explanation: 'Also manages users, authentication, sources and the audit log.' },
];

export interface UserSheetProps {
  user: AdminUser;
  meId: string | undefined;
  /** Active admins on the instance; undefined while loading. */
  activeAdmins: number | undefined;
  actions: AccountActions;
  onClose: () => void;
}

export function UserSheet({ user, meId, activeAdmins, actions, onClose }: UserSheetProps): JSX.Element {
  // The unsaved role choice. The shown role is the saved one until the admin
  // picks another; once the server has the picked role, nothing is dirty again.
  const [roleDraft, setRoleDraft] = useState<'user' | 'admin' | null>(null);
  const role = roleDraft ?? user.role;
  const isDirty = roleDraft !== null && roleDraft !== user.role;
  const rules = accountRules(user, meId, activeAdmins);
  const busy = actions.busyUserId === user.id;
  const roleGroupId = `user-sheet-role-${user.id}`;

  return (
    <Sheet
      title={user.username}
      headerActions={<StatusChip tone={user.status === 'active' ? 'ok' : 'info'} label={user.status === 'active' ? 'Active' : 'Disabled'} />}
      subtitle={
        <span className="UserSheet__subtitle">
          <span>{user.email}</span>
          <span aria-hidden="true"> · </span>
          <span>Created {shortDate(user.created_at)}</span>
          <span aria-hidden="true"> · </span>
          <span title={absoluteTime(user.last_seen_at)}>
            {user.last_seen_at ? `Last seen ${relativeTime(user.last_seen_at)}` : 'Never signed in'}
          </span>
        </span>
      }
      onClose={onClose}
      form={{
        isDirty,
        isSaving: busy && isDirty,
        canSave: isDirty && rules.roleLockedReason === null,
        submitLabel: 'Save',
        onSubmit: () => {
          if (roleDraft && roleDraft !== user.role) actions.ask({ kind: 'role', user, role: roleDraft });
        },
      }}
    >
      <div className="UserSheet">
        <FormSection title="Role">
          <fieldset className="UserSheet__roles" aria-describedby={rules.roleLockedReason ? `${roleGroupId}-locked` : undefined}>
            <legend className="UserSheet__vh">Role for {user.username}</legend>
            {ROLE_OPTIONS.map((option) => (
              <label key={option.value} className="UserSheet__role" data-checked={role === option.value ? 'true' : undefined}>
                <input
                  type="radio"
                  name={roleGroupId}
                  value={option.value}
                  checked={role === option.value}
                  disabled={rules.roleLockedReason !== null || busy}
                  onChange={() => setRoleDraft(option.value)}
                />
                <span className="UserSheet__roleText">
                  <span className="UserSheet__roleLabel">{option.label}</span>
                  <span className="UserSheet__muted">{option.explanation}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {rules.roleLockedReason ? (
            <p id={`${roleGroupId}-locked`} className="UserSheet__rule">
              {rules.roleLockedReason}
            </p>
          ) : (
            <p className="UserSheet__muted">Making someone an admin asks you to confirm when you save.</p>
          )}
        </FormSection>

        <RecentActivity username={user.username} />

        <FormSection title="Security">
          <div className="UserSheet__row">
            <button type="button" className="AdminUsers__btn" disabled={busy} onClick={() => actions.ask({ kind: 'reset', user })}>
              Reset password…
            </button>
            <span className="UserSheet__muted">Signs {user.username} out everywhere and shows a temporary password once.</span>
          </div>
          <TokenSummary userId={user.id} username={user.username} />
        </FormSection>

        <FormSection title="Danger zone" tone="danger">
          {user.status === 'active' ? (
            <div className="UserSheet__row">
              <button
                type="button"
                className="AdminUsers__btn AdminUsers__btn--danger"
                disabled={busy || rules.disableLockedReason !== null}
                aria-describedby={rules.disableLockedReason ? `${roleGroupId}-disable-locked` : undefined}
                onClick={() => actions.ask({ kind: 'disable', user })}
              >
                Disable account…
              </button>
              {rules.disableLockedReason ? (
                <span id={`${roleGroupId}-disable-locked`} className="UserSheet__rule">
                  {rules.disableLockedReason}
                </span>
              ) : (
                <span className="UserSheet__muted">Blocks sign-in and stops API tokens until re-enabled.</span>
              )}
            </div>
          ) : (
            <div className="UserSheet__row">
              <button type="button" className="AdminUsers__btn" disabled={busy} onClick={() => actions.enable(user)}>
                Enable account
              </button>
              <span className="UserSheet__muted">Restores sign-in and any unrevoked API tokens.</span>
            </div>
          )}
        </FormSection>
      </div>
    </Sheet>
  );
}

function RecentActivity({ username }: { username: string }): JSX.Element {
  const { data, isLoading, isError } = useUserRecentActivity(username);
  const entries = data?.entries ?? [];
  return (
    <FormSection
      title="Recent activity"
      aside={
        // Two questions, two links: what this person DID (actor), and what was
        // done TO this account - role changes, resets, failed sign-ins as them (subject).
        <span className="UserSheet__links">
          <Link to="/admin/audit" search={{ actor: username } as never} className="UserSheet__link">
            View all in audit log →
          </Link>
          <Link to="/admin/audit" search={{ subject: username } as never} className="UserSheet__link">
            Changes to this account →
          </Link>
        </span>
      }
    >
      {isLoading ? (
        <p className="UserSheet__muted">Loading activity…</p>
      ) : isError ? (
        <p className="UserSheet__muted">Activity could not be loaded.</p>
      ) : entries.length === 0 ? (
        <p className="UserSheet__muted">No recorded activity yet.</p>
      ) : (
        <ul className="UserSheet__activity" aria-label={`Recent activity by ${username}`}>
          {entries.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.occurred_at} title={absoluteTime(entry.occurred_at)} className="UserSheet__muted">
                {relativeTime(entry.occurred_at)}
              </time>
              <code className="UserSheet__action">{entry.action}</code>
              {entry.page_slug ? (
                <Link to="/p/$slug" params={{ slug: entry.page_slug }} className="UserSheet__link">
                  {entry.page_title ?? entry.page_slug}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}

/** "API tokens: 2 active · Manage →". Counted by the server (`state=active`, `total` only); the line is omitted if that count is unavailable. */
function TokenSummary({ userId, username }: { userId: string; username: string }): JSX.Element | null {
  const { data, isError } = useAdminTokensPage({ owner: userId, state: 'active', limit: 1 });
  if (isError || !data) return null;
  return (
    <div className="UserSheet__row">
      <span>
        API tokens: {data.total} active
      </span>
      <span aria-hidden="true">·</span>
      <Link to="/admin/auth/tokens" search={{ owner: username } as never} className="UserSheet__link">
        Manage →
      </Link>
    </div>
  );
}
