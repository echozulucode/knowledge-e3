import { FormEvent, useState } from 'react';
import { Icon, appIcons } from '../../icons.js';
import { pushToast } from '../../hooks/useToast.js';
import { ConfirmDialog } from '../../components/admin/ConfirmDialog.js';
import { useCreateToken, useMyTokens, useRevokeToken, type CreatedToken, type TokenScope } from './queries.js';
import { TOKEN_STATE_LABELS, expiryOptions, formatTokenDate, mcpConfigSnippet, tokenState } from './tokenHelpers.js';

const SCOPES: { value: TokenScope; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'Search and read what you can see; cannot change anything.' },
  { value: 'write', label: 'Write', hint: 'Create and edit content as you, with your own permissions.' },
];

function errMessage(err: unknown, fallback: string): string {
  return (err as { message?: string })?.message ?? fallback;
}

/** Profile → Personal access tokens: list, create (one-time reveal), revoke. */
export function TokensPanel() {
  const { data, isLoading } = useMyTokens();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();

  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [expiry, setExpiry] = useState<string>('90');
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const maxDays = data?.policy.max_days ?? null;
  const options = expiryOptions(maxDays);
  const expiryValue = options.some((o) => String(o.value) === expiry) ? expiry : String(options[0]?.value ?? 'null');

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError('Give the token a name so you can recognise it later.');
      return;
    }
    if (options.length === 0) {
      setFormError('No token lifetime is currently allowed on this instance.');
      return;
    }
    createToken.mutate(
      { name: name.trim(), scope, expires_in_days: expiryValue === 'null' ? null : Number(expiryValue) },
      {
        onSuccess: (token) => {
          setCreated(token);
          setName('');
          pushToast({ kind: 'success', message: `Token "${token.name}" created.` });
        },
        onError: (err) => setFormError(errMessage(err, 'Could not create token.')),
      },
    );
  };

  // The token waiting on confirmation (was `window.confirm`, which cannot list
  // consequences or show a failure next to the action).
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const onConfirmRevoke = () => {
    if (!pendingRevoke) return;
    const { id, name: tokenName } = pendingRevoke;
    setRevokeError(null);
    revokeToken.mutate(id, {
      onSuccess: () => {
        setPendingRevoke(null);
        pushToast({ kind: 'success', message: `Token "${tokenName}" revoked.` });
      },
      onError: (err) => setRevokeError(errMessage(err, 'Could not revoke token.')),
    });
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: 'success', message: `${what} copied.` });
    } catch {
      pushToast({ kind: 'error', message: 'Copy failed — select and copy manually.' });
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <section className="Profile__panel Profile__panel--wide" aria-labelledby="profile-tokens-title">
      <h2 id="profile-tokens-title">Personal access tokens</h2>
      <p className="Profile__muted">
        Tokens let an MCP client or script act as you without a browser login. Each token is either read-only or
        write-capable, and can be revoked here at any time.
        {maxDays !== null ? ` This instance limits token lifetime to ${maxDays} days.` : ''}
      </p>

      {created ? (
        <div className="Profile__tokenReveal" role="alert">
          <strong>New token "{created.name}"</strong>
          <p>Copy it now; it will not be shown again.</p>
          <div className="Profile__tokenRevealRow">
            <code className="Profile__tokenValue">{created.token}</code>
            <button type="button" className="Profile__tokenBtn" onClick={() => copy(created.token, 'Token')}>
              <Icon icon={appIcons.copy} /> Copy
            </button>
          </div>
          <details className="Profile__tokenSnippet">
            <summary>Use it in an MCP client config</summary>
            <pre>{mcpConfigSnippet(origin, created.token)}</pre>
          </details>
          <button type="button" className="Profile__tokenBtn Profile__tokenBtn--ghost" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}

      <form className="Profile__tokenForm" onSubmit={onCreate} aria-label="Create a token">
        <label htmlFor="profile-token-name">Name</label>
        <input
          id="profile-token-name"
          type="text"
          maxLength={100}
          placeholder="e.g. Claude Desktop on my laptop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <fieldset className="Profile__tokenScopes">
          <legend>Scope</legend>
          {SCOPES.map((s) => (
            <label key={s.value} className="Profile__tokenScope">
              <input type="radio" name="token-scope" value={s.value} checked={scope === s.value} onChange={() => setScope(s.value)} />
              <span>
                <strong>{s.label}</strong>
                <span>{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label htmlFor="profile-token-expiry">Expires</label>
        <select id="profile-token-expiry" value={expiryValue} onChange={(e) => setExpiry(e.target.value)} disabled={options.length === 0}>
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        {formError ? (
          <div className="Profile__formError" role="alert">
            {formError}
          </div>
        ) : null}
        <button type="submit" className="Profile__submit" disabled={createToken.isPending || options.length === 0}>
          {createToken.isPending ? 'Creating…' : 'Create token'}
        </button>
      </form>

      {isLoading ? (
        <p className="Profile__muted">Loading tokens…</p>
      ) : !data || data.tokens.length === 0 ? (
        <p className="Profile__muted">You have no tokens yet.</p>
      ) : (
        <div className="Profile__tokenTableWrap">
          <table className="Profile__tokenTable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Last used</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => {
                const state = tokenState(t);
                return (
                  <tr key={t.id} className={state === 'active' ? undefined : 'Profile__tokenRow--inactive'}>
                    <td>{t.name}</td>
                    <td>
                      <span className={`Profile__scopeChip Profile__scopeChip--${t.scope}`}>{t.scope}</span>
                    </td>
                    <td>{formatTokenDate(t.created_at)}</td>
                    <td>{formatTokenDate(t.expires_at, 'Never')}</td>
                    <td>{formatTokenDate(t.last_used_at, 'Never')}</td>
                    <td>
                      <span className={`Profile__tokenState Profile__tokenState--${state}`}>{TOKEN_STATE_LABELS[state]}</span>
                    </td>
                    <td className="Profile__tokenActions">
                      {state === 'revoked' ? null : (
                        <button
                          type="button"
                          className="Profile__tokenBtn Profile__tokenBtn--danger"
                          onClick={() => {
                            setRevokeError(null);
                            setPendingRevoke({ id: t.id, name: t.name });
                          }}
                          disabled={revokeToken.isPending}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingRevoke ? (
        <ConfirmDialog
          title={`Revoke “${pendingRevoke.name}”?`}
          body="The token stops working immediately."
          consequences={['Anything using it — an MCP client or a script — fails on its next request.', 'Revoking cannot be undone; you can create a new token here.']}
          confirmLabel="Revoke token"
          tone="danger"
          pending={revokeToken.isPending}
          error={revokeError}
          onConfirm={onConfirmRevoke}
          onCancel={() => {
            setPendingRevoke(null);
            setRevokeError(null);
          }}
        />
      ) : null}
    </section>
  );
}
