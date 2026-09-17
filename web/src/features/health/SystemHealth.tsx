/**
 * SystemHealth — Admin → Health → System (plan §5, issue 71).
 *
 * The sibling page to Content health, and deliberately not a merge with it.
 * Content health answers "what in the library needs fixing" and is a list of
 * problems. This answers "is this instance healthy right now", and so it leads
 * with a VERDICT — Healthy / Degraded / At risk — with the reason underneath,
 * then the checks that produced it, each saying what to do about it.
 *
 * P6 polish (the admin UX review §4.9), keeping verdict-first and
 * worst-first: the report refreshes itself every 30 s while the tab is visible
 * (useAutoRefresh), OK checks fold to one line so the rows that need a human
 * are the ones with room, every check names its runbook section, and "Copy
 * diagnostics" puts the whole report on the clipboard as text.
 *
 * Admin-only; like the other admin pages the server enforces it (403) and the
 * page renders the access message rather than guessing at the role.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader.js';
import { Freshness } from '../../components/admin/Freshness.js';
import { StatusChip, type StatusTone } from '../../components/admin/StatusChip.js';
import { pushToast } from '../../hooks/useToast.js';
import type { ApiError } from '../../api.js';
import { useSystemHealth } from './queries.js';
import {
  STATE_LABELS,
  STATE_TONE,
  VERDICT_LABELS,
  VERDICT_TONE,
  countStates,
  orderChecks,
  verdictAnnouncement,
  verdictReason,
  type CheckState,
  type SystemCheck,
  type SystemHealthReport,
  type SystemVerdict,
} from './systemVerdict.js';
import { checkRunbook, runbookAddress } from './runbook.js';
import { buildDiagnosticsText } from './systemDiagnostics.js';
import { useAutoRefresh } from './useAutoRefresh.js';
import { splitCodeSpans } from './codeSpans.js';
import './SystemHealth.css';

/** Review §4.9. Cheap probes, and an operator who just restarted something wants the page to agree. */
export const SYSTEM_HEALTH_REFRESH_MS = 30_000;

/** The one status vocabulary (StatusChip) for a check's three states. */
const CHIP_TONE: Record<CheckState, StatusTone> = { ok: 'ok', warn: 'warn', fail: 'error' };

async function writeClipboard(text: string): Promise<void> {
  // `navigator.clipboard` is absent outside a secure context, which is a
  // failure to report, not a crash.
  if (!navigator.clipboard) throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(text);
}

/**
 * Text with its own Copy button (review §2 #14): a command the server marked
 * with backticks, or a runbook address. The admin's next move on most failing
 * checks is to paste exactly that, so it should leave the page without
 * trimming.
 */
function CopyableCode({ value, label }: { value: string; label?: string }) {
  const [note, setNote] = useState<string | null>(null);

  async function copy(): Promise<void> {
    try {
      await writeClipboard(value);
      setNote('Copied.');
    } catch {
      setNote('Copy failed — select the text and copy it by hand.');
    }
  }

  return (
    <span className="SystemHealth__code">
      <code>{value}</code>
      <button type="button" className="SystemHealth__copy" onClick={() => void copy()} aria-label={label ?? `Copy ${value}`}>
        Copy
      </button>
      {note ? (
        <span className="SystemHealth__copyNote" role="status">
          {note}
        </span>
      ) : null}
    </span>
  );
}

/** Server copy with its backtick spans rendered as copyable code; plain text otherwise. */
function CheckText({ text }: { text: string }) {
  return (
    <>
      {splitCodeSpans(text).map((segment, i) =>
        segment.kind === 'code' ? <CopyableCode key={i} value={segment.value} /> : <span key={i}>{segment.value}</span>,
      )}
    </>
  );
}

/**
 * "Runbook §3.1 — Content is indexed but not reaching git", with the address
 * copyable. Text, not a link: nothing serves `docs/` (see runbook.ts).
 */
function RunbookRef({ check }: { check: SystemCheck }) {
  const section = checkRunbook(check.id);
  if (!section) return null;
  return (
    <p className="SystemHealth__runbook">
      <span>
        Runbook §{section.number} — {section.title}
      </span>{' '}
      <CopyableCode value={runbookAddress(section)} label={`Copy runbook address for ${check.title}`} />
    </p>
  );
}

