/**
 * Add / edit one source-registry entry — every column of `content_sources`
 * (plan §7.4) — as the editor sheet of Admin → Sources
 * (the admin UX review §4.4).
 *
 * The seventeen controls are grouped by the question an admin is answering:
 * 1 Repository · 2 Sync policy · 3 Change-request host (review only — the one
 * mode that opens PRs) · 4 Which files this source indexes (collapsed; most
 * sources use the OKF layout) · ▸ Advanced. The mode cards carry the plan §8.2
 * explanation of what each policy does. Tokens are named by env var, never
 * typed here, and their presence comes from the server as a boolean.
 *
 * The rules are unchanged from the inline form this replaces: validation is
 * `validateSourceForm`, the body is `formToUpsert`, and a refused save keeps
 * everything typed with the server's message beside the field it names
 * (`saveError.ts`). The Sheet owns the <form>, Cancel/Save and the "Discard
 * changes?" prompt.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from '../../api.js';
import { useContentTypes } from '../../queries.js';
import { FormField } from '../../components/admin/FormField.js';
import { FormSection } from '../../components/admin/FormSection.js';
import { Sheet } from '../../components/admin/Sheet.js';
import { StatusChip } from '../../components/admin/StatusChip.js';
import {
  DEFAULT_SELECTION_LABEL,
  HOST_OPTIONS,
  MODE_OPTIONS,
  ROLE_OPTIONS,
  defaultLocalDir,
  needsHost,
  validateSourceForm,
  type SourceForm as SourceFormValues,
} from './sourceModel.js';
import {
  editorSecretPresence,
  errorSummary,
  groupHasError,
  groupOfField,
  isSourceFormDirty,
  selectionSummary,
  type EditorGroup,
} from './sourcesAdminModel.js';
import { useTestConnection } from './queries.js';
import type { SourceSaveError } from './saveError.js';
import type { DefaultStatus, HostKind, SourceRole, SourceStatusView, SyncMode } from './types.js';
import './Sources.css';

export interface SourceEditorSheetProps {
  initial: SourceFormValues;
  /** A new registration (the id is editable) or an existing row. */
  isNew: boolean;
  /** The row being edited, for the token/secret presence chips. Absent for a new source. */
  source?: SourceStatusView | null;
  busy?: boolean;
  /**
   * The server's refusal of the last submit, mapped onto the fields
   * (`mapSourceSaveError`). The sheet stays open with what was typed; each field
   * message clears as soon as that field is edited.
   */
  saveError?: SourceSaveError | null;
  onSubmit: (form: SourceFormValues) => void;
  onClose: () => void;
}

type FieldKey = keyof SourceFormValues;

const fieldId = (key: FieldKey) => `source-${key}`;

