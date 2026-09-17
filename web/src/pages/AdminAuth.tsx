/**
 * AdminAuth — `/admin/auth` (the admin UX review §4.7): the
 * instance's authentication settings, one section per setting group.
 *
 * Each section is two columns — what the setting does and where its value came
 * from | the controls — stacking when the container is narrow. The page used to
 * have three save models (visibility committed on click, the policy had a Save
 * button, token lifetime committed on select change); now every editable
 * section has ONE: edit, then its own Discard / Save, enabled only while the
 * section differs from what is saved. For content visibility the Save IS the
 * confirmation ("Change to Public…"), because that switch is the one on this
 * page that can expose the whole library.
 *
 * Provenance ("Set in admin by eric · Sep 2, 2026", "From environment (…)",
 * "Default") comes from `GET /admin/auth/settings`, so a value a deploy file
 * chose is never presented as an admin's decision. Login throttling has no
 * admin layer and is shown read-only with where to change it.
 *
 * The token list moved to its own page (`/admin/auth/tokens`); only the
 * lifetime policy stays here.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { FormField } from '../components/admin/FormField.js';
import { useUnsavedChangesGuard } from '../components/admin/useUnsavedChangesGuard.js';
import { pushToast } from '../hooks/useToast.js';
import { useSetTokenPolicy } from '../features/tokens/queries.js';
import {
  AUTH_SETTINGS_KEY,
  useAuthSettings,
  useSetAccess,
  useUpdatePasswordPolicy,
  type AuthSettings,
  type ReadAccessMode,
  type SettingProvenance,
} from '../queries.js';
import {
  READ_MODE_LABELS,
  attemptLimitText,
  draftToPolicy,
  durationText,
  isPolicyDirty,
  lifetimeOptions,
  lifetimeToValue,
  minLengthError,
  policyToDraft,
  provenanceText,
  readAccessOverrideNote,
  valueToLifetime,
  type PolicyDraft,
} from './adminAuthModel.js';
import './AdminHome.css';
import './AdminAuth.css';

const ACCESS_OPTIONS: { value: ReadAccessMode; hint: string }[] = [
  { value: 'public', hint: 'Anyone can view published content without signing in.' },
  { value: 'authenticated', hint: 'Visitors must sign in to view any content.' },
];

/**
 * What this instance actually accepts as a credential (plan D8).
 *
 * This panel used to describe OIDC, SAML and LDAP as though they were
 * configurable here. None of the three exists anywhere in the codebase, so an
 * admin reading it was being told something false about their own deployment.
 * It now says what is here — and deliberately promises nothing in the space
 * that claim vacated.
 */
const SIGN_IN_METHODS = [
  {
    title: 'Username and password',
    body: 'The only way a person signs in. Accounts are created in Users; the password policy above applies to new accounts, admin resets, and self-service changes.',
  },
  {
    title: 'Personal access tokens',
    body: 'The only way a program signs in: an Authorization: Bearer header carrying a token its owner created in their Profile, acting with that owner’s role. Every token on this instance is listed in API tokens, with its scope, last use, and a Revoke.',
  },
  {
    title: 'No external identity provider',
    body: 'This instance does not integrate with an identity provider or a directory: there is no OIDC, SAML, or LDAP support in the product.',
  },
];

const TOGGLES: { key: 'require_uppercase' | 'require_number' | 'require_symbol'; label: string }[] = [
  { key: 'require_uppercase', label: 'Require an uppercase letter' },
  { key: 'require_number', label: 'Require a number' },
  { key: 'require_symbol', label: 'Require a symbol' },
];

function errMessage(err: unknown, fallback: string): string {
  const message = (err as { message?: unknown })?.message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join('. ') || fallback;
  return typeof message === 'string' && message ? message : fallback;
}

