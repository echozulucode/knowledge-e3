/**
 * Admin → Audit (plan §6 D1; the admin UX review §4.8).
 *
 * The questions an administrator arrives with get one control each: *who did
 * this* (Actor), *what was done to this account or thing* (Subject), *what
 * kind of change* (Action), *who changed this item* (Item), *what happened in
 * this window* (When). Every filter applies the moment it changes and lives in
 * the query string, so a finding is a link somebody can be sent and a reload
 * keeps it (features/audit/auditFilters.ts).
 *
 * Action codes are shown verbatim. They are the product's own vocabulary —
 * `source.upsert` is the thing that happened — and a prettified label would be a
 * second name for it that the log itself does not use. The sentence beside each
 * one is derived from the payload (auditSummary.ts); the payload itself is one
 * click away, exactly as the API returned it (already redacted server-side).
 *
 * Rows expand in place rather than opening a sheet: the detail is read next to
 * its neighbours, which is how a log is scanned. DataTable has no expandable
 * rows, so this page renders its own table with the same look and the same
 * table-to-cards switch at a 48rem container.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { OverflowMenu } from '../components/admin/OverflowMenu.js';
import { ReferencePicker } from '../components/admin/ReferencePicker.js';
import { pushToast } from '../hooks/useToast.js';
import {
  AUDIT_EXPORT_CAP,
  auditCsv,
  auditJson,
  downloadText,
  exportFilename,
} from '../features/audit/auditExport.js';
import {
  activeFilterChips,
  auditSearchToParams,
  groupActionCodes,
  readAuditSearch,
  withFilter,
  withoutFilter,
  type AuditFilters,
  type AuditRange,
} from '../features/audit/auditFilters.js';
import { RANGE_PRESETS, auditActor, exactLocal, exactUtc, shortWhen, utcOffsetLabel } from '../features/audit/auditModel.js';
import { auditSubject, summarizeAuditEntry } from '../features/audit/auditSummary.js';
import {
  fetchAuditRows,
  loadAuditItemOptions,
  loadAuditUserOptions,
  useAuditLog,
  type AuditItemOption,
  type AuditRecord,
  type AuditUserOption,
} from '../features/audit/queries.js';
import './AdminHome.css';
import './AdminAudit.css';

const COLUMN_COUNT = 4;

/** An absolute link to the page with these filters; what Copy link puts on the clipboard. */
function auditHref(filters: AuditFilters): string {
  const params = new URLSearchParams(Object.entries(auditSearchToParams(filters)).map(([k, v]) => [k, String(v)]));
  const qs = params.toString();
  return `${window.location.origin}/admin/audit${qs ? `?${qs}` : ''}`;
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    // `navigator.clipboard` is absent outside a secure context (plain http on a
    // LAN address), which is a real deployment of this product.
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    pushToast({ kind: 'success', message: done });
  } catch {
    pushToast({ kind: 'error', message: 'Copy failed. Check the browser clipboard permission and try again.' });
  }
}

function isInteractive(target: EventTarget | null, stop: Element): boolean {
  for (let el = target as Element | null; el && el !== stop; el = el.parentElement) {
    if (el.matches('a, button, input, select, textarea, pre, [role="button"]')) return true;
  }
  return false;
}

