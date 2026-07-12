import { FormEvent, useState } from 'react';
import { Icon, appIcons } from '../icons.js';
import { useMe, useChangePassword } from '../queries.js';
import { useTheme, type ThemeMode } from '../styles/theme.js';
import { pushToast } from '../hooks/useToast.js';
import './Profile.css';

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof appIcons.sun }[] = [
  { value: 'system', label: 'System', icon: appIcons.desktop },
  { value: 'light', label: 'Light', icon: appIcons.sun },
  { value: 'dark', label: 'Dark', icon: appIcons.moon },
];

export function Profile() {
  const { data: user } = useMe();
  const { mode, setMode } = useTheme();
  const changePassword = useChangePassword();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmitPassword = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (newPassword.length < 8) {
      setFormError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError('New password and confirmation do not match.');
      return;
    }
    changePassword.mutate(
      { old_password: oldPassword, new_password: newPassword },
      {
        onSuccess: () => {
          setOldPassword('');
          setNewPassword('');
          setConfirmPassword('');
          pushToast({ kind: 'success', message: 'Password changed.' });
        },
        onError: (err) => {
          const message = (err as { message?: string })?.message ?? 'Could not change password.';
          setFormError(message);
        },
      },
    );
  };

  return (
    <main className="Profile" aria-labelledby="profile-title">
      <div className="Profile__inner">
        <section className="Profile__hero">
          <div className="Profile__eyebrow">
            <Icon icon={appIcons.user} />
            <span>Profile</span>
          </div>
          <h1 id="profile-title">Your profile</h1>
          <p>Account details and personal preferences. System-wide settings live in the admin console.</p>
        </section>

        <div className="Profile__grid">
          <section className="Profile__panel" aria-labelledby="profile-account-title">
            <h2 id="profile-account-title">Account</h2>
            <dl className="Profile__fields">
              <div>
                <dt>Username</dt>
                <dd>{user?.username ?? '—'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{user?.email ?? '—'}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>
                  <span className={`Profile__roleChip Profile__roleChip--${user?.role ?? 'user'}`}>{user?.role ?? 'user'}</span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="Profile__panel" aria-labelledby="profile-password-title">
            <h2 id="profile-password-title">Change password</h2>
            <form className="Profile__form" onSubmit={onSubmitPassword}>
              <label htmlFor="profile-old-password">Current password</label>
              <input
                id="profile-old-password"
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
              />
              <label htmlFor="profile-new-password">New password</label>
              <input
                id="profile-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
              <label htmlFor="profile-confirm-password">Confirm new password</label>
              <input
                id="profile-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              {formError ? (
                <div className="Profile__formError" role="alert">
                  {formError}
                </div>
              ) : null}
              <button
                type="submit"
                className="Profile__submit"
                disabled={changePassword.isPending || !oldPassword || !newPassword}
              >
                {changePassword.isPending ? 'Saving…' : 'Update password'}
              </button>
            </form>
          </section>

          <section className="Profile__panel" aria-labelledby="profile-prefs-title">
            <h2 id="profile-prefs-title">Preferences</h2>
            <div className="Profile__prefRow">
              <div className="Profile__prefLabel">
                <strong>Theme</strong>
                <span>Choose how the interface looks on this device.</span>
              </div>
              <div className="Profile__themeToggle" role="radiogroup" aria-label="Theme">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === opt.value}
                    className={`Profile__themeOption${mode === opt.value ? ' Profile__themeOption--active' : ''}`}
                    onClick={() => setMode(opt.value)}
                  >
                    <Icon icon={opt.icon} />
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="Profile__panel" aria-labelledby="profile-sessions-title">
            <h2 id="profile-sessions-title">Sessions</h2>
            <p className="Profile__muted">
              Active-session management (view devices, sign out everywhere) is coming in a later wave. For now, use{' '}
              <strong>Sign out</strong> from the top-right menu to end this session.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
