import { FormEvent, useState } from 'react';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { pushToast } from '../hooks/useToast.js';
import {
  useMe,
  useUsers,
  useCreateUser,
  useUpdateUser,
  useResetUserPassword,
  type AdminUser,
} from '../queries.js';
import './AdminHome.css';
import './AdminUsers.css';

function errMessage(err: unknown, fallback: string): string {
  return (err as { message?: string })?.message ?? fallback;
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function AdminUsers() {
  const { data: me } = useMe();
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const { data: users, isLoading } = useUsers({
    q: q.trim() || undefined,
    role: roleFilter || undefined,
    status: statusFilter || undefined,
  });

  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'user' as 'user' | 'admin' });
  const [createError, setCreateError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(null);

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    createUser.mutate(
      { username: form.username.trim(), email: form.email.trim(), password: form.password, role: form.role },
      {
        onSuccess: () => {
          pushToast({ kind: 'success', message: `Created ${form.username.trim()}.` });
          setForm({ username: '', email: '', password: '', role: 'user' });
          setShowCreate(false);
        },
        onError: (err) => setCreateError(errMessage(err, 'Could not create user.')),
      },
    );
  };

  const onChangeRole = (user: AdminUser, role: 'user' | 'admin') => {
    if (role === user.role) return;
    updateUser.mutate(
      { id: user.id, role },
      {
        onSuccess: () => pushToast({ kind: 'success', message: `${user.username} is now ${role}.` }),
        onError: (err) => pushToast({ kind: 'error', message: errMessage(err, 'Could not change role.') }),
      },
    );
  };

  const onToggleDisabled = (user: AdminUser) => {
    const disabling = user.status === 'active';
    updateUser.mutate(
      { id: user.id, disabled: disabling },
      {
        onSuccess: () =>
          pushToast({ kind: 'success', message: `${user.username} ${disabling ? 'disabled' : 're-enabled'}.` }),
        onError: (err) => pushToast({ kind: 'error', message: errMessage(err, 'Could not update account.') }),
      },
    );
  };

  const onReset = (user: AdminUser) => {
    resetPassword.mutate(user.id, {
      onSuccess: (password) => setResetResult({ username: user.username, password }),
      onError: (err) => pushToast({ kind: 'error', message: errMessage(err, 'Could not reset password.') }),
    });
  };

  const copyTempPassword = async () => {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.password);
      pushToast({ kind: 'success', message: 'Temporary password copied.' });
    } catch {
      pushToast({ kind: 'error', message: 'Copy failed — select and copy manually.' });
    }
  };

  return (
    <main className="AdminHome" aria-labelledby="admin-users-title">
      <AdminTabs />
      <section className="AdminHome__hero">
        <div className="AdminHome__eyebrow">
          <Icon icon={appIcons.users} />
          <span>Users</span>
        </div>
        <h1 id="admin-users-title">User management</h1>
        <p>Invite accounts, assign roles, disable access, and reset passwords. Local accounts are invite-only.</p>
      </section>

      {resetResult && (
        <div className="AdminUsers__resetBanner" role="alert">
          <div>
            <strong>Temporary password for {resetResult.username}</strong>
            <p>Share it securely. Their existing sessions were signed out; they should change it after signing in.</p>
            <code className="AdminUsers__tempPassword">{resetResult.password}</code>
          </div>
          <div className="AdminUsers__resetActions">
            <button type="button" className="AdminUsers__btn" onClick={copyTempPassword}>
              <Icon icon={appIcons.copy} /> Copy
            </button>
            <button type="button" className="AdminUsers__btn AdminUsers__btn--ghost" onClick={() => setResetResult(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <section className="AdminUsers__toolbar" aria-label="Filters">
        <input
          className="AdminUsers__search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by username or email…"
          aria-label="Search users"
        />
        <select className="AdminUsers__filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          <option value="admin">Admins</option>
          <option value="user">Users</option>
        </select>
        <select className="AdminUsers__filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <button type="button" className="AdminUsers__btn AdminUsers__btn--primary" onClick={() => setShowCreate((v) => !v)}>
          <Icon icon={appIcons.plus} /> New user
        </button>
      </section>

      {showCreate && (
        <form className="AdminUsers__createForm" onSubmit={onCreate}>
          <div className="AdminUsers__createGrid">
            <label>
              <span>Username</span>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={2} />
            </label>
            <label>
              <span>Email</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
            <label>
              <span>Temporary password</span>
              <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} placeholder="At least 8 characters" />
            </label>
            <label>
              <span>Role</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'user' | 'admin' })}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          {createError ? <div className="AdminUsers__formError" role="alert">{createError}</div> : null}
          <div className="AdminUsers__createActions">
            <button type="submit" className="AdminUsers__btn AdminUsers__btn--primary" disabled={createUser.isPending}>
              {createUser.isPending ? 'Creating…' : 'Create user'}
            </button>
            <button type="button" className="AdminUsers__btn AdminUsers__btn--ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <section className="AdminUsers__tableWrap" aria-label="Users">
        {isLoading ? (
          <p className="AdminUsers__empty">Loading users…</p>
        ) : !users || users.length === 0 ? (
          <p className="AdminUsers__empty">No users match the current filters.</p>
        ) : (
          <table className="AdminUsers__table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last seen</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf = me?.id === user.id;
                return (
                  <tr key={user.id} className={user.status === 'disabled' ? 'AdminUsers__row--disabled' : ''}>
                    <td>
                      <div className="AdminUsers__userCell">
                        <strong>{user.username}</strong>
                        <span>{user.email}</span>
                      </div>
                    </td>
                    <td>
                      <select
                        className="AdminUsers__roleSelect"
                        value={user.role}
                        disabled={isSelf || updateUser.isPending}
                        title={isSelf ? 'You cannot change your own role' : undefined}
                        onChange={(e) => onChangeRole(user, e.target.value as 'user' | 'admin')}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td>
                      <span className={`AdminUsers__statusChip AdminUsers__statusChip--${user.status}`}>{user.status}</span>
                    </td>
                    <td className="AdminUsers__lastSeen">{formatLastSeen(user.last_seen_at)}</td>
                    <td className="AdminUsers__rowActions">
                      <button type="button" className="AdminUsers__btn AdminUsers__btn--ghost" onClick={() => onReset(user)} disabled={resetPassword.isPending}>
                        Reset password
                      </button>
                      <button
                        type="button"
                        className="AdminUsers__btn"
                        disabled={isSelf || updateUser.isPending}
                        title={isSelf ? 'You cannot disable your own account' : undefined}
                        onClick={() => onToggleDisabled(user)}
                      >
                        {user.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