function Evidence({ check }: { check: SystemCheck }) {
  const evidence = check.evidence ?? [];
  if (evidence.length === 0) return null;
  return (
    <details className="SystemHealth__evidence">
      <summary>Evidence</summary>
      <ul>
        {evidence.map((line, i) => (
          <li key={`${check.id}-${i}`}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/** A check that needs a human: expanded, with what to do and where to read. */
function AttentionRow({ check }: { check: SystemCheck }) {
  return (
    <li className="SystemHealth__check" data-check={check.id} data-tone={STATE_TONE[check.state]}>
      <div className="SystemHealth__checkHead">
        <StatusChip tone={CHIP_TONE[check.state]} label={STATE_LABELS[check.state]} size="sm" />
        <h3>{check.title}</h3>
      </div>
      <p className="SystemHealth__summary">
        <CheckText text={check.summary} />
      </p>
      {check.action ? (
        <p className="SystemHealth__action">
          <strong>What to do:</strong> <CheckText text={check.action} />
        </p>
      ) : null}
      {check.link ? (
        <p className="SystemHealth__link">
          <Link to={check.link.href}>{check.link.label}</Link>
        </p>
      ) : null}
      <RunbookRef check={check} />
      <Evidence check={check} />
    </li>
  );
}

/**
 * A passing check: one line — name, chip, what is true — folded. The runbook
 * and evidence are one click away for the operator verifying a restore, and
 * out of the way for everyone else.
 */
function OkRow({ check }: { check: SystemCheck }) {
  const evidence = check.evidence ?? [];
  return (
    <li className="SystemHealth__check SystemHealth__check--ok" data-check={check.id} data-tone={STATE_TONE[check.state]}>
      <details className="SystemHealth__okDetails">
        <summary className="SystemHealth__okLine">
          <span className="SystemHealth__okTitle">{check.title}</span>
          <StatusChip tone="ok" label={STATE_LABELS.ok} size="sm" />
          <span className="SystemHealth__okDetail">{check.summary.replaceAll('`', '')}</span>
        </summary>
        <div className="SystemHealth__okBody">
          {check.action ? (
            <p className="SystemHealth__action">
              <strong>What to do:</strong> <CheckText text={check.action} />
            </p>
          ) : null}
          {check.link ? (
            <p className="SystemHealth__link">
              <Link to={check.link.href}>{check.link.label}</Link>
            </p>
          ) : null}
          <RunbookRef check={check} />
          {evidence.length > 0 ? (
            <ul className="SystemHealth__okEvidence" aria-label={`Evidence for ${check.title}`}>
              {evidence.map((line, i) => (
                <li key={`${check.id}-${i}`}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * The verdict's live region carries only a CHANGE (verdictAnnouncement): the
 * band itself re-renders every 30 s with a new count line, and announcing that
 * each time would drown the one refresh that matters.
 */
function useVerdictAnnouncement(verdict: SystemVerdict | undefined): string {
  const previous = useRef<SystemVerdict | undefined>(undefined);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!verdict) return;
    const next = verdictAnnouncement(previous.current, verdict);
    if (next) setMessage(next);
    previous.current = verdict;
  }, [verdict]);
  return message;
}

function CopyDiagnostics({ report }: { report: SystemHealthReport | undefined }) {
  async function copy(): Promise<void> {
    if (!report) return;
    try {
      await writeClipboard(
        buildDiagnosticsText(report, { copiedAt: new Date(), runbookFor: checkRunbook, origin: window.location.origin }),
      );
      pushToast({ kind: 'success', message: 'Diagnostics copied.' });
    } catch {
      pushToast({ kind: 'error', message: 'Copy failed. Check the browser clipboard permission and try again.' });
    }
  }
  return (
    <button type="button" className="kp-admin-button" onClick={() => void copy()} disabled={!report}>
      Copy diagnostics
    </button>
  );
}

export function SystemHealth() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useSystemHealth();
  const checks = data?.checks ?? [];
  const counts = countStates(checks);
  const ordered = orderChecks(checks);
  const announcement = useVerdictAnnouncement(data?.verdict);

  // `cancelRefetch: false` joins a fetch already in flight instead of
  // cancelling it — TanStack's own refetch-on-focus fires on the same
  // visibilitychange the schedule resumes on.
  const refresh = () => refetch({ cancelRefetch: false });
  useAutoRefresh({ intervalMs: SYSTEM_HEALTH_REFRESH_MS, refresh, updatedAt: dataUpdatedAt, busy: isFetching });

  return (
    <main className="SystemHealth" aria-labelledby="health-systemhealth-title">
      <AdminPageHeader
        titleId="health-systemhealth-title"
        title="System health"
        description="Is this instance healthy right now? One verdict over a fixed set of checks."
        meta={<Freshness updatedAt={dataUpdatedAt} onRefresh={() => void refresh()} refreshing={isFetching} />}
        secondaryActions={<CopyDiagnostics report={data} />}
        learnMore={
          <details>
            <summary>How this works</summary>
            <p>
              The checks cover the database, the disk, the sources, the git mirror, and whether a restore has ever been
              rehearsed. The page re-checks every 30 seconds while it is open in a visible tab. What needs fixing in the
              library is a different question, and it lives in <Link to="/admin/health">Content health</Link>.
            </p>
          </details>
        }
      />

      {isLoading ? (
        <p className="SystemHealth__muted" role="status">
          Loading…
        </p>
      ) : isError || !data ? (
        <div className="SystemHealth__error" role="alert">
          <strong>
            {(error as ApiError | null)?.statusCode === 403 ? 'Admin access required' : 'Could not load the report'}
          </strong>
          <span>{(error as ApiError | null)?.message}</span>
          <button type="button" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <section className="SystemHealth__verdict" aria-label="Verdict" data-tone={VERDICT_TONE[data.verdict]}>
            <p className="SystemHealth__verdictLabel" data-testid="system-verdict">
              {VERDICT_LABELS[data.verdict]}
            </p>
            <p className="SystemHealth__verdictReason">{verdictReason(data)}</p>
            <p className="SystemHealth__verdictMeta">
              {counts.fail} at risk · {counts.warn} need attention · {counts.ok} OK
            </p>
            <p className="SystemHealth__live" aria-live="polite" aria-atomic="true" data-testid="system-verdict-live">
              {announcement}
            </p>
          </section>

          <section className="SystemHealth__checks" aria-label="Checks">
            <ul>
              {ordered.map((check) =>
                check.state === 'ok' ? <OkRow key={check.id} check={check} /> : <AttentionRow key={check.id} check={check} />,
              )}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