export function AdminAuth() {
  const settings = useAuthSettings();
  const data = settings.data;

  // Which sections hold unsaved edits, so leaving the page asks first.
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const markDirty = useCallback(
    (section: string, value: boolean) => setDirty((prev) => (prev[section] === value ? prev : { ...prev, [section]: value })),
    [],
  );
  // Stable per-section reporters, so a section's report effect runs only when its flag changes.
  const report = useMemo(
    () => ({
      visibility: (v: boolean) => markDirty('visibility', v),
      policy: (v: boolean) => markDirty('policy', v),
      tokens: (v: boolean) => markDirty('tokens', v),
    }),
    [markDirty],
  );
  useUnsavedChangesGuard(Object.values(dirty).some(Boolean));

  return (
    <main className="AdminHome AdminAuth" aria-labelledby="admin-auth-title">
      <AdminPageHeader
        titleId="admin-auth-title"
        title="Authentication"
        description="Who can read content, the rules for local passwords and tokens, and how people and programs sign in."
        secondaryActions={
          <>
            <Link to="/admin/audit" className="kp-admin-button">
              View auth activity in Audit
            </Link>
            <Link to="/admin/auth/tokens" className="kp-admin-button">
              API tokens →
            </Link>
          </>
        }
      />

      {settings.isError ? (
        <div className="AdminAuth__loadError" role="alert">
          <p>Couldn’t load the authentication settings.</p>
          <button type="button" className="kp-admin-button" onClick={() => void settings.refetch()}>
            Retry
          </button>
        </div>
      ) : !data ? (
        <p className="AdminAuth__muted" aria-busy="true">
          Loading settings…
        </p>
      ) : (
        <div className="AdminAuth__sections">
          <VisibilitySection read={data.read_access} onDirtyChange={report.visibility} />
          <PasswordPolicySection section={data.password_policy} onDirtyChange={report.policy} />
          <TokenPolicySection section={data.token_policy} onDirtyChange={report.tokens} />
          <ThrottleSection throttle={data.login_throttle} />
        </div>
      )}

      <section className="AdminHome__panel AdminAuth__methods" aria-labelledby="auth-methods-title">
        <h2 id="auth-methods-title">Sign-in methods</h2>
        <dl className="AdminHome__defs">
          {SIGN_IN_METHODS.map((m) => (
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

// ---------------------------------------------------------------- section shell

interface SettingSectionProps {
  id: string;
  title: string;
  description: ReactNode;
  provenance: SettingProvenance;
  /** A second muted line under the provenance (e.g. what an admin choice overrides). */
  provenanceNote?: string | null;
  /** Exact audit action for "View changes in Audit"; omitted for settings no admin writes. */
  auditAction?: string;
  children: ReactNode;
  /** Discard / Save row; absent for read-only sections. */
  footer?: ReactNode;
}

function SettingSection({ id, title, description, provenance, provenanceNote, auditAction, children, footer }: SettingSectionProps) {
  const titleId = `${id}-title`;
  return (
    <section className="AdminAuth__section" aria-labelledby={titleId} data-testid={`auth-section-${id}`}>
      <div className="AdminAuth__explain">
        <h2 id={titleId}>{title}</h2>
        <div className="AdminAuth__description">{description}</div>
        <p className="AdminAuth__provenance" data-source={provenance.source}>
          {provenanceText(provenance)}
        </p>
        {provenanceNote ? <p className="AdminAuth__muted">{provenanceNote}</p> : null}
        {auditAction ? (
          <Link to="/admin/audit" search={{ action: auditAction } as never} className="AdminAuth__link">
            View changes in Audit
          </Link>
        ) : null}
      </div>
      <div className="AdminAuth__controls">
        {children}
        {footer}
      </div>
    </section>
  );
}

function SectionFooter({
  dirty,
  pending,
  error,
  saveLabel = 'Save',
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  error: string | null;
  saveLabel?: string;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="AdminAuth__footer">
      {error ? (
        <p className="AdminAuth__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="AdminAuth__footerActions">
        <button type="button" className="kp-admin-button" onClick={onDiscard} disabled={!dirty || pending}>
          Discard
        </button>
        <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={onSave} disabled={!dirty || pending}>
          {pending ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Put a saved value into the settings cache straight away, so the section shows
 * it the moment its draft is cleared instead of flashing the old value until the
 * refetch (which then brings the new provenance line) lands.
 */
function usePatchSettings() {
  const queryClient = useQueryClient();
  return (patch: (current: AuthSettings) => AuthSettings) =>
    queryClient.setQueryData<AuthSettings>(AUTH_SETTINGS_KEY, (current) => (current ? patch(current) : current));
}

// ---------------------------------------------------------------- content visibility

function VisibilitySection({ read, onDirtyChange }: { read: AuthSettings['read_access']; onDirtyChange: (dirty: boolean) => void }) {
  const setAccess = useSetAccess();
  const patch = usePatchSettings();
  // null = no edit; the radios show the saved mode.
  const [draft, setDraft] = useState<ReadAccessMode | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = read.read_mode;
  const shown = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  useDirtyReport(dirty, onDirtyChange);

  const discard = () => {
    setDraft(null);
    setError(null);
  };

  const confirm = () => {
    if (!dirty || !draft) return;
    const mode = draft;
    setError(null);
    setAccess.mutate(mode, {
      onSuccess: () => {
        patch((s) => ({ ...s, read_access: { ...s.read_access, read_mode: mode } }));
        setConfirming(false);
        setDraft(null);
        pushToast({
          kind: 'success',
          message: mode === 'public' ? 'Content is now public.' : 'Login is now required to view content.',
        });
      },
      onError: (err) => setError(errMessage(err, 'Could not change access.')),
    });
  };

  return (
    <SettingSection
      id="auth-visibility"
      title="Content visibility"
      description={
        <p>
          Whether visitors must sign in to read. Adding and editing always require signing in, and drafts stay private to
          their author and admins.
        </p>
      }
      provenance={read.provenance}
      provenanceNote={readAccessOverrideNote(read)}
      auditAction="config.read_access_change"
      footer={
        <SectionFooter
          dirty={dirty}
          pending={setAccess.isPending && !confirming}
          error={confirming ? null : error}
          saveLabel={dirty && draft ? `Change to ${READ_MODE_LABELS[draft]}…` : 'Save'}
          onDiscard={discard}
          onSave={() => {
            setError(null);
            setConfirming(true);
          }}
        />
      }
    >
      <div className="AdminAuth__access" role="radiogroup" aria-label="Who can read content">
        {ACCESS_OPTIONS.map((opt) => (
          <label key={opt.value} className="AdminAuth__accessOption" data-checked={shown === opt.value ? 'true' : undefined}>
            <input
              type="radio"
              name="auth-read-mode"
              value={opt.value}
              checked={shown === opt.value}
              onChange={() => setDraft(opt.value === saved ? null : opt.value)}
              disabled={setAccess.isPending}
            />
            <span>
              <strong>{READ_MODE_LABELS[opt.value]}</strong>
              <span>{opt.hint}</span>
              {saved === opt.value ? <span className="AdminAuth__current">Current</span> : null}
            </span>
          </label>
        ))}
      </div>

      {confirming && draft === 'public' ? (
        // Typed confirmation: widening who can read is the highest-impact switch
        // on this page, and one mis-click must not publish the whole library.
        <ConfirmDialog
          title="Make content public?"
          body="Visitors will no longer need to sign in to read."
          consequences={[
            'Anyone on the internet can read every published item without signing in.',
            'Drafts and private topics stay hidden.',
            'Adding and editing still require signing in.',
          ]}
          confirmLabel="Make public"
          tone="danger"
          requireText="public"
          pending={setAccess.isPending}
          error={error}
          onConfirm={confirm}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : confirming && draft === 'authenticated' ? (
        <ConfirmDialog
          title="Require login to read?"
          body="Visitors who are not signed in will be asked to sign in before they can read any content."
          confirmLabel="Require login"
          pending={setAccess.isPending}
          error={error}
          onConfirm={confirm}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : null}
    </SettingSection>
  );
}

/**
 * Report a section's dirty flag up to the page's unsaved-changes guard. After
 * commit, not during render: setting the page's state mid-render is an error.
 */
function useDirtyReport(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
}

// ---------------------------------------------------------------- password policy

function PasswordPolicySection({
  section,
  onDirtyChange,
}: {
  section: AuthSettings['password_policy'];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const update = useUpdatePasswordPolicy();
  const patch = usePatchSettings();
  const saved = section.policy;
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [minError, setMinError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = draft ?? policyToDraft(saved);
  const dirty = draft !== null && isPolicyDirty(draft, saved);
  useDirtyReport(dirty, onDirtyChange);

  const edit = (next: Partial<PolicyDraft>) => {
    const merged = { ...shown, ...next };
    setDraft(merged);
    // An error already on screen clears as soon as the text is valid; a new one
    // waits for blur or Save, so typing "1" on the way to "12" is not scolded.
    if (minError && 'min_length' in next) setMinError(minLengthError(merged.min_length));
  };

  const discard = () => {
    setDraft(null);
    setMinError(null);
    setError(null);
  };

  const save = () => {
    if (!draft) return;
    const policy = draftToPolicy(draft);
    const fieldError = minLengthError(draft.min_length);
    setMinError(fieldError);
    if (!policy || fieldError) return;
    setError(null);
    update.mutate(policy, {
      onSuccess: (stored) => {
        patch((s) => ({ ...s, password_policy: { ...s.password_policy, policy: stored } }));
        setDraft(null);
        pushToast({ kind: 'success', message: 'Password policy saved.' });
      },
      onError: (err) => setError(errMessage(err, 'Could not save the password policy.')),
    });
  };

  return (
    <SettingSection
      id="auth-policy"
      title="Password policy"
      description={<p>Rules for local passwords. They apply to new accounts, admin password resets, and self-service changes.</p>}
      provenance={section.provenance}
      auditAction="config.password_policy"
      footer={<SectionFooter dirty={dirty} pending={update.isPending} error={error} onDiscard={discard} onSave={save} />}
    >
      <form
        className="AdminAuth__form"
        aria-label="Password policy"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
      >
        <FormField label="Minimum length" htmlFor="auth-min-length" labelHint="(1–128 characters)" error={minError}>
          {(control) => (
            <input
              {...control}
              className="AdminAuth__number"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={shown.min_length}
              onChange={(e) => edit({ min_length: e.target.value })}
              onBlur={() => {
                if (draft) setMinError(minLengthError(draft.min_length));
              }}
              disabled={update.isPending}
            />
          )}
        </FormField>
        <fieldset className="AdminAuth__toggles">
          <legend className="AdminAuth__legend">Character requirements</legend>
          {TOGGLES.map((t) => (
            <label key={t.key} className="AdminAuth__toggle">
              <input
                type="checkbox"
                checked={shown[t.key]}
                onChange={(e) => edit({ [t.key]: e.target.checked })}
                disabled={update.isPending}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </fieldset>
      </form>
    </SettingSection>
  );
}

// ---------------------------------------------------------------- token lifetime

function TokenPolicySection({ section, onDirtyChange }: { section: AuthSettings['token_policy']; onDirtyChange: (dirty: boolean) => void }) {
  const setPolicy = useSetTokenPolicy();
  const patch = usePatchSettings();
  const saved = section.max_days;
  // undefined = no edit (null is a real choice: no maximum).
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const shown = draft === undefined ? saved : draft;
  const dirty = draft !== undefined && draft !== saved;
  useDirtyReport(dirty, onDirtyChange);

  const save = () => {
    if (draft === undefined) return;
    const max_days = draft;
    setError(null);
    setPolicy.mutate(
      { max_days },
      {
        onSuccess: (stored) => {
          patch((s) => ({ ...s, token_policy: { ...s.token_policy, max_days: stored.max_days } }));
          setDraft(undefined);
          pushToast({
            kind: 'success',
            message: stored.max_days === null ? 'Token lifetime is no longer limited.' : `Tokens are now limited to ${stored.max_days} days.`,
          });
        },
        onError: (err) => setError(errMessage(err, 'Could not save the token policy.')),
      },
    );
  };

  return (
    <SettingSection
      id="auth-tokens"
      title="API token lifetime"
      description={
        <p>
          The longest lifetime a new personal access token may have. Existing tokens keep their expiry until they are{' '}
          <Link to="/admin/auth/tokens" className="AdminAuth__link">
            revoked in API tokens
          </Link>
          .
        </p>
      }
      provenance={section.provenance}
      auditAction="config.token_policy"
      footer={
        <SectionFooter
          dirty={dirty}
          pending={setPolicy.isPending}
          error={error}
          onDiscard={() => {
            setDraft(undefined);
            setError(null);
          }}
          onSave={save}
        />
      }
    >
      <FormField label="Maximum token lifetime" htmlFor="auth-token-max" helper="Applies to tokens created from now on.">
        {(control) => (
          <select
            {...control}
            value={lifetimeToValue(shown)}
            onChange={(e) => {
              const next = valueToLifetime(e.target.value);
              setDraft(next === saved ? undefined : next);
            }}
            disabled={setPolicy.isPending}
          >
            {lifetimeOptions(saved).map((o) => (
              <option key={lifetimeToValue(o.value)} value={lifetimeToValue(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </FormField>
    </SettingSection>
  );
}

// ---------------------------------------------------------------- login throttling

function ThrottleSection({ throttle }: { throttle: AuthSettings['login_throttle'] }) {
  return (
    <SettingSection
      id="auth-throttle"
      title="Sign-in throttling"
      description={
        <p>
          Failed sign-ins tolerated per sliding window before further attempts are refused. Set at deploy time, so it
          cannot be changed here: use <code>auth.loginThrottle</code> in the config file, or the{' '}
          <code>LOGIN_THROTTLE_WINDOW</code>, <code>LOGIN_THROTTLE_PER_USERNAME</code> and <code>LOGIN_THROTTLE_PER_IP</code>{' '}
          environment variables, which win over the file.
        </p>
      }
      provenance={throttle.provenance}
    >
      <dl className="AdminAuth__readonly" aria-label="Sign-in throttling values">
        <div>
          <dt>Window</dt>
          <dd>{durationText(throttle.window_ms)}</dd>
        </div>
        <div>
          <dt>Per account</dt>
          <dd>{attemptLimitText(throttle.per_username)}</dd>
        </div>
        <div>
          <dt>Per client address</dt>
          <dd>{attemptLimitText(throttle.per_ip)}</dd>
        </div>
      </dl>
    </SettingSection>
  );
}