export function SourceEditorSheet({ initial, isNew, source, busy = false, saveError = null, onSubmit, onClose }: SourceEditorSheetProps) {
  const [form, setForm] = useState<SourceFormValues>(initial);
  const [submitted, setSubmitted] = useState(false);
  // Server field messages, adopted whenever a new refusal arrives (adjusting
  // state during render, so no effect costs a second pass).
  const [seenSaveError, setSeenSaveError] = useState<SourceSaveError | null>(saveError);
  const [serverFields, setServerFields] = useState<SourceSaveError['fields']>(saveError?.fields ?? {});
  if (saveError !== seenSaveError) {
    setSeenSaveError(saveError);
    setServerFields(saveError?.fields ?? {});
  }
  // The disclosures the admin opened. A group holding an error is open
  // regardless: a collapsed message is a message nobody reads.
  const [opened, setOpened] = useState<Partial<Record<EditorGroup, boolean>>>({});
  const summaryRef = useRef<HTMLDivElement>(null);

  const testConnection = useTestConnection();
  const testResult =
    testConnection.data ??
    (testConnection.error
      ? { ok: false, message: (testConnection.error as unknown as ApiError | null)?.message ?? 'Could not reach that remote.' }
      : null);
  const errors = useMemo(() => validateSourceForm(form), [form]);
  const showHost = needsHost(form.mode);
  // The same registry `/content-types` serves Compose's type picker, so the
  // select can only offer a type the server's `default_type` check accepts.
  const { data: contentTypes = [] } = useContentTypes();
  // A stored type the list does not (yet) contain — still loading, or a label
  // that has since changed spelling — stays selectable rather than being
  // silently swapped for "no default" on the next save.
  const unlistedType = form.default_type && !contentTypes.some((t) => t.label === form.default_type) ? form.default_type : null;

  const set = <K extends FieldKey>(key: K, value: SourceFormValues[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // The server judged the old value; once it changes, the message is stale.
    if (serverFields[key]) {
      setServerFields((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  /** Every message currently shown: the form's own (after a save attempt) and the server's. */
  const visibleErrors = useMemo(() => {
    const out: Partial<Record<FieldKey, string>> = {};
    for (const key of Object.keys({ ...errors, ...serverFields }) as FieldKey[]) {
      const message = (submitted ? errors[key] : undefined) ?? serverFields[key];
      if (message) out[key] = message;
    }
    return out;
  }, [errors, serverFields, submitted]);
  const summary = errorSummary(visibleErrors);
  const errorFor = (key: FieldKey) => visibleErrors[key];

  const isOpen = (group: EditorGroup) => Boolean(opened[group]) || groupHasError(visibleErrors, group, form.mode);

  function setRemoteUrl(value: string) {
    set('remote_url', value);
    // A Test connection result describes the URL it tested; left beside a
    // different URL it would vouch for a remote nobody checked.
    if (!testConnection.isIdle) testConnection.reset();
  }

  function submit() {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      // Move focus to the list of what is wrong, so a keyboard user lands on it
      // rather than on a Save button that did nothing. After the render that
      // opens any collapsed group holding one of the errors.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    onSubmit(form);
  }

  function focusField(key: FieldKey) {
    const group = groupOfField(key, form.mode);
    if (group === 'selection' || group === 'advanced') setOpened((prev) => ({ ...prev, [group]: true }));
    requestAnimationFrame(() => document.getElementById(fieldId(key))?.focus());
  }

  // The refusal is announced in the sheet's footer, beside the button that was
  // pressed. A message the server tied to a field is already under that field
  // and in the summary at the top; the footer line says so.
  const footerError = saveError?.summary
    ? saveError.summary
    : summary.length > 0 && (saveError || submitted)
      ? 'Not saved — fix the fields listed above.'
      : saveError
        ? 'Not saved — change the form and try again.'
        : null;

  const hostTokenPresence = editorSecretPresence(source, 'host-token', form.host_token_env);
  const webhookPresence = editorSecretPresence(source, 'webhook-secret', form.webhook_secret_env);

  const webhookField = (
    <FormField
      label="Webhook secret env var"
      htmlFor={fieldId('webhook_secret_env')}
      error={errorFor('webhook_secret_env')}
      helper={<PresenceHelper present={webhookPresence} lead="The webhook is refused unless this variable is set on the server." />}
    >
      {(control) => (
        <input {...control} value={form.webhook_secret_env} onChange={(e) => set('webhook_secret_env', e.target.value)} placeholder="E3_WEBHOOK_SECRET" />
      )}
    </FormField>
  );

  return (
    <Sheet
      title={isNew ? 'Register a source' : `Edit ${initial.id}`}
      subtitle="One entry per repository working tree this instance indexes."
      width="lg"
      onClose={onClose}
      form={{
        isDirty: isSourceFormDirty(initial, form),
        isSaving: busy,
        // A new entry can always be attempted, so an empty Save explains what is
        // missing; an existing one has nothing to save until something changed.
        canSave: isNew || isSourceFormDirty(initial, form),
        submitLabel: isNew ? 'Register source' : 'Save source',
        onSubmit: submit,
        error: footerError,
      }}
    >
      {summary.length > 0 && (submitted || saveError) ? (
        <div className="Sources__errorSummary" ref={summaryRef} tabIndex={-1} aria-labelledby="source-error-summary-title">
          <p className="Sources__errorSummaryTitle" id="source-error-summary-title">
            {summary.length === 1 ? '1 field needs attention' : `${summary.length} fields need attention`}
          </p>
          <ul>
            {summary.map((entry) => (
              <li key={entry.field}>
                <button type="button" className="Sources__linkButton" onClick={() => focusField(entry.field)}>
                  {entry.label}
                </button>
                : {entry.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <FormSection title="Repository">
        <FormField
          label="Source id"
          htmlFor={fieldId('id')}
          required
          error={errorFor('id')}
          helper={isNew ? <>Use <code>main</code> or <code>topic:&lt;slug&gt;</code>.</> : 'The id cannot change once registered.'}
        >
          {(control) => (
            <input {...control} value={form.id} onChange={(e) => set('id', e.target.value)} readOnly={!isNew} placeholder="main or topic:my-topic" />
          )}
        </FormField>

        <FormField label="Enabled" htmlFor={fieldId('enabled')} helper="A disabled source keeps its entry but runs no sync.">
          {(control) => <input {...control} type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />}
        </FormField>

        <FormField
          label="Remote URL"
          htmlFor={fieldId('remote_url')}
          error={errorFor('remote_url')}
          helper="Optional. Pushes use the server's own SSH identity — no key is entered here."
        >
          {(control) => (
            <>
              <input {...control} value={form.remote_url} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="(local only — no remote)" />
              <div className="Sources__testRow">
                <button
                  type="button"
                  className="kp-admin-button"
                  disabled={!form.remote_url.trim() || testConnection.isPending}
                  onClick={() => testConnection.mutate(form.remote_url.trim())}
                >
                  {testConnection.isPending ? 'Testing…' : 'Test connection'}
                </button>
                {!form.remote_url.trim() ? <span className="Sources__muted">Enter a remote URL to test it.</span> : null}
                {testResult ? (
                  <span className={testResult.ok ? 'Sources__testOk' : 'Sources__fieldError'} role="status">
                    {testResult.message}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </FormField>

        <FormField label="Branch" htmlFor={fieldId('branch')} error={errorFor('branch')} helper="Blank uses the working tree's current branch.">
          {(control) => <input {...control} value={form.branch} onChange={(e) => set('branch', e.target.value)} placeholder="(current)" />}
        </FormField>

        <FormField
          label="Local working tree"
          htmlFor={fieldId('local_dir')}
          error={errorFor('local_dir')}
          helper={<>Blank uses <code>{defaultLocalDir(form.id.trim())}</code>. Two enabled sources cannot share one.</>}
        >
          {(control) => (
            <input {...control} value={form.local_dir} onChange={(e) => set('local_dir', e.target.value)} placeholder={defaultLocalDir(form.id.trim())} />
          )}
        </FormField>
      </FormSection>

      <FormSection title="Sync policy">
        <fieldset className="Sources__modes">
          <legend>Policy</legend>
          {MODE_OPTIONS.map((mode) => (
            <label className="Sources__mode" key={mode.value} data-checked={form.mode === mode.value ? 'true' : undefined}>
              <input
                type="radio"
                name="source-mode"
                value={mode.value}
                checked={form.mode === mode.value}
                onChange={() => set('mode', mode.value as SyncMode)}
              />
              <strong>{mode.label}</strong>
              <span className="Sources__modeWhy">{mode.explanation}</span>
              <span className="Sources__modeFits">Fits: {mode.fits}</span>
            </label>
          ))}
        </fieldset>

        <FormField label="Role" htmlFor={fieldId('role')} helper={ROLE_OPTIONS.find((r) => r.value === form.role)?.explanation}>
          {(control) => (
            <select {...control} value={form.role} onChange={(e) => set('role', e.target.value as SourceRole)}>
              {ROLE_OPTIONS.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </FormSection>

      {showHost ? (
        <FormSection title="Change-request host" description="Review mode opens a PR/MR through this host. Its token is read from the named environment variable on the server.">
          <FormField label="Host" htmlFor={fieldId('host_kind')} required error={errorFor('host_kind')}>
            {(control) => (
              <select {...control} value={form.host_kind} onChange={(e) => set('host_kind', e.target.value as '' | HostKind)}>
                <option value="">(choose a host)</option>
                {HOST_OPTIONS.map((host) => (
                  <option key={host.value} value={host.value}>
                    {host.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Host base URL" htmlFor={fieldId('host_base_url')} error={errorFor('host_base_url')} helper="Needed for a self-hosted host.">
            {(control) => (
              <input {...control} value={form.host_base_url} onChange={(e) => set('host_base_url', e.target.value)} placeholder="https://bitbucket.example.com" />
            )}
          </FormField>
          <FormField
            label="Host token env var"
            htmlFor={fieldId('host_token_env')}
            error={errorFor('host_token_env')}
            helper={<PresenceHelper present={hostTokenPresence} lead="The variable's name — never the token itself." />}
          >
            {(control) => (
              <input {...control} value={form.host_token_env} onChange={(e) => set('host_token_env', e.target.value)} placeholder="GITHUB_TOKEN" />
            )}
          </FormField>
          {webhookField}
        </FormSection>
      ) : null}

      <FormSection title="Which files this source indexes">
        <Disclosure
          open={isOpen('selection')}
          onToggle={(open) => setOpened((prev) => ({ ...prev, selection: open }))}
          summary={selectionSummary(form)}
        >
          <p className="Sources__muted">
            Leave both lists empty for the default — {DEFAULT_SELECTION_LABEL}. Include globs replace that layout with exactly the
            Markdown files they match; exclude globs are subtracted. One glob per line, relative to the repository root.{' '}
            <code>index.md</code>, <code>log.md</code> and anything under <code>assets/</code> are never items.
          </p>
          <FormField label="Include globs" htmlFor={fieldId('include_globs')} error={errorFor('include_globs')}>
            {(control) => (
              <textarea
                {...control}
                className="Sources__globs"
                value={form.include_globs}
                onChange={(e) => set('include_globs', e.target.value)}
                placeholder={'docs/**/*.md\nhandbook/*.md'}
                rows={4}
                spellCheck={false}
              />
            )}
          </FormField>
          <FormField label="Exclude globs" htmlFor={fieldId('exclude_globs')} error={errorFor('exclude_globs')}>
            {(control) => (
              <textarea
                {...control}
                className="Sources__globs"
                value={form.exclude_globs}
                onChange={(e) => set('exclude_globs', e.target.value)}
                placeholder={'docs/archive/**\ndocs/drafts/*.md'}
                rows={4}
                spellCheck={false}
              />
            )}
          </FormField>
          <FormField
            label="Default type for imported files"
            htmlFor={fieldId('default_type')}
            error={errorFor('default_type')}
            helper="Given to a file the include globs brought in whose frontmatter names no type. Files in the OKF layout keep their own."
          >
            {(control) => (
              <select {...control} value={form.default_type} onChange={(e) => set('default_type', e.target.value)}>
                <option value="">(none — the file's own type, or untyped)</option>
                {unlistedType ? <option value={unlistedType}>{unlistedType}</option> : null}
                {contentTypes.map((type) => (
                  <option key={type.key} value={type.label}>
                    {type.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </Disclosure>
      </FormSection>

      <Disclosure
        open={isOpen('advanced')}
        onToggle={(open) => setOpened((prev) => ({ ...prev, advanced: open }))}
        summary="Advanced"
        className="Sources__advanced"
      >
        <FormField
          label="Branch prefix"
          htmlFor={fieldId('branch_prefix')}
          error={errorFor('branch_prefix')}
          helper="Prefix for the per-item branches review mode opens."
        >
          {(control) => <input {...control} value={form.branch_prefix} onChange={(e) => set('branch_prefix', e.target.value)} placeholder="e3/" />}
        </FormField>
        <FormField
          label="Sync every (seconds)"
          htmlFor={fieldId('sync_every_seconds')}
          error={errorFor('sync_every_seconds')}
          helper="Blank uses the server default. At least 5."
        >
          {(control) => (
            <input
              {...control}
              value={form.sync_every_seconds}
              onChange={(e) => set('sync_every_seconds', e.target.value)}
              placeholder="(server default)"
              inputMode="numeric"
            />
          )}
        </FormField>
        <FormField label="Default status for inbound items" htmlFor={fieldId('default_status')} error={errorFor('default_status')}>
          {(control) => (
            <select {...control} value={form.default_status} onChange={(e) => set('default_status', e.target.value as '' | DefaultStatus)}>
              <option value="">(server default)</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </select>
          )}
        </FormField>
        {/* Direct and read-only sources can still take a webhook; under review it sits with the host. */}
        {showHost ? null : webhookField}
      </Disclosure>
    </Sheet>
  );
}

/** A native disclosure whose open state the editor controls (so a group holding an error can open itself). */
function Disclosure({
  open,
  onToggle,
  summary,
  className,
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details
      className={className ? `Sources__disclosure ${className}` : 'Sources__disclosure'}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onToggle(next);
      }}
    >
      <summary>{summary}</summary>
      <div className="Sources__disclosureBody">{children}</div>
    </details>
  );
}

/**
 * The helper under an env-var field: what the field is, and — for a saved
 * source whose variable name is unchanged — whether the server has it set.
 * Presence only; the value never reaches the browser.
 */
function PresenceHelper({ present, lead }: { present: boolean | undefined; lead: string }) {
  return (
    <span className="Sources__presence">
      {lead}
      {present === true ? <StatusChip tone="ok" size="sm" label="Set on this server" /> : null}
      {present === false ? <StatusChip tone="error" size="sm" label="Not set on this server" /> : null}
    </span>
  );
}
