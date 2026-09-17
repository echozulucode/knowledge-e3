/**
 * ContentHealth — Admin → Health → Content (plan §6.3, the admin UX review §4.9).
 *
 * Reads top to bottom in the order an admin acts: what needs attention now; the
 * audit findings (tiles that link to the library audit's one home, Data → Audit —
 * review §6 decision 4); the library counts, quieter and apart; the fix-it
 * queues, with the clear ones folded into one line and the selected one as a
 * paged table; then the instance-wide sections (Sync, Git mirror, Refusals),
 * which the topic filter does not narrow and which say so.
 *
 * Topic, selected queue and page live in the query string, so a filtered view is
 * a link. Admin-only: like the other admin pages, the server enforces it (403).
 */
import { useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ContentTypeBadge } from '@echozedlabs/ui';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader.js';
import { DataTable, type DataTableColumn } from '../../components/admin/DataTable.js';
import { EmptyState } from '../../components/admin/EmptyState.js';
import { Freshness } from '../../components/admin/Freshness.js';
import { StatusChip, StatusIcon } from '../../components/admin/StatusChip.js';
import { useTopics } from '../../queries.js';
import type { ApiError } from '../../api.js';
import {
  QUEUE_LABELS,
  QUEUE_PAGE_SIZE,
  useContentHealth,
  useContentHealthQueue,
  useRecentRefusals,
  type ContentHealthReport,
  type HealthQueueItem,
  type QueueName,
} from './queries.js';
import {
  MIRROR_STATE_HINTS,
  MIRROR_STATE_LABELS,
  formatAge,
  formatThreshold,
  itemLabel,
  mirrorAlert,
  mirrorDiagnosticsText,
  type MirrorErrorItem,
  type MirrorHealth,
  type StuckOutboxItem,
} from './mirrorHealth.js';
import { REFUSED_ACTION, refusalAttempt, rulesText, toRefusalRow, type RefusalRow } from './refusals.js';
import { QUEUE_RUNBOOK, RUNBOOK, runbookAddress, runbookHint, type RunbookSection } from './runbook.js';
import { lintDetailOf, moreDiagnosticsText } from './lintQueue.js';
import { queueRowLink } from './queueRowLink.js';
import {
  MIRROR_SECTION_ID,
  attentionHeadline,
  buildHealthAttention,
  clearQueuesText,
  contentHealthSearchToParams,
  findingTiles,
  queueItemSource,
  queueOverview,
  queuePageCount,
  queuePageRange,
  readContentHealthSearch,
  recentRefusals,
  selectedQueue,
  type ContentHealthSearch,
  type HealthAttentionItem,
} from './ContentHealth.model.js';
import './ContentHealth.css';

const QUEUES_SECTION_ID = 'content-health-queues';

/**
 * Where the runbook answers this alert (plan B5). The document is organised by
 * symptom and is already the right answer; the product simply never said so.
 * The address is text, not a link — nothing serves `docs/` (see `runbook.ts`).
 */
function RunbookPointer({ section }: { section: RunbookSection }) {
  return (
    <p className="ContentHealth__runbook">
      <strong>What to do:</strong> runbook §{section.number} — {section.title}{' '}
      <code>{runbookAddress(section)}</code>
    </p>
  );
}

/* --------------------------------------------------------------- attention */

