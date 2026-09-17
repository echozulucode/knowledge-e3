/**
 * The conflict queue for one source (plan §8.1) — the Conflicts tab of the
 * source's detail sheet. A merge that left paths conflicted parks both sides
 * here and the source stays in `conflict` until an admin picks a side: Keep
 * mine, Keep theirs, or Edit and resolve (merged content, recorded as a
 * `manual` resolution). Resolved conflicts collapse into a history list
 * underneath, which is the server's own bounded record
 * (`?includeResolved=true`) rather than a memory of this session's mutations —
 * so it is still there after a reload.
 *
 * Both sides are shown as a line diff (`SideBySideDiff`). Keep mine / Keep
 * theirs throw the other side away for good, so each asks first, naming the
 * file and the side that is discarded (review §3.3).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiError } from '../../api.js';
import { Icon, appIcons } from '../../icons.js';
import { pushToast } from '../../hooks/useToast.js';
import { ConfirmDialog } from '../../components/admin/ConfirmDialog.js';
import { EmptyState } from '../../components/admin/EmptyState.js';
import { useEscapeLayer } from '../../components/admin/useEscapeLayer.js';
import { SideBySideDiff } from '../../components/diff/SideBySideDiff.js';
import { RESOLVED_HISTORY_LIMIT, useResolveConflict, useSourceConflicts } from './queries.js';
import { describeResolution, formatSyncedAt, splitConflicts } from './sourceModel.js';
import { resolvedByLabel } from './types.js';
import type { ConflictRow } from './types.js';
import './Sources.css';

export interface ConflictsPanelProps {
  sourceId: string;
}

interface PendingChoice {
  conflict: ConflictRow;
  choice: 'ours' | 'theirs';
}

export function ConflictsPanel({ sourceId }: ConflictsPanelProps) {
  const { data: conflicts = [], isLoading, isError, error } = useSourceConflicts(sourceId, { includeResolved: true });
  const resolve = useResolveConflict();
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingChoice | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // The dialog opens over the detail sheet, which also closes on Esc. Take Esc
  // first so it dismisses only the dialog, not the sheet under it.
  useEscapeLayer(confirming !== null, () => {
    if (!resolve.isPending) cancelConfirm();
  });

  // Both lists come from the server: open conflicts, and the most recent
  // resolutions it keeps (bounded — older ones are not shown here).
  const { open, resolved } = splitConflicts(conflicts);

  function cancelConfirm() {
    setConfirming(null);
    setConfirmError(null);
  }

  async function apply(conflict: ConflictRow, choice: 'ours' | 'theirs', content?: string): Promise<boolean> {
    await resolve.mutateAsync({
      sourceId,
      conflictId: conflict.id,
      choice,
      ...(content !== undefined ? { content } : {}),
    });
    setEditing((prev) => {
      const next = { ...prev };
      delete next[conflict.id];
      return next;
    });
    return true;
  }

  async function confirmChoice() {
    if (!confirming) return;
    const { conflict, choice } = confirming;
    setConfirmError(null);
    try {
      await apply(conflict, choice);
    } catch (err) {
      setConfirmError((err as ApiError | null)?.message ?? 'Could not resolve that conflict.');
      return;
    }
    setConfirming(null);
    pushToast({ kind: 'success', message: `${choice === 'ours' ? 'Kept mine' : 'Kept theirs'} for ${conflict.path}.` });
  }

  async function saveMerged(conflict: ConflictRow, content: string) {
    setFailure(null);
    try {
      await apply(conflict, 'ours', content);
      pushToast({ kind: 'success', message: `Saved merged content for ${conflict.path}.` });
    } catch (err) {
      setFailure((err as ApiError | null)?.message ?? 'Could not resolve that conflict.');
    }
  }

  return (
    <section className="Sources__tabPanel" aria-label={`Conflicts for ${sourceId}`}>
      <p className="Sources__muted">
        Both sides of every parked merge. Nothing else syncs for <code>{sourceId}</code> until each one is resolved.
      </p>

      {isLoading ? (
        <p className="Sources__muted" role="status">
          Loading conflicts…
        </p>
      ) : isError ? (
        <p className="Sources__fieldError" role="alert">
          {(error as ApiError | null)?.message ?? 'Could not load the conflict queue.'}
        </p>
      ) : open.length === 0 ? (
        <div data-empty-conflicts="true">
          <EmptyState tone="success" title="No conflicts" body="This source is merging cleanly." />
        </div>
      ) : (
        open.map((conflict) => {
          const draft = editing[conflict.id];
          return (
            <article className="Sources__conflict" key={conflict.id} data-conflict-path={conflict.path} aria-label={conflict.path}>
              <div className="Sources__conflictHead">
                <strong className="Sources__mono">{conflict.path}</strong>
                <span className="Sources__muted">Detected {formatSyncedAt(conflict.detected_at)}</span>
              </div>

              {conflict.ours === null ? <p className="Sources__muted">Mine: the file was removed here.</p> : null}
              {conflict.theirs === null ? <p className="Sources__muted">Theirs: the file was removed upstream.</p> : null}
              <SideBySideDiff left={conflict.ours ?? ''} right={conflict.theirs ?? ''} leftLabel="Mine (here)" rightLabel="Theirs (remote)" />

              {draft !== undefined ? (
                <>
                  <label className="Sources__mergeField">
                    <span>Merged content</span>
                    <textarea
                      className="Sources__mergeBox"
                      value={draft}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [conflict.id]: e.target.value }))}
                    />
                  </label>
                  <div className="Sources__actions">
                    <button type="button" className="kp-admin-button kp-admin-button--primary" disabled={resolve.isPending} onClick={() => void saveMerged(conflict, draft)}>
                      <Icon icon={appIcons.floppyDisk} /> Save merged content
                    </button>
                    <button
                      type="button"
                      className="kp-admin-button"
                      onClick={() =>
                        setEditing((prev) => {
                          const next = { ...prev };
                          delete next[conflict.id];
                          return next;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="Sources__actions">
                  <button
                    type="button"
                    className="kp-admin-button"
                    disabled={resolve.isPending}
                    onClick={() => {
                      setFailure(null);
                      setConfirming({ conflict, choice: 'ours' });
                    }}
                  >
                    Keep mine
                  </button>
                  <button
                    type="button"
                    className="kp-admin-button"
                    disabled={resolve.isPending}
                    onClick={() => {
                      setFailure(null);
                      setConfirming({ conflict, choice: 'theirs' });
                    }}
                  >
                    Keep theirs
                  </button>
                  <button
                    type="button"
                    className="kp-admin-button"
                    disabled={resolve.isPending}
                    onClick={() => setEditing((prev) => ({ ...prev, [conflict.id]: conflict.ours ?? conflict.theirs ?? '' }))}
                  >
                    <Icon icon={appIcons.pencil} /> Edit and resolve
                  </button>
                </div>
              )}
            </article>
          );
        })
      )}

      {failure ? (
        <p className="Sources__fieldError" role="alert">
          {failure}
        </p>
      ) : null}

      {resolved.length > 0 ? (
        <details className="Sources__history">
          <summary>Resolved ({resolved.length})</summary>
          <div className="Sources__historyScroll">
            <table className="Sources__historyTable" aria-label={`Resolved conflicts for ${sourceId}`}>
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Resolution</th>
                  <th scope="col">By</th>
                  <th scope="col">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {resolved.map((conflict) => (
                  <tr key={conflict.id} data-resolved-path={conflict.path}>
                    <td className="Sources__mono">{conflict.path}</td>
                    <td>{describeResolution(conflict)}</td>
                    <td>{resolvedByLabel(conflict)}</td>
                    <td>{formatSyncedAt(conflict.resolved_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {resolved.length >= RESOLVED_HISTORY_LIMIT ? (
            <p className="Sources__muted">The {RESOLVED_HISTORY_LIMIT} most recent resolutions.</p>
          ) : null}
        </details>
      ) : null}

      {/*
        Portalled to <body>: rendered inside the sheet, the sheet's own focus
        trap would treat the dialog's buttons as its last stops and pull Tab
        back into the sheet behind it.
      */}
      {confirming
        ? createPortal(
            <ConfirmDialog
              title={confirming.choice === 'ours' ? `Keep mine for ${confirming.conflict.path}?` : `Keep theirs for ${confirming.conflict.path}?`}
              body={
                confirming.choice === 'ours' ? (
                  <>
                    Resolves <code>{confirming.conflict.path}</code> with the version here. The remote's version (theirs) is
                    discarded.
                  </>
                ) : (
                  <>
                    Resolves <code>{confirming.conflict.path}</code> with the remote's version. The version here (mine) is
                    discarded.
                  </>
                )
              }
              consequences={[
                confirming.choice === 'ours'
                  ? "The remote's changes to this file are not kept."
                  : 'The local changes to this file are not kept.',
                'The conflict moves to the resolved history.',
              ]}
              confirmLabel={confirming.choice === 'ours' ? 'Keep mine' : 'Keep theirs'}
              tone="danger"
              pending={resolve.isPending}
              error={confirmError}
              onConfirm={() => void confirmChoice()}
              onCancel={cancelConfirm}
            />,
            document.body,
          )
        : null}
    </section>
  );
}
