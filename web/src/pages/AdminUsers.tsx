/**
 * AdminUsers — `/admin/users` (the admin UX review §4.3): a
 * read-only, server-paged table of accounts plus the user sheet.
 *
 * The table used to carry a role <select> and Reset/Disable buttons on every
 * row. Now nothing commits from a row (§3.3): a row opens the user sheet
 * (`?user=<id>`), and the row menu offers the same actions behind the same
 * confirmations (useAccountActions). New user is the same Sheet in create mode
 * (`?new=1`).
 *
 * Everything the admin can set - search, Role and Status filters, sort, page,
 * the open sheet - lives in the query string, so a filtered list is a link and
 * Back undoes a filter. Filtering, sorting and paging run on the server; the
 * previous page stays on screen while the next loads, so there is no flash.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { Sheet } from '../components/admin/Sheet.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useAdminUser, useMe, useUserCounts, useUsersPage, type AdminUser } from '../queries.js';
import { NewUserSheet } from '../features/users/NewUserSheet.js';
import { OneTimePasswordDialog } from '../features/users/OneTimePasswordDialog.js';
import { UserSheet } from '../features/users/UserSheet.js';
import { useAccountActions } from '../features/users/useAccountActions.js';
import {
  USERS_PAGE_SIZE,
  absoluteTime,
  accountRules,
  pageCount,
  pageRangeText,
  readUsersSearch,
  relativeTime,
  shortDate,
  usersListParams,
  usersSearchToParams,
  withFilters,
  type UsersSearch,
  type UsersSortColumn,
} from '../features/users/usersModel.js';
import './AdminHome.css';
import './AdminUsers.css';

const SEARCH_DEBOUNCE_MS = 300;

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function AdminUsers() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const state = readUsersSearch(rawSearch);
  const { data: me } = useMe();
  const counts = useUserCounts();
  const actions = useAccountActions();

  const go = (next: UsersSearch, replace = false) => {
    void navigate({ to: '/admin/users', search: usersSearchToParams(next) as never, replace });
  };

  // Search: typed locally, pushed to the URL after a pause (replace, so a typed
  // word is one history entry, not one per letter). `pushedQ` tells our own
  // navigation apart from an outside one (Back, a pasted link), which must
  // overwrite what is in the box.
  const [qInput, setQInput] = useState(state.q);
  const debouncedQ = useDebouncedValue(qInput, SEARCH_DEBOUNCE_MS);
  const pushedQ = useRef(state.q);
  useEffect(() => {
    if (debouncedQ.trim() === state.q.trim()) return;
    pushedQ.current = debouncedQ.trim();
    go(withFilters(state, { q: debouncedQ }), true);
    // `state` is rebuilt every render; only the debounced text should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    if (state.q.trim() !== pushedQ.current) {
      pushedQ.current = state.q.trim();
      setQInput(state.q);
    }
  }, [state.q]);

  const listQuery = useUsersPage(usersListParams(state));
  const page = listQuery.data;
  const rows = page?.users ?? [];
  const total = page?.total ?? 0;

  // A page past the end (the last account on it was just disabled under a
  // Status filter, or a shared link outlived the data): step back to the last page.
  useEffect(() => {
    if (page && !listQuery.isPlaceholderData && rows.length === 0 && total > 0 && state.page > 1) {
      go({ ...state, page: pageCount(total) }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, listQuery.isPlaceholderData, rows.length, total, state.page]);

  // The sheet's account: the row already on screen when there is one, else
  // fetched by id so a shared `?user=` link opens on any page.
  const rowUser = state.user ? rows.find((r) => r.id === state.user) : undefined;
  const userQuery = useAdminUser(state.user);
  const sheetUser = userQuery.data ?? rowUser;

  const [createdReveal, setCreatedReveal] = useState<{ username: string; password: string } | null>(null);

  const hasFilters = Boolean(state.q.trim() || state.role || state.status);
  const openUser = (user: AdminUser) => go({ ...state, user: user.id, create: false });

  const rowActions = (user: AdminUser): OverflowMenuItem[] => {
    const busy = actions.busyUserId === user.id ? 'Working…' : undefined;
    const rules = accountRules(user, me?.id, counts.activeAdmins);
    return [
      { id: 'edit', label: 'Edit…', onSelect: () => openUser(user) },
      { id: 'reset', label: 'Reset password…', onSelect: () => actions.ask({ kind: 'reset', user }), disabledReason: busy },
      user.status === 'active'
        ? {
            id: 'disable',
            label: 'Disable…',
            danger: true,
            onSelect: () => actions.ask({ kind: 'disable', user }),
            disabledReason: busy ?? rules.disableLockedReason ?? undefined,
          }
        : { id: 'enable', label: 'Enable', onSelect: () => actions.enable(user), disabledReason: busy },
      {
        id: 'audit',
        label: 'View activity in audit log',
        separatorBefore: true,
        onSelect: () => void navigate({ to: '/admin/audit', search: { actor: user.username } as never }),
      },
    ];
  };

  const columns: DataTableColumn<AdminUser>[] = [
    {
      id: 'username',
      header: 'User',
      primary: true,
      sortValue: (u) => u.username,
      cell: (u) => (
        <span className="AdminUsers__userCell">
          <strong>
            {u.username}
            {me?.id === u.id ? <span className="AdminUsers__you"> (you)</span> : null}
          </strong>
          <span>{u.email}</span>
        </span>
      ),
    },
    { id: 'role', header: 'Role', sortValue: (u) => u.role, cell: (u) => (u.role === 'admin' ? 'Admin' : 'User') },
    {
      id: 'status',
      header: 'Status',
      sortValue: (u) => u.status,
      cell: (u) => <StatusChip tone={u.status === 'active' ? 'ok' : 'info'} label={u.status === 'active' ? 'Active' : 'Disabled'} size="sm" />,
    },
    {
      id: 'last_seen',
      header: 'Last seen',
      sortValue: (u) => u.last_seen_at ?? '',
      cell: (u) =>
        u.last_seen_at ? (
          <time dateTime={u.last_seen_at} title={absoluteTime(u.last_seen_at)} className="AdminUsers__lastSeen">
            {relativeTime(u.last_seen_at)}
          </time>
        ) : (
          <span className="AdminUsers__lastSeen">Never</span>
        ),
    },
    {
      id: 'created',
      header: 'Created',
      hideBelow: 'md',
      sortValue: (u) => u.created_at,
      cell: (u) => (
        <time dateTime={u.created_at} title={absoluteTime(u.created_at)} className="AdminUsers__lastSeen">
          {shortDate(u.created_at)}
        </time>
      ),
    },
  ];

  const meta =
    counts.accounts === undefined
      ? undefined
      : `${plural(counts.accounts, 'account', 'accounts')}${counts.activeAdmins === undefined ? '' : ` · ${plural(counts.activeAdmins, 'active admin', 'active admins')}`}`;

  const toolbar = (
    <div className="AdminUsers__toolbar" role="search" aria-label="Filter users">
      <input
        className="AdminUsers__search"
        type="search"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        placeholder="Search username or email…"
        aria-label="Search users"
      />
      <select
        className="AdminUsers__filter"
        value={state.role ?? ''}
        onChange={(e) => go(withFilters(state, { role: (e.target.value || undefined) as UsersSearch['role'] }))}
        aria-label="Filter by role"
      >
        <option value="">All roles</option>
        <option value="admin">Admins</option>
        <option value="user">Users</option>
      </select>
      <select
        className="AdminUsers__filter"
        value={state.status ?? ''}
        onChange={(e) => go(withFilters(state, { status: (e.target.value || undefined) as UsersSearch['status'] }))}
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="disabled">Disabled</option>
      </select>
      {hasFilters ? (
        <button
          type="button"
          className="AdminUsers__btn AdminUsers__btn--ghost"
          onClick={() => {
            pushedQ.current = '';
            setQInput('');
            go(withFilters(state, { q: '', role: undefined, status: undefined }));
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );

  const pages = pageCount(total);
  const offset = (state.page - 1) * USERS_PAGE_SIZE;

  return (
    <main className="AdminHome" aria-labelledby="admin-users-title">
      <AdminPageHeader
        titleId="admin-users-title"
        title="Users"
        description="Accounts that can sign in to this instance, their roles, and their access."
        meta={meta}
        primaryAction={
          <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => go({ ...state, create: true, user: undefined })}>
            <Icon icon={appIcons.plus} /> New user
          </button>
        }
      />

      <section className="AdminUsers__list" aria-label="Users">
        <DataTable
          rows={rows}
          rowKey={(u) => u.id}
          columns={columns}
          caption="Users"
          state={listQuery.isError ? 'error' : listQuery.isLoading || listQuery.isPlaceholderData ? 'loading' : 'ready'}
          errorMessage="Couldn't load users."
          onRetry={() => void listQuery.refetch()}
          empty={
            hasFilters ? (
              <EmptyState title="No users match" body="Try a different search, or clear the filters." />
            ) : (
              <EmptyState title="No accounts yet" body="Create the first account people will sign in with." />
            )
          }
          onRowOpen={openUser}
          rowActions={rowActions}
          rowLabel={(u) => u.username}
          sort={state.sort ? { columnId: state.sort, direction: state.dir ?? 'asc' } : undefined}
          onSortChange={(s) => go(withFilters(state, { sort: s.columnId as UsersSortColumn, dir: s.direction }), true)}
          toolbar={toolbar}
          selectedKey={state.user ?? null}
        />
        {total > 0 ? (
          <nav className="kp-dt__pager AdminUsers__pager" aria-label="Users pages">
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

      {state.create ? (
        <NewUserSheet
          onClose={() => go({ ...state, create: false })}
          onCreated={({ username, generatedPassword }) => {
            go({ ...state, create: false });
            if (generatedPassword) setCreatedReveal({ username, password: generatedPassword });
          }}
        />
      ) : state.user ? (
        sheetUser ? (
          <UserSheet
            // A different account is a different form: never carry a role draft across.
            key={sheetUser.id}
            user={sheetUser}
            meId={me?.id}
            activeAdmins={counts.activeAdmins}
            actions={actions}
            onClose={() => go({ ...state, user: undefined })}
          />
        ) : userQuery.isError ? (
          <MissingUserSheet onClose={() => go({ ...state, user: undefined })} />
        ) : null
      ) : null}

      {actions.dialogs}
      {createdReveal ? (
        <OneTimePasswordDialog
          title={`Password for ${createdReveal.username}`}
          body={`Share it securely; it will not be shown again. ${createdReveal.username} should change it after signing in.`}
          password={createdReveal.password}
          onDone={() => setCreatedReveal(null)}
        />
      ) : null}
    </main>
  );
}

/** A `?user=` link to an account that does not exist (or is the hidden system actor). */
function MissingUserSheet({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Sheet title="User not found" onClose={onClose}>
      <EmptyState title="No such account" body="The link may be out of date. Close this panel to see the list." />
    </Sheet>
  );
}