function AttentionStrip({ items, search }: { items: HealthAttentionItem[]; search: ContentHealthSearch }) {
  const clear = items.length === 0;
  return (
    <section className="ContentHealth__attention" aria-labelledby="content-health-attention" data-tone={clear ? 'ok' : items[0]!.tone}>
      <h2 id="content-health-attention">
        <StatusIcon tone={clear ? 'ok' : items[0]!.tone === 'alert' ? 'error' : 'warn'} />
        {attentionHeadline(items.length)}
      </h2>
      {clear ? null : (
        <ul className="ContentHealth__attentionList">
          {items.map((item) => (
            <li key={item.id} data-attention={item.id} data-tone={item.tone}>
              <StatusIcon tone={item.tone === 'alert' ? 'error' : 'warn'} />
              <span className="ContentHealth__vh">{item.tone === 'alert' ? 'Alert: ' : 'Warning: '}</span>
              {item.target.kind === 'route' ? (
                <Link to={item.target.to as never} search={item.target.search as never}>
                  {item.label}
                </Link>
              ) : item.target.kind === 'queue' ? (
                <Link
                  to="/admin/health"
                  search={contentHealthSearchToParams({ ...search, queue: item.target.queue, page: 1 }) as never}
                  hash={QUEUES_SECTION_ID}
                >
                  {item.label}
                </Link>
              ) : (
                <a href={`#${item.target.id}`}>{item.label}</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- findings */

function FindingsAndCounts({ report, topic }: { report: ContentHealthReport; topic: string }) {
  return (
    <>
      <section className="ContentHealth__findings" aria-labelledby="content-health-findings">
        <h2 id="content-health-findings">Findings</h2>
        <ul className="ContentHealth__tiles">
          {findingTiles(report.audit, topic).map((tile) => (
            <li key={tile.id}>
              <Link className="ContentHealth__tile" to="/admin/data" search={tile.search as never} data-finding={tile.id} data-tone={tile.tone}>
                <span className="ContentHealth__tileCount">{tile.count.toLocaleString('en-US')}</span>
                <span className="ContentHealth__tileLabel">{tile.label}</span>
                <StatusChip tone={tile.tone} label={tile.status} size="sm" />
                <span className="ContentHealth__tileMore">View in Data → Audit</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="ContentHealth__counts" aria-label="Library counts">
        <dl>
          <div>
            <dt>Items</dt>
            <dd>{report.totals.items.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{report.totals.published.toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt>Drafts</dt>
            <dd>{report.totals.drafts.toLocaleString('en-US')}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ queues */

/** The item's name: Compose for a live item, the change request for a deleted one (review §2 #11). */
function QueueItemCell({ name, item }: { name: QueueName; item: HealthQueueItem }) {
  const target = queueRowLink(name, item);
  if (target.kind === 'edit') {
    return (
      <Link to="/p/$slug/edit" params={{ slug: target.slug }}>
        {item.title}
      </Link>
    );
  }
  if (target.kind === 'change-request') {
    return (
      <>
        <span>{item.title}</span>{' '}
        <a href={target.url} target="_blank" rel="noopener noreferrer" aria-label={`Open change request for ${item.title} (opens in a new tab)`}>
          Open change request
        </a>
      </>
    );
  }
  return <span>{item.title}</span>;
}

/**
 * What put a lint-queue member there (plan B4): the file, and each diagnostic's
 * code, message and frontmatter key. The source is its own column now; the
 * runbook reference is compact because the full address heads the queue.
 */
function LintDetail({ item, runbook }: { item: HealthQueueItem; runbook: RunbookSection | undefined }) {
  const lint = lintDetailOf(item);
  if (!lint) return <span className="ContentHealth__muted">—</span>;
  return (
    <div className="ContentHealth__lint" data-lint-for={item.id}>
      <p className="ContentHealth__lintWhere">
        <span>{lint.door}</span>
        <span>
          File <code>{lint.path}</code>
        </span>
      </p>
      {lint.lines.length > 0 ? (
        <ul className="ContentHealth__lintList" aria-label={`Lint diagnostics for ${item.title}`}>
          {lint.lines.map((line, i) => (
            <li key={`${line.code}-${i}`} data-severity={line.severity}>
              <code>{line.code}</code> <span>{line.message}</span>
              {line.key ? (
                <span className="ContentHealth__lintKey">
                  {' '}
                  key <code>{line.key}</code>
                </span>
              ) : null}
            </li>
          ))}
          {lint.more > 0 ? <li className="ContentHealth__muted">{moreDiagnosticsText(lint.more)}</li> : null}
        </ul>
      ) : null}
      {runbook ? (
        <p className="ContentHealth__lintRunbook" title={runbookHint(runbook)}>
          <strong>What to do:</strong> fix the named keys in Compose or upstream — runbook §{runbook.number}
        </p>
      ) : null}
    </div>
  );
}

function QueuesSection({
  report,
  search,
  go,
}: {
  report: ContentHealthReport;
  search: ContentHealthSearch;
  go: (next: ContentHealthSearch, replace?: boolean) => void;
}) {
  const overview = queueOverview(report.queues);
  const selected = selectedQueue(search.queue, overview);
  const offset = (search.page - 1) * QUEUE_PAGE_SIZE;
  // Page 1 is already in the report (its first 50 members); only later pages ask the queue endpoint.
  const pageQuery = useContentHealthQueue(selected && offset > 0 ? selected : null, search.topic || undefined, offset);
  const fromReport = selected ? report.queues[selected] : undefined;
  const rows = offset > 0 ? (pageQuery.data?.items ?? []) : (fromReport?.items ?? []);
  const total = offset > 0 ? (pageQuery.data?.total ?? fromReport?.count ?? 0) : (fromReport?.count ?? 0);
  const runbook = selected ? QUEUE_RUNBOOK[selected] : undefined;
  const pages = queuePageCount(total);

  const columns: DataTableColumn<HealthQueueItem>[] = selected
    ? [
        { id: 'item', header: 'Item', primary: true, cell: (item) => <QueueItemCell name={selected} item={item} /> },
        {
          id: 'type',
          header: 'Type',
          cell: (item) => (item.type ? <ContentTypeBadge type={item.type} size="sm" /> : <span className="ContentHealth__muted">—</span>),
        },
        {
          id: 'source',
          header: 'Source',
          cell: (item) => {
            const source = queueItemSource(item);
            return source ? <code>{source}</code> : <span className="ContentHealth__muted">—</span>;
          },
        },
        ...(selected === 'lint_failed_inbound'
          ? [{ id: 'why', header: 'Diagnostics', cell: (item: HealthQueueItem) => <LintDetail item={item} runbook={runbook} /> }]
          : [
              { id: 'status', header: 'Status', hideBelow: 'md' as const, cell: (item: HealthQueueItem) => (item.status === 'published' ? 'Published' : 'Draft') },
              {
                id: 'updated',
                header: 'Updated',
                hideBelow: 'md' as const,
                cell: (item: HealthQueueItem) => <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleDateString()}</time>,
              },
            ]),
      ]
    : [];

  return (
    <section className="ContentHealth__queues" aria-labelledby="content-health-queues-title" id={QUEUES_SECTION_ID}>
      <h2 id="content-health-queues-title">Fix-it queues</h2>
      {overview.open.length > 0 ? (
        <ul className="ContentHealth__queueList" aria-label="Queues with items">
          {overview.open.map(({ name, count }) => (
            <li key={name} data-queue-choice={name}>
              <Link
                to="/admin/health"
                search={contentHealthSearchToParams({ ...search, queue: name, page: 1 }) as never}
                aria-current={name === selected ? 'true' : undefined}
                replace
              >
                <span>{QUEUE_LABELS[name]}</span>
                <span className="ContentHealth__count">{count.toLocaleString('en-US')}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {overview.clear.length > 0 ? (
        <details className="ContentHealth__clear" data-testid="clear-queues">
          <summary>
            <StatusIcon tone="ok" />
            {clearQueuesText(overview.clear.length)}
          </summary>
          <ul>
            {overview.clear.map((name) => (
              <li key={name} data-queue-clear={name}>
                <Link to="/admin/health" search={contentHealthSearchToParams({ ...search, queue: name, page: 1 }) as never} replace>
                  {QUEUE_LABELS[name]}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {selected ? (
        <div className="ContentHealth__queue" data-queue={selected} role="region" aria-labelledby="content-health-queue-title">
          <h3 id="content-health-queue-title">{QUEUE_LABELS[selected]}</h3>
          {runbook && total > 0 ? <RunbookPointer section={runbook} /> : null}
          <DataTable
            rows={rows}
            rowKey={(item) => item.id}
            columns={columns}
            caption={`${QUEUE_LABELS[selected]} queue`}
            state={pageQuery.isError ? 'error' : pageQuery.isFetching && offset > 0 ? 'loading' : 'ready'}
            errorMessage="Couldn't load this page of the queue."
            onRetry={() => void pageQuery.refetch()}
            empty={
              total > 0 ? (
                <EmptyState title="Past the end of this queue" body="Go back to the first page." />
              ) : (
                <EmptyState tone="success" title="Nothing to fix" body={`No item is in “${QUEUE_LABELS[selected]}”.`} />
              )
            }
            rowLabel={(item) => item.title}
          />
          {total > QUEUE_PAGE_SIZE ? (
            <nav className="kp-dt__pager ContentHealth__pager" aria-label={`${QUEUE_LABELS[selected]} pages`}>
              <span className="kp-dt__range" aria-live="polite">
                {queuePageRange(offset, rows.length, total)}
              </span>
              <button type="button" className="kp-dt__button" disabled={search.page <= 1} onClick={() => go({ ...search, queue: selected, page: search.page - 1 })}>
                Previous
              </button>
              <button type="button" className="kp-dt__button" disabled={search.page >= pages} onClick={() => go({ ...search, queue: selected, page: search.page + 1 })}>
                Next
              </button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------- instance-wide */

/** An item name, linked into Compose when the page still has a slug to open. */
function ItemCell({ item }: { item: StuckOutboxItem | MirrorErrorItem }) {
  const label = itemLabel(item);
  return item.slug ? <Link to="/p/$slug/edit" params={{ slug: item.slug }}>{label}</Link> : <span>{label}</span>;
}

function SyncSection({ sync }: { sync: ContentHealthReport['sync'] }) {
  const healthy = !sync || sync.conflicts === 0;
  return (
    <section className="ContentHealth__instance" aria-label="Sync" data-tone={healthy ? 'ok' : 'alert'}>
      <h3>Sync</h3>
      {!sync ? (
        <p className="ContentHealth__line">
          <StatusChip tone="info" label="Not reported" size="sm" /> This server does not report sync health.
        </p>
      ) : sync.conflicts === 0 ? (
        <p className="ContentHealth__line">
          <StatusChip tone="ok" label="Clean" size="sm" /> No open merge conflicts — every source is merging cleanly.
        </p>
      ) : (
        <>
          <p role="alert">
            <strong>{sync.conflicts}</strong> open merge {sync.conflicts === 1 ? 'conflict blocks' : 'conflicts block'}{' '}
            {sync.sources_in_conflict.length === 1 ? 'source' : 'sources'}{' '}
            {sync.sources_in_conflict.map((id, i) => (
              <span key={id}>
                {i > 0 ? ', ' : ''}
                <code>{id}</code>
              </span>
            ))}
            . Resolve them in{' '}
            <Link
              to="/admin/repos"
              search={
                (sync.sources_in_conflict.length === 1
                  ? { source: sync.sources_in_conflict[0], tab: 'conflicts' }
                  : { state: 'attention' }) as never
              }
            >
              Admin &rarr; Sources
            </Link>
            .
          </p>
          <RunbookPointer section={RUNBOOK.sourceConflict} />
        </>
      )}
    </section>
  );
}

/**
 * Git mirror (issue 88). An operational alert, not a fix-it queue: a non-zero
 * count means content is indexed and readable but its commit is unconfirmed, so
 * it is not yet durable in git. A restart replays the pending rows — which is
 * exactly why this failure went unnoticed until it was surfaced here. Reported
 * instance-wide, like Sync: durability is not a per-topic property. One line
 * while healthy: there is nothing to capture or read.
 */
function MirrorSection({ mirror }: { mirror: MirrorHealth | undefined }) {
  const alert = mirrorAlert(mirror);
  const bound = mirror ? formatThreshold(mirror.stuck_after_ms) : '';
  const [copyNote, setCopyNote] = useState<string | null>(null);

  // B6: runbook §3.1 step 1 is "capture the evidence before you fix it", and
  // the instruction it gives is a SQL query against the SQLite file. Every
  // column that query returns is already on this page.
  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(mirrorDiagnosticsText(mirror));
      setCopyNote('Copied the Git mirror rows — paste them into the issue before you restart.');
    } catch {
      setCopyNote('Copy failed. Check the browser clipboard permission and try again.');
    }
  }

  if (alert.tone === 'ok') {
    return (
      <section className="ContentHealth__instance ContentHealth__mirror" aria-label="Git mirror" data-tone="ok" id={MIRROR_SECTION_ID}>
        <h3>Git mirror</h3>
        <p className="ContentHealth__line" data-testid="mirror-headline" title={alert.detail || undefined}>
          <StatusChip tone={mirror ? 'ok' : 'info'} label={mirror ? 'Durable' : 'Not reported'} size="sm" /> {alert.headline}
        </p>
      </section>
    );
  }

  return (
    <section className="ContentHealth__instance ContentHealth__mirror" aria-label="Git mirror" data-tone="alert" id={MIRROR_SECTION_ID}>
      <h3>Git mirror</h3>
      <p role="alert" data-testid="mirror-headline">
        <strong>{alert.headline}</strong>
        {alert.detail ? <span className="ContentHealth__mirrorDetail"> {alert.detail}</span> : null}
      </p>
      <RunbookPointer section={RUNBOOK.mirrorStuck} />
      <p className="ContentHealth__mirrorActions">
        <button type="button" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </button>
        {copyNote ? (
          <span className="ContentHealth__muted" role="status">
            {copyNote}
          </span>
        ) : null}
      </p>
      {mirror && mirror.pending.count > 0 ? (
        <>
          <h4>Indexed, not yet in git &mdash; pending over {bound}</h4>
          <div className="ContentHealth__scroll">
            <table className="ContentHealth__table" aria-label="Pending mirror writes">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Mirror</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">File</th>
                  <th scope="col">Source</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {mirror.pending.items.map((item) => (
                  <tr key={item.outbox_id}>
                    <td><ItemCell item={item} /></td>
                    <td>
                      <span className="ContentHealth__mirrorState" data-state={item.mirror_state} title={MIRROR_STATE_HINTS[item.mirror_state]}>
                        {MIRROR_STATE_LABELS[item.mirror_state]}
                      </span>
                    </td>
                    <td title={item.created_at}>{formatAge(item.age_seconds)}</td>
                    <td>{item.file_path ? <code>{item.file_path}</code> : <span className="ContentHealth__muted">&mdash;</span>}</td>
                    <td>{item.source_id ? <code>{item.source_id}</code> : <span className="ContentHealth__muted">&mdash;</span>}</td>
                    <td>{item.error ?? item.mirror_error ?? <span className="ContentHealth__muted">&mdash;</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mirror.pending.count > mirror.pending.items.length ? (
            <p className="ContentHealth__muted">Showing the first {mirror.pending.items.length} of {mirror.pending.count}.</p>
          ) : null}
        </>
      ) : null}
      {mirror && mirror.mirror_errors.count > 0 ? (
        <>
          <h4>Mirror errors and mirrors dirty over {bound}</h4>
          <div className="ContentHealth__scroll">
            <table className="ContentHealth__table" aria-label="Mirror errors">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Path</th>
                  <th scope="col">Dirty</th>
                  <th scope="col">Since</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {mirror.mirror_errors.items.map((item) => (
                  <tr key={item.page_id}>
                    <td><ItemCell item={item} /></td>
                    <td>{item.path ? <code>{item.path}</code> : <span className="ContentHealth__muted">&mdash;</span>}</td>
                    <td>{item.dirty ? 'Yes' : 'No'}</td>
                    <td title={item.updated_at}>{formatAge(item.age_seconds)}</td>
                    <td>{item.error ?? <span className="ContentHealth__muted">&mdash;</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mirror.mirror_errors.count > mirror.mirror_errors.items.length ? (
            <p className="ContentHealth__muted">Showing the first {mirror.mirror_errors.items.length} of {mirror.mirror_errors.count}.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Recent refusals (plan B2). Until this, a publish the content-model gate
 * refused existed only as a 422 in the author's face; the administrator had no
 * way to learn that an agent is repeatedly trying to publish something
 * non-conformant, or that one rule is tripping every author. Read-only, and a
 * window rather than a report: the full history is the audit log, filtered.
 * One line when nothing was refused in the last week; older rows stay one
 * click away rather than reading as news.
 */
function RecentRefusals({ query }: { query: ReturnType<typeof useRecentRefusals> }) {
  const { data, isLoading, isError } = query;
  const rows = (data?.entries ?? []).map(toRefusalRow);
  const recent = recentRefusals(rows);
  const auditLink = (
    <Link to="/admin/audit" search={{ action: REFUSED_ACTION } as never}>
      All refusals in the audit log &rarr;
    </Link>
  );

  const table = (list: RefusalRow[]) => (
    <div className="ContentHealth__scroll">
      <table className="ContentHealth__table" aria-label="Recent refusals">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Through</th>
            <th scope="col">Item</th>
            <th scope="col">Rules</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.id}>
              <td title={row.occurredAt}>{new Date(row.occurredAt).toLocaleString()}</td>
              <td>{row.actor}</td>
              <td>{row.sourceLabel}</td>
              <td>
                {row.slug ? <Link to="/p/$slug/edit" params={{ slug: row.slug }}>{row.title}</Link> : <span>{row.title}</span>}
                <span className="ContentHealth__refusalAttempt">
                  {refusalAttempt(row)}
                  {row.topic ? ` · ${row.topic}` : ''}
                </span>
              </td>
              <td><code>{rulesText(row.rules)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="ContentHealth__instance ContentHealth__refusals" aria-label="Recent refusals" data-tone={recent.length > 0 ? 'warn' : 'ok'}>
      <h3>Recent refusals</h3>
      {isLoading ? (
        <p className="ContentHealth__muted" role="status">Loading…</p>
      ) : isError ? (
        <p className="ContentHealth__muted" role="alert">Could not load recent refusals.</p>
      ) : recent.length === 0 ? (
        <>
          <p className="ContentHealth__line">
            <StatusChip tone="ok" label="None" size="sm" /> No refused publishes in the last 7 days. {auditLink}
          </p>
          {rows.length > 0 ? (
            <details className="ContentHealth__earlier">
              <summary>Earlier refusals ({rows.length})</summary>
              {table(rows)}
            </details>
          ) : null}
        </>
      ) : (
        <>
          <p className="ContentHealth__muted">
            Publishes the content-model rules turned away, from Compose, the REST API or an MCP agent. Nothing was written;
            the author was shown what to fix. Files arriving through sync are never refused &mdash; they queue above.
          </p>
          {table(rows)}
          <p className="ContentHealth__refusalsMore">{auditLink}</p>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- page */

export function ContentHealth() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const search = readContentHealthSearch(rawSearch);
  const go = (next: ContentHealthSearch, replace = false) => {
    void navigate({ to: '/admin/health', search: contentHealthSearchToParams(next) as never, replace });
  };

  const { data: topics = [] } = useTopics();
  const report = useContentHealth(search.topic || undefined);
  const refusals = useRecentRefusals();
  const data = report.data;
  const refusalRows = (refusals.data?.entries ?? []).map(toRefusalRow);

  // The page is only as fresh as its stalest part.
  const updatedAt = [report.dataUpdatedAt, refusals.dataUpdatedAt].filter((t) => t > 0);
  const refresh = () => {
    // The prefix covers the report and any open queue page for every topic.
    void queryClient.invalidateQueries({ queryKey: ['content-health'] });
    void refusals.refetch();
  };

  return (
    <main className="ContentHealth" aria-labelledby="health-contenthealth-title">
      <AdminPageHeader
        titleId="health-contenthealth-title"
        title="Content health"
        description="What needs fixing in the library, worst first, with each item one click from its fix."
        meta={
          <Freshness
            updatedAt={updatedAt.length > 0 ? Math.min(...updatedAt) : null}
            onRefresh={refresh}
            refreshing={report.isFetching || refusals.isFetching}
          />
        }
        learnMore={
          <details>
            <summary>How this works</summary>
            <p>
              Each queue row opens the item in Compose. Files that arrive through sync or an OKF import with lint errors
              land anyway and queue up here until a clean version arrives. The findings are the library audit, listed in
              full on Data → Audit.
            </p>
          </details>
        }
        secondaryActions={
          <label className="ContentHealth__filter">
            <span>Topic</span>
            <select value={search.topic} onChange={(e) => go({ ...search, topic: e.target.value, page: 1 })} aria-label="Topic filter">
              <option value="">All topics</option>
              {topics.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.name.trim() || t.slug}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {report.isLoading ? (
        <p className="ContentHealth__muted" role="status">Loading…</p>
      ) : report.isError || !data ? (
        <div className="ContentHealth__error" role="alert">
          <strong>{(report.error as ApiError | null)?.statusCode === 403 ? 'Admin access required' : 'Could not load the report'}</strong>
          <span>{(report.error as ApiError | null)?.message}</span>
          <button type="button" onClick={() => void report.refetch()}>Try again</button>
        </div>
      ) : (
        <>
          <AttentionStrip items={buildHealthAttention(data, refusalRows)} search={search} />
          <FindingsAndCounts report={data} topic={search.topic} />
          <QueuesSection report={data} search={search} go={go} />

          <section className="ContentHealth__instanceGroup" aria-labelledby="content-health-instance">
            <div className="ContentHealth__instanceHead">
              <h2 id="content-health-instance">Instance-wide</h2>
              <span className="ContentHealth__notFiltered" data-testid="not-filtered">
                Not filtered by topic
              </span>
            </div>
            <SyncSection sync={data.sync} />
            <MirrorSection mirror={data.mirror} />
            <RecentRefusals query={refusals} />
          </section>
        </>
      )}
    </main>
  );
}
