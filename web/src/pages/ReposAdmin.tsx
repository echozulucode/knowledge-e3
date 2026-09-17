/**
 * Sources — Admin → the source registry (plan §7.4; the admin UX review §4.4).
 * Admin-only; the server enforces it (403).
 *
 * One row per repository working tree this instance indexes: `main` (which
 * hosts many topics as subtrees) or `topic:<slug>` for a topic bound to its own
 * repo. The list answers "is anything stuck?" at a glance — an attention strip
 * over the table, a state chip per row, the age of the last sync — and every
 * deeper question opens a sheet:
 *
 *   ?source=<id>[&tab=conflicts|reviews|selection]  the detail sheet
 *   ?edit=<id>  /  ?new=1                              the editor sheet
 *   ?q= &state= &policy= &role=                        the list filters
 *
 * All of it lives in the address bar so System health, the Overview or a
 * colleague can link to "topic:ops, Conflicts tab" directly.
 *
 * Credentials are never entered here — pushes use the host's ambient SSH
 * identity, and host tokens are named by environment variable.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { usePullRepo } from '../queries.js';
import { pushToast } from '../hooks/useToast.js';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { Sheet } from '../components/admin/Sheet.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { useEscapeLayer } from '../components/admin/useEscapeLayer.js';
import { Icon, appIcons } from '../icons.js';
import { SourceDetailSheet } from '../features/sources/SourceDetailSheet.js';
import { SourceEditorSheet } from '../features/sources/SourceForm.js';
import { mapSourceSaveError, type SourceSaveError } from '../features/sources/saveError.js';
import { useRemoveSource, useSources, useSyncSource, usePushSource, useUpsertSource } from '../features/sources/queries.js';
import {
  MODE_OPTIONS,
  ROLE_OPTIONS,
  describeSelection,
  emptySourceForm,
  formFromSource,
  formToUpsert,
  formatSyncedAt,
  stateChipTitle,
  type SourceForm as SourceFormValues,
} from '../features/sources/sourceModel.js';
import {
  NO_FILTERS,
  STATE_FILTERS,
  attentionHeadline,
  attentionItems,
  filterSources,
  formatAge,
  hasFilters,
  isEnabled,
  lastSyncedAt,
  pollInterval,
  readSourcesSearch,
  stateRank,
  sourceStateChip,
  stateTone,
  writeSourcesSearch,
  type SheetTabId,
  type SourcesSearch,
  type StateFilter,
} from '../features/sources/sourcesAdminModel.js';
import type { ApiError } from '../api.js';
import type { SourceRole, SourceStatusView, SyncMode } from '../features/sources/types.js';
import '../features/sources/Sources.css';
import './ReposAdmin.css';

export function ReposAdmin() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = readSourcesSearch(useSearch({ strict: false }) as Record<string, unknown> | undefined);

  /** Ids with a Sync or Push this browser started and has not heard back from. */
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const { data: sources = [], isLoading, isError, error, refetch } = useSources({
    refetchInterval: (list) => pollInterval(list, running.size > 0),
  });
  const upsert = useUpsertSource();
  const remove = useRemoveSource();
  const sync = useSyncSource();
  const push = usePushSource();
  const pull = usePullRepo();

  /** The editor's own refusal: rendered inside the sheet, never over the list. */
  const [saveError, setSaveError] = useState<SourceSaveError | null>(null);
  /** The source whose removal is being confirmed, and why the last attempt failed. */
  const [removing, setRemoving] = useState<SourceStatusView | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The id "Set up the main repository" pre-fills; not worth a URL parameter.
  const [newId, setNewId] = useState('');

  const hasMain = sources.some((s) => s.id === 'main');
  const attention = useMemo(() => attentionItems(sources), [sources]);
  const filters = { q: search.q, state: search.state, policy: search.policy, role: search.role };
  const visible = useMemo(
    () => filterSources(sources, filters),
    // `filters` is rebuilt every render; its four values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, filters.q, filters.state, filters.policy, filters.role],
  );
  const byId = (id: string | null) => (id ? (sources.find((s) => s.id === id) ?? null) : null);

  // ----------------------------------------------------------- URL state

  function go(patch: Partial<SourcesSearch>, replace = false) {
    void navigate({ to: pathname, search: writeSourcesSearch({ ...search, ...patch }) as never, replace });
  }
  const setFilter = (patch: Partial<SourcesSearch>) => go(patch, true);
  // The search box keeps its own text: bound straight to the URL, a keystroke
  // typed before the previous navigation settled would be overwritten. The URL
  // still wins when it changes from elsewhere (Clear filters, Back).
  const [query, setQuery] = useState(search.q);
  const [urlQuery, setUrlQuery] = useState(search.q);
  if (search.q !== urlQuery) {
    setUrlQuery(search.q);
    // Our own navigation arriving is not a change from elsewhere.
    if (search.q !== query.trim()) setQuery(search.q);
  }
  const openSource = (id: string, tab: SheetTabId | null = null) => go({ source: id, tab, edit: null, isNew: false });
  const closeSheets = () => go({ source: null, tab: null, edit: null, isNew: false });

  function openNew(id = '') {
    setSaveError(null);
    setNewId(id);
    go({ isNew: true, edit: null, source: null, tab: null });
  }
  /** `fromDetail` keeps `source` under the editor, so closing it returns to the detail sheet. */
  function openEdit(source: SourceStatusView, fromDetail = false) {
    setSaveError(null);
    go({ edit: source.id, isNew: false, ...(fromDetail ? {} : { source: null, tab: null }) });
  }
  function closeEditor() {
    setSaveError(null);
    go({ edit: null, isNew: false });
  }

  // ------------------------------------------------------------- actions

  async function runOn(id: string, work: () => Promise<unknown>, ok: string, failed: string) {
    setRunning((prev) => new Set(prev).add(id));
    try {
      await work();
      pushToast({ kind: 'success', message: ok });
    } catch (err) {
      pushToast({ kind: 'error', message: (err as ApiError | null)?.message ?? failed });
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const syncNow = (source: SourceStatusView) =>
    void runOn(source.id, () => sync.mutateAsync(source.id), `Ran a sync cycle for ${source.id}.`, `Could not sync ${source.id}.`);

  /**
   * Save the editor. A refused save keeps the sheet open, its fields intact,
   * and the message beside the field the server named — or in the footer
   * (review §2 #6). A saved one lands on that source's detail sheet.
   */
  async function save(form: SourceFormValues): Promise<void> {
    const id = form.id.trim();
    setSaveError(null);
    try {
      await upsert.mutateAsync({ id, input: formToUpsert(form) });
    } catch (err) {
      setSaveError(mapSourceSaveError(err));
      return;
    }
    pushToast({ kind: 'success', message: 'Source saved' });
    // Wait for the list to hold the saved row, so the detail sheet opens on it
    // rather than on "No such source" for a new id.
    await refetch();
    openSource(id);
  }

  function askRemove(source: SourceStatusView) {
    setRemoveError(null);
    setRemoving(source);
  }
  function cancelRemove() {
    if (remove.isPending) return;
    setRemoving(null);
    setRemoveError(null);
  }
  // Remove can be opened from the detail sheet's menu; Esc then closes only the dialog.
  useEscapeLayer(removing !== null, cancelRemove);

  /**
   * Removing a source is typed-confirmation territory (review §3.3): it ends
   * indexing for a whole repository, and the row is gone from this page the
   * moment it succeeds. A failure stays in the dialog, beside the button.
   */
  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    const id = removing.id;
    setRemoveError(null);
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setRemoveError((err as ApiError | null)?.message ?? 'The source was not removed.');
      return;
    }
    setRemoving(null);
    if (search.source === id || search.edit === id) closeSheets();
    pushToast({ kind: 'success', message: `Removed ${id}.` });
  }

  /** The `⋯` items shared by the row and the detail sheet. Disabled items say why, in text. */
  function menuItems(source: SourceStatusView, opts: { withEdit: boolean; fromDetail?: boolean }): OverflowMenuItem[] {
    const busy = running.has(source.id);
    const items: OverflowMenuItem[] = [
      {
        id: 'push',
        label: 'Push now',
        onSelect: () =>
          void runOn(source.id, () => push.mutateAsync(source.id), `Pushed ${source.id}.`, `Could not push ${source.id}.`),
        ...(!source.remote_url
          ? { disabledReason: 'This source has no remote' }
          : source.mode === 'read-only'
            ? { disabledReason: 'Read-only sources never push' }
            : busy
              ? { disabledReason: 'A sync or push is already running' }
              : {}),
      },
    ];
    if (source.space_id) {
      const spaceId = source.space_id;
      items.push({
        id: 'pull',
        label: 'Pull into topic',
        onSelect: () => void runOn(source.id, () => pull.mutateAsync(spaceId), `Pulled ${source.id} into its topic.`, `Could not pull ${source.id}.`),
        ...(busy ? { disabledReason: 'A sync or push is already running' } : {}),
      });
    }
    if (opts.withEdit) items.push({ id: 'edit', label: 'Edit…', onSelect: () => openEdit(source, opts.fromDetail) });
    items.push({ id: 'remove', label: 'Remove…', danger: true, separatorBefore: true, onSelect: () => askRemove(source) });
    return items;
  }

  // --------------------------------------------------------------- table

  const columns: DataTableColumn<SourceStatusView>[] = [
    {
      id: 'source',
      header: 'Source',
      primary: true,
      sortValue: (s) => s.id,
      cell: (s) => {
        const selection = describeSelection(s);
        return (
          <span className="ReposAdmin__source">
            <span className="ReposAdmin__sourceLine">
              <span className="ReposAdmin__sourceId">{s.id}</span>
              {/*
                A1: a source that selects by glob indexes something other than
                the OKF layout, and the row is the first place an admin would
                otherwise mistake it for an ordinary bundle.
              */}
              {selection.selective ? (
                <span className="Sources__chip" data-kind="selection" title={selection.title}>
                  Selective
                </span>
              ) : null}
              {!isEnabled(s) ? (
                <span className="Sources__chip" data-kind="disabled">
                  disabled
                </span>
              ) : null}
            </span>
            <span className="ReposAdmin__remote Sources__mono">{s.remote_url ?? 'local only'}</span>
          </span>
        );
      },
    },
    {
      id: 'policy',
      header: 'Policy',
      sortValue: (s) => `${s.mode} ${s.role}`,
      cell: (s) => (
        <span data-kind="policy">
          {MODE_OPTIONS.find((m) => m.value === s.mode)?.label ?? s.mode} · {ROLE_OPTIONS.find((r) => r.value === s.role)?.label ?? s.role}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      sortValue: stateRank,
      cell: (s) => {
        const chip = sourceStateChip(s);
        return <StatusChip tone={stateTone(chip)} size="sm" label={chip.label} title={stateChipTitle(chip)} />;
      },
    },
    {
      id: 'synced',
      header: 'Synced',
      hideBelow: 'md',
      sortValue: (s) => lastSyncedAt(s) ?? '',
      cell: (s) => {
        const at = lastSyncedAt(s);
        return <span title={at ? formatSyncedAt(at) : undefined}>{formatAge(at)}</span>;
      },
    },
    {
      id: 'sync',
      header: 'Sync',
      align: 'end',
      cell: (s) => {
        const busy = running.has(s.id);
        return (
          <button
            type="button"
            className="kp-admin-button ReposAdmin__syncButton"
            disabled={busy || !s.remote_url}
            // The Source column already reads "local only" beside this button:
            // that is the visible reason it is disabled.
            title={s.remote_url ? `Fetch, merge and index ${s.id} now` : 'This source has no remote'}
            aria-label={busy ? `Syncing ${s.id}` : undefined}
            onClick={() => syncNow(s)}
          >
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        );
      },
    },
  ];

  const filtered = hasFilters(filters);
  const toolbar = (
    <div className="ReposAdmin__toolbar" role="search" aria-label="Filter sources">
      <label className="ReposAdmin__filter ReposAdmin__filter--search">
        <span>Search</span>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFilter({ q: e.target.value });
          }}
          placeholder="Search id, remote, working tree…"
        />
      </label>
      <label className="ReposAdmin__filter">
        <span>State</span>
        <select value={search.state} onChange={(e) => setFilter({ state: e.target.value as StateFilter })}>
          {STATE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ReposAdmin__filter">
        <span>Policy</span>
        <select value={search.policy} onChange={(e) => setFilter({ policy: e.target.value as '' | SyncMode })}>
          <option value="">All</option>
          {MODE_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ReposAdmin__filter">
        <span>Role</span>
        <select value={search.role} onChange={(e) => setFilter({ role: e.target.value as '' | SourceRole })}>
          <option value="">All</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <span className="ReposAdmin__count" aria-live="polite">
        {filtered ? `${visible.length} of ${sources.length} sources` : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`}
      </span>
      {filtered ? (
        <button type="button" className="kp-admin-button" onClick={() => setFilter(NO_FILTERS)}>
          Clear filters
        </button>
      ) : null}
    </div>
  );

  const addButton = (
    <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => openNew()}>
      <Icon icon={appIcons.plus} /> Add source
    </button>
  );

  const empty =
    sources.length === 0 ? (
      <EmptyState
        title="No sources yet"
        body="Add one to index a repository working tree — a remote is optional."
        action={
          <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => openNew(hasMain ? '' : 'main')}>
            <Icon icon={appIcons.plus} /> {hasMain ? 'Add source' : 'Set up the main repository'}
          </button>
        }
      />
    ) : (
      <EmptyState
        title="No sources match"
        body="Nothing matches these filters."
        action={
          <button type="button" className="kp-admin-button" onClick={() => setFilter(NO_FILTERS)}>
            Clear filters
          </button>
        }
      />
    );

  // -------------------------------------------------------------- sheets

  const editing = byId(search.edit);
  const detail = search.edit || search.isNew ? null : byId(search.source);
  /** A sheet was asked for by URL but the list (now loaded) has no such source. */
  const missingId = !isLoading && !isError ? (search.edit && !editing ? search.edit : !search.edit && !search.isNew && search.source && !detail ? search.source : null) : null;

  const forbidden = (error as ApiError | null)?.statusCode === 403;

  return (
    <main className="ReposAdmin" aria-labelledby="sources-admin-title">
      <AdminPageHeader
        titleId="sources-admin-title"
        title="Sources"
        description="Every repository working tree this instance indexes, with its sync policy and live state."
        meta={isLoading || isError ? undefined : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`}
        learnMore={
          <details>
            <summary>How this works</summary>
            <p>
              <strong>main</strong> hosts topics as subfolders; <strong>topic:&lt;slug&gt;</strong> binds one topic to
              its own repository. Each entry carries a <strong>sync policy</strong> — direct, review, or read-only — and
              a role. <strong>Keys are never entered here</strong>: pushes use the server's ambient SSH identity and host
              tokens are named by environment variable. State refreshes every 10 seconds while a sync runs, every minute
              otherwise.
            </p>
          </details>
        }
        secondaryActions={
          !hasMain && !isLoading && !isError ? (
            <button type="button" className="kp-admin-button" onClick={() => openNew('main')}>
              Set up the main repository
            </button>
          ) : null
        }
        primaryAction={addButton}
      />

      {attention.length > 0 ? (
        <section className="ReposAdmin__attention" aria-labelledby="sources-attention-title">
          <p className="ReposAdmin__attentionTitle" id="sources-attention-title">
            <Icon icon={appIcons.triangleExclamation} /> {attentionHeadline(attention)}:
          </p>
          <ul className="ReposAdmin__attentionList">
            {attention.map((item) => (
              <li key={`${item.sourceId}:${item.reason}`}>
                <button
                  type="button"
                  className="ReposAdmin__attentionItem"
                  data-attention={item.reason}
                  onClick={() => openSource(item.sourceId, item.tab)}
                >
                  <span className="Sources__mono">{item.sourceId}</span> — {item.label}
                </button>
              </li>
            ))}
          </ul>
          {search.state !== 'attention' ? (
            <button type="button" className="kp-admin-button ReposAdmin__attentionShow" onClick={() => setFilter({ state: 'attention' })}>
              Show only these
            </button>
          ) : null}
        </section>
      ) : null}

      <DataTable
        rows={visible}
        rowKey={(s) => s.id}
        columns={columns}
        caption="Registered sources"
        state={isError ? 'error' : isLoading ? 'loading' : 'ready'}
        errorMessage={forbidden ? 'Admin access required.' : `Could not load the registry. ${(error as ApiError | null)?.message ?? ''}`.trim()}
        onRetry={forbidden ? undefined : () => void refetch()}
        empty={empty}
        onRowOpen={(s) => openSource(s.id)}
        rowLabel={(s) => s.id}
        rowActions={(s) => menuItems(s, { withEdit: true })}
        selectedKey={search.source}
        toolbar={sources.length > 0 ? toolbar : undefined}
      />

      {detail ? (
        <SourceDetailSheet
          source={detail}
          tab={search.tab}
          onTabChange={(tab) => go({ tab }, true)}
          onClose={closeSheets}
          onEdit={() => openEdit(detail, true)}
          onSync={() => syncNow(detail)}
          syncing={running.has(detail.id)}
          menuItems={menuItems(detail, { withEdit: false })}
        />
      ) : null}

      {search.isNew ? (
        <SourceEditorSheet
          key="new"
          initial={{ ...emptySourceForm(), id: newId }}
          isNew
          busy={upsert.isPending}
          saveError={saveError}
          onSubmit={(form) => void save(form)}
          onClose={closeEditor}
        />
      ) : editing ? (
        <SourceEditorSheet
          key={`edit-${editing.id}`}
          initial={formFromSource(editing)}
          isNew={false}
          source={editing}
          busy={upsert.isPending}
          saveError={saveError}
          onSubmit={(form) => void save(form)}
          onClose={closeEditor}
        />
      ) : null}

      {missingId ? (
        <Sheet title={missingId} onClose={closeSheets}>
          <EmptyState title="No such source" body={<>No source with the id <code>{missingId}</code> is registered. It may have been removed.</>} />
        </Sheet>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.id}?`}
          body={
            <>
              Stops indexing <code>{removing.id}</code>: its registry entry is deleted and its scheduled sync ends. Files
              on disk and the remote repository are untouched.
            </>
          }
          // What `DELETE /admin/sources/:id` does and does not do: the row and
          // its engine go; no page, file, or remote is touched.
          consequences={['Items already indexed from it are not deleted.']}
          confirmLabel="Remove source"
          tone="danger"
          requireText={removing.id}
          pending={remove.isPending}
          error={removeError}
          onConfirm={() => void confirmRemove()}
          onCancel={cancelRemove}
        />
      ) : null}
    </main>
  );
}