export function AdminAudit() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const filters = readAuditSearch(search);

  const go = (next: AuditFilters) => {
    void navigate({ to: '/admin/audit', search: auditSearchToParams(next) as never });
  };

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useAuditLog(filters);
  const pages = data?.pages ?? [];
  const entries = pages.flatMap((p) => p.entries);
  const actionGroups = groupActionCodes(pages[0]?.actions ?? [], filters.action);
  const forbidden = (error as { statusCode?: number } | null)?.statusCode === 403;
  const chips = activeFilterChips(filters);

  // Open rows. A link to one entry opens on that entry's detail.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set(filters.entry ? [Number(filters.entry)] : []));
  useEffect(() => {
    if (filters.entry) setExpanded((prev) => new Set([...prev, Number(filters.entry)]));
  }, [filters.entry]);
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [exporting, setExporting] = useState(false);
  const runExport = async (format: 'json' | 'csv') => {
    setExporting(true);
    try {
      const at = new Date();
      const { entries: rows, capped } = await fetchAuditRows(filters, AUDIT_EXPORT_CAP);
      const name = exportFilename(format, at);
      if (format === 'csv') downloadText(name, auditCsv(rows), 'text/csv;charset=utf-8');
      else downloadText(name, auditJson(rows, { exportedAt: at.toISOString(), filters, capped }), 'application/json');
      pushToast(
        capped
          ? {
              kind: 'info',
              message: `Exported the newest ${AUDIT_EXPORT_CAP.toLocaleString('en-US')} entries, the export limit. Narrow the filters to export the rest.`,
            }
          : { kind: 'success', message: `Exported ${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'entry' : 'entries'}.` },
      );
    } catch {
      pushToast({ kind: 'error', message: 'The export could not be built. Try again.' });
    } finally {
      setExporting(false);
    }
  };

  const rangeValue: AuditRange = filters.range;

  const toolbar = (
    <div className="AdminAudit__filters" role="search" aria-label="Audit filters">
      <div className="AdminAudit__field">
        <label htmlFor="audit-actor">Actor</label>
        <ReferencePicker<AuditUserOption>
          id="audit-actor"
          loadOptions={loadAuditUserOptions}
          getKey={(u) => u.username}
          getLabel={(u) => u.username}
          emptyOption={{ label: 'Anyone' }}
          placeholder="Anyone"
          value={filters.actor ?? ''}
          onChange={(key) => go(withFilter(filters, { actor: key || undefined }))}
          testId="audit-actor"
        />
      </div>
      <div className="AdminAudit__field">
        <label htmlFor="audit-action">Action</label>
        <select
          id="audit-action"
          className="AdminAudit__select"
          value={filters.action ?? ''}
          onChange={(e) => go(withFilter(filters, { action: e.target.value || undefined }))}
        >
          <option value="">All actions</option>
          {actionGroups.map((group) => (
            <optgroup key={group.prefix} label={group.prefix}>
              {group.codes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="AdminAudit__field">
        <label htmlFor="audit-subject">Subject</label>
        <ReferencePicker<AuditUserOption>
          id="audit-subject"
          loadOptions={loadAuditUserOptions}
          getKey={(u) => u.username}
          getLabel={(u) => u.username}
          emptyOption={{ label: 'Any account or thing' }}
          placeholder="Any account or thing"
          value={filters.subject ?? ''}
          onChange={(key) => go(withFilter(filters, { subject: key || undefined }))}
          testId="audit-subject"
        />
      </div>
      <div className="AdminAudit__field">
        <label htmlFor="audit-item">Item</label>
        <ReferencePicker<AuditItemOption>
          id="audit-item"
          loadOptions={loadAuditItemOptions}
          getKey={(i) => i.id}
          getLabel={(i) => i.title}
          emptyOption={{ label: 'Any item' }}
          placeholder="Any item"
          value={filters.item ?? ''}
          onChange={(key) => go(withFilter(filters, { item: key || undefined }))}
          testId="audit-item"
        />
      </div>
      <div className="AdminAudit__field">
        <label htmlFor="audit-range">When</label>
        <select
          id="audit-range"
          className="AdminAudit__select"
          value={rangeValue}
          onChange={(e) => go(withFilter(filters, { range: e.target.value as AuditRange }))}
        >
          <option value="all">All time</option>
          {RANGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
      </div>
      {filters.range === 'custom' ? (
        <>
          <div className="AdminAudit__field">
            <label htmlFor="audit-since">From</label>
            {/* From/To are this browser's days, and the table's times are this
                browser's times; naming the zone keeps "Sep 11" from being read as UTC. */}
            <input
              id="audit-since"
              type="date"
              className="AdminAudit__select"
              aria-describedby="audit-tz"
              value={filters.since ?? ''}
              max={filters.until}
              onChange={(e) => go(withFilter(filters, { since: e.target.value || undefined }))}
            />
          </div>
          <div className="AdminAudit__field">
            <label htmlFor="audit-until">To</label>
            <input
              id="audit-until"
              type="date"
              className="AdminAudit__select"
              aria-describedby="audit-tz"
              value={filters.until ?? ''}
              min={filters.since}
              onChange={(e) => go(withFilter(filters, { until: e.target.value || undefined }))}
            />
          </div>
        </>
      ) : null}
    </div>
  );

  const shown = entries.length;

  return (
    <main className="AdminHome AdminAudit" aria-labelledby="admin-audit-title">
      <AdminPageHeader
        titleId="admin-audit-title"
        title="Audit"
        description="Who changed what, and when."
        meta={<span id="audit-tz">Times in your timezone ({utcOffsetLabel()})</span>}
        secondaryActions={
          <>
            <button type="button" className="kp-admin-button" onClick={() => void copyText(auditHref(filters), 'Link copied.')}>
              Copy link
            </button>
            <OverflowMenu
              label="Export"
              buttonText={exporting ? 'Exporting…' : 'Export'}
              disabled={exporting || forbidden}
              items={[
                { id: 'json', label: 'Export as JSON', onSelect: () => void runExport('json') },
                { id: 'csv', label: 'Export as CSV', onSelect: () => void runExport('csv') },
              ]}
            />
          </>
        }
      />

      {toolbar}

      {chips.length > 0 ? (
        <div className="AdminAudit__active" aria-label="Active filters" role="group">
          <span className="AdminAudit__activeLabel">Active:</span>
          <ul className="AdminAudit__chips">
            {chips.map((chip) => (
              <li key={chip.key}>
                <button
                  type="button"
                  className="AdminAudit__chip"
                  aria-label={`Remove ${chip.label} filter: ${chip.value}`}
                  onClick={() => go(withoutFilter(filters, chip.key))}
                >
                  <span>
                    {chip.label}: <strong>{chip.value}</strong>
                  </span>
                  <span aria-hidden="true">✕</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="AdminAudit__clear" onClick={() => go({ range: 'all' })}>
            Clear all
          </button>
        </div>
      ) : null}

      <section className="AdminAudit__list" aria-label="Audit entries">
        {isError ? (
          <div className="AdminAudit__message" role="alert">
            <p>{forbidden ? 'The audit log is available to administrators only.' : 'Could not load the audit log.'}</p>
            {forbidden ? null : (
              <button type="button" className="kp-admin-button" onClick={() => void refetch()}>
                Retry
              </button>
            )}
          </div>
        ) : isLoading ? (
          <p className="AdminAudit__message" role="status">
            Loading the audit log…
          </p>
        ) : shown === 0 ? (
          chips.length > 0 ? (
            <EmptyState
              title="No entries match"
              body="Widen the date range, or remove a filter."
              action={
                <button type="button" className="kp-admin-button" onClick={() => go({ range: 'all' })}>
                  Clear all filters
                </button>
              }
            />
          ) : (
            <EmptyState title="No audit entries yet" body="Sign-ins, account changes, configuration and content changes appear here." />
          )
        ) : (
          <>
            <div className="AdminAudit__scroll">
              <table className="AdminAudit__table">
                <caption className="AdminAudit__vh">Audit entries, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Summary</th>
                  </tr>
                </thead>
                {entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    open={expanded.has(entry.id)}
                    onToggle={() => toggle(entry.id)}
                    onFilter={(patch) => go(withFilter(filters, patch))}
                  />
                ))}
              </table>
            </div>
            <div className="AdminAudit__footer">
              <span aria-live="polite">
                Showing {shown.toLocaleString('en-US')} {shown === 1 ? 'entry' : 'entries'}
              </span>
              {hasNextPage ? (
                <button type="button" className="kp-admin-button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? 'Loading…' : 'Load older'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

interface AuditRowProps {
  entry: AuditRecord;
  open: boolean;
  onToggle: () => void;
  onFilter: (patch: Partial<AuditFilters>) => void;
}

function AuditRow({ entry, open, onToggle, onFilter }: AuditRowProps): JSX.Element {
  const actor = auditActor(entry);
  const summary = summarizeAuditEntry(entry);
  const detailId = `audit-entry-${entry.id}`;

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (isInteractive(event.target, event.currentTarget)) return;
    // Selecting text to copy an IP or a name is not an intent to expand.
    if (window.getSelection()?.toString()) return;
    onToggle();
  };

  return (
    <tbody className="AdminAudit__entry" data-open={open || undefined}>
      <tr className="AdminAudit__row" onClick={onRowClick}>
        <td data-label="When" className="AdminAudit__when">
          <button type="button" className="AdminAudit__toggle" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className="AdminAudit__chevron">
              <path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <time dateTime={entry.occurred_at} title={exactLocal(entry.occurred_at)}>
              {shortWhen(entry.occurred_at)}
            </time>
          </button>
        </td>
        <td data-label="Actor" className={`AdminAudit__actor AdminAudit__actor--${actor.kind}`}>
          {actor.label}
        </td>
        <td data-label="Action">
          <code className="AdminAudit__code">{entry.action}</code>
        </td>
        <td data-label="Summary" className="AdminAudit__summary">
          {summary || <span className="AdminAudit__muted">—</span>}
        </td>
      </tr>
      {open ? (
        <tr className="AdminAudit__detailRow">
          <td colSpan={COLUMN_COUNT} id={detailId}>
            <AuditDetail entry={entry} onFilter={onFilter} />
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function AuditDetail({ entry, onFilter }: { entry: AuditRecord; onFilter: (patch: Partial<AuditFilters>) => void }): JSX.Element {
  const actor = auditActor(entry);
  const subject = auditSubject(entry);
  const json = entry.payload === null || entry.payload === undefined ? null : JSON.stringify(entry.payload, null, 2);
  const actorKey = actor.kind === 'user' ? actor.username : actor.kind === 'deleted' ? actor.id : null;

  return (
    <div className="AdminAudit__detail" aria-label={`Entry ${entry.id} details`} role="region">
      <dl className="AdminAudit__facts">
        <div>
          <dt>Actor</dt>
          <dd>
            <span>{actor.kind === 'deleted' ? `deleted account (${actor.id})` : actor.label}</span>
            {actorKey ? (
              <button type="button" className="AdminAudit__inline" onClick={() => onFilter({ actor: actorKey })}>
                Filter by actor
              </button>
            ) : null}
          </dd>
        </div>
        {subject ? (
          <div>
            <dt>Subject</dt>
            <dd>
              <span>{subject.label}</span>
              <button type="button" className="AdminAudit__inline" onClick={() => onFilter({ subject: subject.value })}>
                Filter by subject
              </button>
            </dd>
          </div>
        ) : null}
        {entry.page_id ? (
          <div>
            <dt>Item</dt>
            <dd>
              {/* A hard-deleted target has no slug left to link to; the id is
                  still the honest answer to "which item was this". */}
              {entry.page_slug ? (
                <Link to="/p/$slug" params={{ slug: entry.page_slug }} className="AdminAudit__link">
                  {entry.page_title ?? entry.page_slug}
                </Link>
              ) : (
                <code className="AdminAudit__code">{entry.page_id}</code>
              )}
              <button type="button" className="AdminAudit__inline" onClick={() => onFilter({ item: entry.page_id! })}>
                Filter by item
              </button>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>When</dt>
          <dd>
            <time dateTime={entry.occurred_at}>
              {exactLocal(entry.occurred_at)} ({exactUtc(entry.occurred_at)})
            </time>
          </dd>
        </div>
      </dl>
      <div className="AdminAudit__payloadHead">
        <span>Payload</span>
        <div className="AdminAudit__payloadActions">
          {json ? (
            <button type="button" className="AdminAudit__inline" onClick={() => void copyText(json, 'Payload JSON copied.')}>
              Copy JSON
            </button>
          ) : null}
          <button
            type="button"
            className="AdminAudit__inline"
            onClick={() => void copyText(auditHref({ range: 'all', entry: String(entry.id) }), 'Link to this entry copied.')}
          >
            Copy link
          </button>
        </div>
      </div>
      {json ? (
        <pre className="AdminAudit__json" tabIndex={0} aria-label="Payload JSON">
          {json}
        </pre>
      ) : (
        <p className="AdminAudit__muted">No payload.</p>
      )}
    </div>
  );
}
