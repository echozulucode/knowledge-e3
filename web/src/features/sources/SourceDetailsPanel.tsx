/**
 * The Overview and Selection tabs of a source's detail sheet
 * (the admin UX review §4.4).
 *
 * Overview: the live state and what it means (with the runbook section that
 * answers it, plan B5), where the source points, the commit its working tree is
 * on, how many items it indexed, and whether the env vars it names are set on
 * this server (B3 — presence only). Selection: which files it indexes (A1).
 *
 * Until A1, a source configured with include globs — from the config file or
 * curl — was indistinguishable in the UI from an ordinary OKF source. Every
 * field here is read off the registry row the list already fetched; nothing on
 * these panels makes a request of its own.
 */
import { StatusChip } from '../../components/admin/StatusChip.js';
import { RUNBOOK, runbookAddress } from '../health/runbook.js';
import {
  DEFAULT_SELECTION_LABEL,
  MODE_OPTIONS,
  ROLE_OPTIONS,
  describeHead,
  describeHost,
  describeItemCount,
  describeSecrets,
  describeSelection,
  formatSyncedAt,
  stateChipTitle,
} from './sourceModel.js';
import { explainSyncState, formatAge, isEnabled, lastSyncedAt, openConflictCount, sourceStateChip, stateTone } from './sourcesAdminModel.js';
import type { SourceStatusView } from './types.js';
import './Sources.css';

function GlobList({ globs, empty }: { globs: string[]; empty: string }) {
  if (globs.length === 0) return <span className="Sources__muted">{empty}</span>;
  return (
    <ul className="Sources__globList">
      {globs.map((glob) => (
        <li key={glob}>
          <code>{glob}</code>
        </li>
      ))}
    </ul>
  );
}

/** The env vars a source names and whether the server has them — the chips the row used to carry. */
export function SecretChips({ source }: { source: SourceStatusView }) {
  return (
    <>
      {describeSecrets(source).map((secret) => (
        <span
          key={secret.kind}
          className="Sources__chip Sources__secret"
          data-kind="secret"
          data-secret={secret.kind}
          data-tone={secret.tone}
          title={secret.title}
        >
          {secret.label}
        </span>
      ))}
    </>
  );
}

export interface SourceOverviewPanelProps {
  source: SourceStatusView;
  /** Opens the Conflicts tab; offered when the state is a conflict. */
  onShowConflicts?: () => void;
}

export function SourceOverviewPanel({ source, onShowConflicts }: SourceOverviewPanelProps) {
  const chip = sourceStateChip(source);
  const explanation = explainSyncState(source);
  const modeLabel = MODE_OPTIONS.find((m) => m.value === source.mode)?.label ?? source.mode;
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === source.role)?.label ?? source.role;
  const synced = lastSyncedAt(source);
  const conflicts = openConflictCount(source);

  return (
    <section className="Sources__tabPanel" aria-label={`Overview of ${source.id}`} data-source-details={source.id}>
      <div className="Sources__stateBlock" data-detail="state">
        <div className="Sources__stateLine">
          <StatusChip tone={stateTone(chip)} label={chip.label} title={stateChipTitle(chip)} />
          {!isEnabled(source) ? <StatusChip tone="info" label="Disabled" /> : null}
        </div>
        <p className="Sources__stateText">{explanation.text}</p>
        {explanation.runbook ? (
          <p className="Sources__runbook" data-detail="runbook">
            What to do: runbook §{explanation.runbook.number} — {explanation.runbook.title}.{' '}
            <code className="Sources__mono">{runbookAddress(explanation.runbook)}</code>
          </p>
        ) : null}
        {conflicts > 0 && onShowConflicts ? (
          <button type="button" className="kp-admin-button" onClick={onShowConflicts}>
            Resolve {conflicts === 1 ? 'the conflict' : `${conflicts} conflicts`}
          </button>
        ) : null}
      </div>

      <dl className="Sources__details">
        <dt>Policy</dt>
        <dd data-detail="policy">
          {modeLabel} · {roleLabel}
        </dd>

        <dt>Remote</dt>
        <dd data-detail="remote">
          {source.remote_url ? <code className="Sources__mono">{source.remote_url}</code> : <span className="Sources__muted">None — local only</span>}
        </dd>

        <dt>Branch</dt>
        <dd data-detail="branch">{source.branch ?? <span className="Sources__muted">(current)</span>}</dd>

        <dt>Local working tree</dt>
        <dd data-detail="local-dir">
          <code className="Sources__mono">{source.local_dir}</code>
        </dd>

        <dt>HEAD</dt>
        <dd data-detail="head">
          {source.head ? (
            <span title={source.head.sha}>
              <code className="Sources__mono">{describeHead(source.head)}</code>
            </span>
          ) : (
            <span className="Sources__muted">{describeHead(source.head)}</span>
          )}
        </dd>

        <dt>Items indexed</dt>
        <dd data-detail="item-count">{describeItemCount(source.item_count)}</dd>

        <dt>Last synced</dt>
        <dd data-detail="last-synced">
          <span title={synced ? formatSyncedAt(synced) : undefined}>{formatAge(synced)}</span>
        </dd>

        <dt>Last error</dt>
        <dd data-detail="last-error">
          {source.last_error ? (
            <span className="Sources__rowError">{source.last_error}</span>
          ) : (
            <span className="Sources__muted">None</span>
          )}
        </dd>

        <dt>Host</dt>
        <dd data-detail="host">
          {describeHost(source)}
          {/* B3: presence only — a boolean is all that crosses the wire. */}
          <SecretChips source={source} />
        </dd>
      </dl>
      {source.last_error && !explanation.runbook ? (
        <p className="Sources__runbook">
          What to do: runbook §{RUNBOOK.sourceConflict.number} — {RUNBOOK.sourceConflict.title}.{' '}
          <code className="Sources__mono">{runbookAddress(RUNBOOK.sourceConflict)}</code>
        </p>
      ) : null}
    </section>
  );
}

export function SourceSelectionPanel({ source }: { source: SourceStatusView }) {
  const selection = describeSelection(source);
  return (
    <section className="Sources__tabPanel" aria-label={`Selection for ${source.id}`} data-source-selection={source.id}>
      <dl className="Sources__details">
        <dt>Include globs</dt>
        <dd data-detail="include">
          <GlobList globs={selection.include} empty={`None — ${DEFAULT_SELECTION_LABEL}`} />
        </dd>

        <dt>Exclude globs</dt>
        <dd data-detail="exclude">
          <GlobList globs={selection.exclude} empty="None" />
        </dd>

        <dt>Default type</dt>
        <dd data-detail="default-type">
          {source.default_type ? (
            source.default_type
          ) : (
            <span className="Sources__muted">None — an imported file keeps its own type, or stays untyped</span>
          )}
        </dd>

        <dt>Default status</dt>
        <dd data-detail="default-status">
          {source.default_status ? (
            source.default_status === 'published' ? 'Published' : 'Draft'
          ) : (
            <span className="Sources__muted">Server default</span>
          )}
        </dd>
      </dl>
    </section>
  );
}
