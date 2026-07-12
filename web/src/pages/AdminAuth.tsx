import { FormEvent, useEffect, useState } from 'react';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { pushToast } from '../hooks/useToast.js';
import {
  usePasswordPolicy,
  useUpdatePasswordPolicy,
  useAccess,
  useSetAccess,
  type PasswordPolicy,
  type ReadAccessMode,
} from '../queries.js';
import './AdminHome.css';
import './AdminAuth.css';

const ACCESS_OPTIONS: { value: ReadAccessMode; label: string; hint: string }[] = [
  { value: 'public', label: 'Public', hint: 'Anyone can view published content without signing in.' },
  { value: 'authenticated', label: 'Login required', hint: 'Visitors must sign in to view any content.' },
];

const SSO_METHODS = [
  {
    title: 'Single sign-on — OIDC & SAML',
    body: 'Configure an identity provider (Entra ID, Okta, Google, or any OIDC/SAML IdP). Users are provisioned just-in-time on first sign-in and matched to existing accounts by email. Secrets are referenced from environment / secret-manager keys, never stored in the database.',
  },
  {
    title: 'LDAP / Active Directory',
    body: 'Authenticate against a directory with group→role mapping and just-in-time provisioning. Coming in a later wave.',
  },
];

const TOGGLES: { key: keyof PasswordPolicy; label: string }[] = [
  { key: 'require_uppercase', label: 'Require an uppercase letter' },
  { key: 'require_number', label: 'Require a number' },
  { key: 'require_symbol', label: 'Require a symbol' },
];

export function AdminAuth() {
  const { data: policy, isLoading } = usePasswordPolicy();
  const updatePolicy = useUpdatePasswordPolicy();
  const { data: accessMode } = useAccess();
  const setAccess = useSetAccess();
  const [draft, setDraft] = useState<PasswordPolicy | null>(null);

  const onSetAccess = (mode: ReadAccessMode) => {
    if (mode === accessMode) return;
    setAccess.mutate(mode, {
      onSuccess: () =>
        pushToast({
          kind: 'success',
          message: mode === 'public' ? 'Content is now public.' : 'Login is now required to view content.',
        }),
      onError: (err) =>
        pushToast({ kind: 'error', message: (err as { message?: string })?.message ?? 'Could not change access.' }),
    });
  };

  useEffect(() => {
    if (policy && !draft) setDraft(policy);
  }, [policy, draft]);

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    updatePolicy.mutate(draft, {
      onSuccess: () => pushToast({ kind: 'success', message: 'Password policy saved.' }),
      onError: (err) =>
        pushToast({ kind: 'error', message: (err as { message?: string })?.message ?? 'Could not save policy.' }),
    });
  };

  return (
    <main className="AdminHome" aria-labelledby="admin-auth-title">
      <AdminTabs />
      <section className="AdminHome__hero">
        <div className="AdminHome__eyebrow">
          <Icon icon={appIcons.shieldHalved} />
          <span>Authentication</span>
        </div>
        <h1 id="admin-auth-title">Authentication</h1>
        <p>Choose how people sign in and who can read content. Local password rules are editable below; SSO and LDAP arrive in later waves.</p>
      </section>

      <section className="AdminHome__panel" aria-labelledby="auth-access-title">
        <h2 id="auth-access-title">Content visibility</h2>
        <div className="AdminAuth__access" role="radiogroup" aria-label="Who can read content">
          {ACCESS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={accessMode === opt.value}
              className={`AdminAuth__accessOption${accessMode === opt.value ? ' AdminAuth__accessOption--active' : ''}`}
              onClick={() => onSetAccess(opt.value)}
              disabled={setAccess.isPending}
            >
              <strong>{opt.label}</strong>
              <span>{opt.hint}</span>
            </button>
          ))}
        </div>
        <p className="AdminAuth__muted">Adding and editing always require a login, regardless of this setting. Drafts stay private to their author and admins.</p>
      </section>

      <section className="AdminHome__panel" aria-labelledby="auth-local-title">
        <h2 id="auth-local-title">Local password policy</h2>
        {isLoading || !draft ? (
          <p className="AdminAuth__muted">Loading policy…</p>
        ) : (
          <form className="AdminAuth__policyForm" onSubmit={onSave}>
            <label className="AdminAuth__field">
              <span>Minimum length</span>
              <input
                type="number"
                min={1}
                max={128}
                value={draft.min_length}
                onChange={(e) => setDraft({ ...draft, min_length: Number(e.target.value) || 1 })}
              />
            </label>
            <fieldset className="AdminAuth__toggles">
              {TOGGLES.map((t) => (
                <label key={t.key} className="AdminAuth__toggle">
                  <input
                    type="checkbox"
                    checked={draft[t.key] as boolean}
                    onChange={(e) => setDraft({ ...draft, [t.key]: e.target.checked })}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </fieldset>
            <p className="AdminAuth__muted">Applies to new accounts, admin password resets, and self-service changes.</p>
            <button type="submit" className="AdminAuth__save" disabled={updatePolicy.isPending}>
              {updatePolicy.isPending ? 'Saving…' : 'Save policy'}
            </button>
          </form>
        )}
      </section>

      <section className="AdminHome__panel" aria-label="Other sign-in methods">
        <h2>Other sign-in methods</h2>
        <dl className="AdminHome__defs">
          {SSO_METHODS.map((m) => (
            <div key={m.title}>
              <dt>{m.title}</dt>
              <dd>{m.body}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
