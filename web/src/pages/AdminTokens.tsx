/**
 * AdminTokens — `/admin/auth/tokens` (the admin UX review §4.7):
 * every user's personal access tokens, read-only and server-paged, with Revoke
 * behind a confirmation.
 *
 * This list used to sit unbounded inside the Authentication settings, with a
 * Revoke button per row behind `window.confirm`. Now it is its own page on the
 * house list pattern (AdminUsers): filters in the query string, filtering and
 * paging on the server, the previous page kept on screen while the next loads,
 * and row actions in the `⋯` menu (§3.3: nothing destructive commits from a row).
 *
 * No part of a token's secret appears here — no value, prefix or length. A
 * token is recognised by its name, owner, scope and dates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { apiClient } from '../api.js';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { ReferencePicker } from '../components/admin/ReferencePicker.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { pushToast } from '../hooks/useToast.js';
import type { AdminUsersPage } from '../queries.js';
import { useAdminRevokeToken, useAdminTokensPage, type AdminApiToken, type AdminTokenStateFilter, type TokenScope } from '../features/tokens/queries.js';
import { TOKEN_STATE_LABELS, formatTokenDate, tokenState } from '../features/tokens/tokenHelpers.js';
import {
  SCOPE_LABELS,
  TOKENS_PAGE_SIZE,
  TOKEN_STATE_FILTER_OPTIONS,
  TOKEN_STATE_TONES,
  hasTokenFilters,
  readTokensSearch,
  revokeDisabledReason,
  tokensListParams,
  tokensSearchToParams,
  withTokenFilters,
  type TokensSearch,
} from '../features/tokens/tokensListModel.js';
import { absoluteTime, pageCount, pageRangeText } from '../features/users/usersModel.js';
import './AdminHome.css';
import './AdminTokens.css';

const SEARCH_DEBOUNCE_MS = 300;
const OWNER_OPTION_LIMIT = 20;

interface OwnerOption {
  username: string;
  email: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function errMessage(err: unknown, fallback: string): string {
  return (err as { message?: string })?.message ?? fallback;
}

export function AdminTokens() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const state = readTokensSearch(rawSearch);

  const go = (next: TokensSearch, replace = false) => {
    void navigate({ to: '/admin/auth/tokens', search: tokensSearchToParams(next) as never, replace });
  };

  // Name search: typed locally, pushed to the URL after a pause (see AdminUsers
  // for why `pushedQ` tells our own navigation apart from Back or a pasted link).
  const [qInput, setQInput] = useState(state.q);
  const debouncedQ = useDebouncedValue(qInput, SEARCH_DEBOUNCE_MS);
  const pushedQ = useRef(state.q);
  useEffect(() => {
    if (debouncedQ.trim() === state.q.trim()) return;
    pushedQ.current = debouncedQ.trim();
    go(withTokenFilters(state, { q: debouncedQ }), true);
    // `state` is rebuilt every render; only the debounced text should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    if (state.q.trim() !== pushedQ.current) {
      pushedQ.current = state.q.trim();
      setQInput(state.q);
    }
  }, [state.q]);

  const listQuery = useAdminTokensPage(tokensListParams(state));
  const page = listQuery.data;
  const rows = page?.tokens ?? [];
  const total = page?.total ?? 0;
  // The header's instance-wide count, independent of the filters.
  const allCount = useAdminTokensPage({ limit: 1 }).data?.total;
  const activeCount = useAdminTokensPage({ state: 'active', limit: 1 }).data?.total;

  // A page past the end (its last token filtered away by a revoke, or a stale link): step back.
  useEffect(() => {
    if (page && !listQuery.isPlaceholderData && rows.length === 0 && total > 0 && state.page > 1) {
      go({ ...state, page: pageCount(total, TOKENS_PAGE_SIZE) }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, listQuery.isPlaceholderData, rows.length, total, state.page]);

  // Owners come from the users endpoint as the admin types; stable so the
  // picker does not reload on every render.
  const loadOwners = useCallback(async (query: string): Promise<OwnerOption[]> => {
    const qs = new URLSearchParams({ limit: String(OWNER_OPTION_LIMIT) });
    if (query.trim()) qs.set('q', query.trim());
    const res = await apiClient.get<AdminUsersPage>(`/admin/users?${qs.toString()}`);
    return res.users.map((u) => ({ username: u.username, email: u.email }));
  }, []);

  const revoke = useAdminRevokeToken();
  const [pendingRevoke, setPendingRevoke] = useState<AdminApiToken | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const confirmRevoke = () => {
    if (!pendingRevoke) return;
    const token = pendingRevoke;
    setRevokeError(null);
    revoke.mutate(token.id, {
      onSuccess: () => {
        setPendingRevoke(null);
        pushToast({ kind: 'success', message: `Token “${token.name}” of ${token.username} revoked.` });
      },
      onError: (err) => setRevokeError(errMessage(err, 'Could not revoke the token.')),
    });
  };

  const rowActions = (token: AdminApiToken): OverflowMenuItem[] => {
    const tokenStatus = tokenState(token);
    return [
      {
        id: 'revoke',
        label: 'Revoke…',
        danger: true,
        disabledReason: revokeDisabledReason(tokenStatus) ?? undefined,
        onSelect: () => {
          setRevokeError(null);
          setPendingRevoke(token);
        },
      },
      {
        id: 'audit',
        label: 'View owner’s activity in Audit',
        separatorBefore: true,
        onSelect: () => void navigate({ to: '/admin/audit', search: { actor: token.username } as never }),
      },
    ];
  };

  const columns: DataTableColumn<AdminApiToken>[] = [
    { id: 'name', header: 'Name', primary: true, cell: (t) => <strong className="AdminTokens__name">{t.name}</strong> },
    {
      id: 'owner',
      header: 'Owner',
      cell: (t) => (
        <Link to="/admin/users" search={{ q: t.username } as never} className="AdminTokens__owner">
          {t.username}
        </Link>
      ),
    },
    { id: 'scope', header: 'Scope', cell: (t) => SCOPE_LABELS[t.scope] },
    {
      id: 'created',
      header: 'Created',
      hideBelow: 'md',
      cell: (t) => (
        <time dateTime={t.created_at} title={absoluteTime(t.created_at)}>
          {formatTokenDate(t.created_at)}
        </time>
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      cell: (t) =>
        t.expires_at ? (
          <time dateTime={t.expires_at} title={absoluteTime(t.expires_at)}>
            {formatTokenDate(t.expires_at)}
          </time>
        ) : (
          'Never'
        ),
    },
    {
      id: 'last_used',
      header: 'Last used',
      hideBelow: 'md',
      cell: (t) =>
        t.last_used_at ? (
          <time dateTime={t.last_used_at} title={absoluteTime(t.last_used_at)}>
            {formatTokenDate(t.last_used_at)}
          </time>
        ) : (
          'Never'
        ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (t) => {
        const s = tokenState(t);
        // Text and icon, never colour alone: "Owner disabled" reads the same in greyscale.
        return <StatusChip tone={TOKEN_STATE_TONES[s]} label={TOKEN_STATE_LABELS[s]} size="sm" />;
      },
    },
  ];

  const filtered = hasTokenFilters(state);

  const toolbar = (
    <div className="AdminTokens__toolbar" role="search" aria-label="Filter tokens">
      <input
        className="AdminTokens__search"
        type="search"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        placeholder="Search token name…"
        aria-label="Search token name"
      />
      <div className="AdminTokens__owner-picker">
        <ReferencePicker<OwnerOption>
          id="tokens-owner"
          ariaLabel="Filter by owner"
          placeholder="Any owner"
          value={state.owner ?? ''}
          onChange={(key) => go(withTokenFilters(state, { owner: key || undefined }))}
          loadOptions={loadOwners}
          getKey={(o) => o.username}
          getLabel={(o) => o.username}
          renderOption={(o) => (
            <span className="AdminTokens__ownerOption">
              <strong>{o.username}</strong>
              <span>{o.email}</span>
            </span>
          )}
          emptyOption={{ label: 'Any owner' }}
          testId="tokens-owner-filter"
        />
      </div>
      <select
        className="AdminTokens__filter"
        value={state.state ?? ''}
        onChange={(e) => go(withTokenFilters(state, { state: (e.target.value || undefined) as AdminTokenStateFilter | undefined }))}
        aria-label="Filter by state"
      >
        {TOKEN_STATE_FILTER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="AdminTokens__filter"
        value={state.scope ?? ''}
        onChange={(e) => go(withTokenFilters(state, { scope: (e.target.value || undefined) as TokenScope | undefined }))}
        aria-label="Filter by scope"
      >
        <option value="">All scopes</option>
        <option value="read">Read</option>
        <option value="write">Write</option>
      </select>
      {filtered ? (
        <button
          type="button"
          className="kp-admin-button"
          onClick={() => {
            pushedQ.current = '';
            setQInput('');
            go(withTokenFilters(state, { q: '', owner: undefined, state: undefined, scope: undefined }));
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );

  const pages = pageCount(total, TOKENS_PAGE_SIZE);
  const offset = (state.page - 1) * TOKENS_PAGE_SIZE;
  const meta =
    allCount === undefined
      ? undefined
      : `${plural(allCount, 'token', 'tokens')}${activeCount === undefined ? '' : ` · ${activeCount.toLocaleString('en-US')} active`}`;

  return (
    <main className="AdminHome" aria-labelledby="admin-tokens-title">
      <AdminPageHeader
        titleId="admin-tokens-title"
        title="API tokens"
        description="Personal access tokens people created in their Profile so MCP clients and scripts can act as them."
        meta={meta}
        secondaryActions={
          <Link to="/admin/auth" className="kp-admin-button">
            Token lifetime policy
          </Link>
        }
      />

      <section className="AdminTokens__list" aria-label="API tokens">
        <DataTable
          rows={rows}
          rowKey={(t) => t.id}
          columns={columns}
          caption="API tokens"
          state={listQuery.isError ? 'error' : listQuery.isLoading || listQuery.isPlaceholderData ? 'loading' : 'ready'}
          errorMessage="Couldn't load tokens."
          onRetry={() => void listQuery.refetch()}
          empty={
            filtered ? (
              <EmptyState title="No tokens match" body="Try a different search, or clear the filters." />
            ) : (
              <EmptyState title="No tokens yet" body="People create personal access tokens in their Profile." />
            )
          }
          rowActions={rowActions}
          rowLabel={(t) => `${t.name} (${t.username})`}
          toolbar={toolbar}
        />
        {total > 0 ? (
          <nav className="kp-dt__pager AdminTokens__pager" aria-label="Token pages">
            <span className="kp-dt__range" aria-live="polite">
              {pageRangeText(offset, rows.length, total)}
            </span>
            <button type="button" className="kp-dt__button" disabled={state.page <= 1} onClick={() => go({ ...state, page: state.page - 1 })}>
              Previous
            </button>
            <button type="button" className="kp-dt__button" disabled={state.page >= pages} onClick={() => go({ ...state, page: state.page + 1 })}>
              Next
            </button>
          </nav>
        ) : null}
      </section>

      {pendingRevoke ? (
        <ConfirmDialog
          title={`Revoke “${pendingRevoke.name}”?`}
          body={`This token belongs to ${pendingRevoke.username}. It stops working immediately.`}
          consequences={[
            'Anything using it — an MCP client, a script, a scheduled job — fails on its next request.',
            'Revoking cannot be undone; the owner can create a new token in their Profile.',
          ]}
          confirmLabel="Revoke token"
          tone="danger"
          pending={revoke.isPending}
          error={revokeError}
          onConfirm={confirmRevoke}
          onCancel={() => {
            setPendingRevoke(null);
            setRevokeError(null);
          }}
        />
      ) : null}
    </main>
  );
}
