/**
 * New user (`/admin/users?new=1`, the admin UX review §4.3): the
 * same Sheet as the user sheet, in create mode.
 *
 * The password field replaces a bare `minLength={8}` with a live checklist
 * driven by the instance's password policy, so the admin sees what the server
 * will accept while typing rather than after a refused save. **Generate** fills
 * in a policy-satisfying random password; because the admin never typed it, it
 * is revealed once after the account is created (the same one-time dialog as a
 * reset). A password the admin typed themselves is not shown back.
 *
 * A duplicate username or email comes back from the server with a `reason` and
 * is put under that field.
 */
import { useState } from 'react';
import { FormField } from '../../components/admin/FormField.js';
import { Sheet } from '../../components/admin/Sheet.js';
import { pushToast } from '../../hooks/useToast.js';
import { useCreateUser, usePasswordPolicy } from '../../queries.js';
import { errorText, generatePassword, newUserErrorField, passwordChecklist, type NewUserField } from './usersModel.js';

export interface NewUserSheetProps {
  onClose: () => void;
  /** After creation. `generatedPassword` is set only when Generate made the password. */
  onCreated: (result: { id: string; username: string; generatedPassword: string | null }) => void;
}

export function NewUserSheet({ onClose, onCreated }: NewUserSheetProps): JSX.Element {
  const createUser = useCreateUser();
  const { data: policy } = usePasswordPolicy();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<NewUserField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const checklist = passwordChecklist(policy, password);
  const passwordOk = checklist.every((c) => c.met);
  const isDirty = username !== '' || email !== '' || password !== '' || role !== 'user';
  const canSave = username.trim().length >= 2 && email.trim() !== '' && passwordOk;

  const clearError = (field: NewUserField) => {
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    setFormError(null);
  };

  const onSubmit = () => {
    setFormError(null);
    setFieldErrors({});
    const name = username.trim();
    createUser.mutate(
      { username: name, email: email.trim(), password, role },
      {
        onSuccess: (user) => {
          pushToast({ kind: 'success', message: `Created ${user.username}.` });
          onCreated({ id: user.id, username: user.username, generatedPassword: generated !== null && generated === password ? password : null });
        },
        onError: (err) => {
          const message = errorText(err as { message?: unknown }, 'Could not create user.');
          const field = newUserErrorField(err as { statusCode?: number; reason?: string; message?: unknown });
          if (field) setFieldErrors({ [field]: message });
          else setFormError(message);
        },
      },
    );
  };

  return (
    <Sheet
      title="New user"
      subtitle="Local accounts are invite-only: the new user signs in with the password you set here."
      onClose={onClose}
      form={{ isDirty, isSaving: createUser.isPending, canSave, submitLabel: 'Create user', onSubmit, error: formError }}
    >
      <div className="UserSheet">
        <FormField label="Username" htmlFor="new-user-username" required error={fieldErrors.username} helper="At least 2 characters. Used to sign in.">
          {(control) => (
            <input
              {...control}
              className="UserSheet__input"
              value={username}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setUsername(e.target.value);
                clearError('username');
              }}
            />
          )}
        </FormField>

        <FormField label="Email" htmlFor="new-user-email" required error={fieldErrors.email}>
          {(control) => (
            <input
              {...control}
              className="UserSheet__input"
              type="email"
              value={email}
              autoComplete="off"
              onChange={(e) => {
                setEmail(e.target.value);
                clearError('email');
              }}
            />
          )}
        </FormField>

        <fieldset className="UserSheet__roles">
          <legend className="kp-field__label">Role</legend>
          <label className="UserSheet__role" data-checked={role === 'user' ? 'true' : undefined}>
            <input type="radio" name="new-user-role" value="user" checked={role === 'user'} onChange={() => setRole('user')} />
            <span className="UserSheet__roleText">
              <span className="UserSheet__roleLabel">User</span>
              <span className="UserSheet__muted">Reads and writes content. No access to the admin pages.</span>
            </span>
          </label>
          <label className="UserSheet__role" data-checked={role === 'admin' ? 'true' : undefined}>
            <input type="radio" name="new-user-role" value="admin" checked={role === 'admin'} onChange={() => setRole('admin')} />
            <span className="UserSheet__roleText">
              <span className="UserSheet__roleLabel">Admin</span>
              <span className="UserSheet__muted">Also manages users, authentication, sources and the audit log.</span>
            </span>
          </label>
        </fieldset>

        <FormField
          label="Password"
          htmlFor="new-user-password"
          required
          error={fieldErrors.password}
          helper={
            <ul className="UserSheet__checklist" aria-label="Password requirements">
              {checklist.map((check) => (
                <li key={check.id} data-met={check.met ? 'true' : undefined}>
                  <span aria-hidden="true">{check.met ? '✓' : '○'}</span> {check.label}
                  <span className="UserSheet__vh">{check.met ? ' (met)' : ' (not yet)'}</span>
                </li>
              ))}
            </ul>
          }
        >
          {(control) => (
            <div className="UserSheet__passwordRow">
              <input
                {...control}
                className="UserSheet__input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                // A password for SOMEONE ELSE: never offer to save it as the admin's own.
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearError('password');
                }}
              />
              <button
                type="button"
                className="AdminUsers__btn"
                aria-pressed={showPassword}
                aria-controls="new-user-password"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="AdminUsers__btn"
                onClick={() => {
                  const next = generatePassword(policy);
                  setPassword(next);
                  setGenerated(next);
                  clearError('password');
                }}
              >
                Generate
              </button>
            </div>
          )}
        </FormField>
        {generated !== null && generated === password ? (
          <p className="UserSheet__muted" role="status">
            A password was generated. It is shown to you once, after the account is created.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
