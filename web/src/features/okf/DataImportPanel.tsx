/**
 * Data → Import (the admin UX review §4.9): a three-step stepper
 * in one card.
 *
 *   1. Choose — one drop zone (archive recommended) with keyboard-reachable
 *      "Choose file…" / "Choose folder…" buttons, replacing three raw inputs.
 *   2. Review — the gate's own dry-run report (`BundleReport`), what the import
 *      would change, and Continue only when the bundle is conformant.
 *   3. Import — a plain statement of what Import writes, the button, then the
 *      outcome (or the 422 refusal report) in the same card, focused so it is
 *      never painted off-screen.
 *
 * Import semantics are unchanged (the admin UX plan A3): validating writes
 * nothing, and the server gates the import again — the preview is not a permit.
 * The chosen bundle is held in a ref between steps so the bytes that were
 * validated are the bytes that get imported.
 */
import { useEffect, useReducer, useRef, useState, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { apiClient, type ApiError } from '../../api.js';
import { Icon, appIcons } from '../../icons.js';
import { BundleReport } from './BundleReport.js';
import { postArchive } from './archiveRequest.js';
import { asBundleReport, importReadiness, refusalReport } from './bundleReportModel.js';
import {
  IMPORT_STEPS,
  INITIAL_IMPORT_STATE,
  canContinue,
  canImport,
  classifyBundleChoice,
  importOutcomeText,
  importReducer,
  importStatement,
  stepStatus,
  wouldChangeText,
  type ChosenFile,
} from './dataAdminModel.js';

interface BundleFile {
  path: string;
  content: string;
}

type Candidate = { kind: 'files'; files: BundleFile[] } | { kind: 'archive'; file: File };

/**
 * What `POST /okf/import*` returns. It has never carried a `conformance` field
 * (issue 105); `validation` is the gate's report, and anything in its policy
 * tier imported anyway.
 */
interface ImportResponse {
  created: number;
  updated: number;
  assets_imported?: number;
  assets_failed?: number;
  validation?: { summary: { policyErrorCount: number } };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as ApiError).message) || fallback;
  return fallback;
}

/** Bundle-relative path for a picked file (folder selection sets webkitRelativePath). */
function relPath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

export function DataImportPanel() {
  const [state, dispatch] = useReducer(importReducer, INITIAL_IMPORT_STATE);
  const candidate = useRef<Candidate | null>(null);
  // The latest choice's token; a validation answering an older one is dropped.
  const selection = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [dragging, setDragging] = useState(false);

  // `webkitdirectory` is not in React's input types, so set it imperatively.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  // Review §2 #12: results used to land ~600px below the button. Whatever the
  // step produced — a verdict, an outcome, a refusal — is brought into view and focused.
  useEffect(() => {
    if ((state.outcome || state.refusal) && resultHeading.current) {
      resultHeading.current.focus();
      resultHeading.current.scrollIntoView?.({ block: 'nearest' });
    }
  }, [state.outcome, state.refusal]);
  useEffect(() => {
    if (state.step === 'review' && state.phase === 'idle' && reviewHeading.current) {
      reviewHeading.current.scrollIntoView?.({ block: 'nearest' });
    }
  }, [state.step, state.phase]);

  function restartToken() {
    selection.current += 1;
    candidate.current = null;
  }

  /** Step 1 → 2: read the choice, then validate it with the import gate's own evaluation. */
  async function choose(list: FileList | File[]) {
    const files = Array.from(list);
    // A browser does not fire `change` for the same file chosen twice, and "fix
    // the bundle, choose it again" is exactly the loop this page exists for.
    if (fileInput.current) fileInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
    const chosen: ChosenFile[] = files.map((f) => ({ name: f.name, path: relPath(f) }));
    const kind = classifyBundleChoice(chosen);
    if (kind.kind === 'invalid') {
      restartToken();
      dispatch({ type: 'chooseFailed', message: kind.message });
      return;
    }

    let next: Candidate;
    let label: string;
    try {
      if (kind.kind === 'archive') {
        next = { kind: 'archive', file: files[kind.index]! };
        label = files[kind.index]!.name;
      } else if (kind.kind === 'json') {
        const file = files[kind.index]!;
        const parsed = JSON.parse(await file.text()) as { files?: unknown };
        const bundle = Array.isArray(parsed.files) ? parsed.files : Array.isArray(parsed) ? parsed : null;
        if (!bundle) throw new Error('Unrecognized file — expected an OKF bundle with a "files" array.');
        next = { kind: 'files', files: bundle as BundleFile[] };
        label = file.name;
      } else {
        const md = kind.indices.map((i) => files[i]!);
        next = { kind: 'files', files: await Promise.all(md.map(async (f) => ({ path: relPath(f), content: await f.text() }))) };
        label = kind.label;
      }
    } catch (err) {
      restartToken();
      dispatch({ type: 'chooseFailed', message: errorMessage(err, 'The file could not be read.') });
      return;
    }

    selection.current += 1;
    const token = selection.current;
    candidate.current = next;
    dispatch({ type: 'choose', label, selection: token });
    try {
      const body =
        next.kind === 'files'
          ? await apiClient.post<unknown>('/okf/validate', { files: next.files })
          : await postArchive<unknown>('/okf/validate/archive', next.file);
      if (token !== selection.current) return;
      const report = asBundleReport(body);
      if (!report) throw new Error('The server returned an unrecognized validation report.');
      dispatch({ type: 'validated', selection: token, report });
    } catch (err) {
      if (token !== selection.current) return;
      dispatch({ type: 'validationFailed', selection: token, message: errorMessage(err, 'Validation failed.') });
    }
  }

  /** Step 3: import the bundle that was validated. A 422 renders as its per-file report. */
  async function runImport() {
    const current = candidate.current;
    if (!current || !canImport(state)) return;
    dispatch({ type: 'importStarted' });
    try {
      const result =
        current.kind === 'files'
          ? await apiClient.post<ImportResponse>('/okf/import', { files: current.files })
          : await postArchive<ImportResponse>('/okf/import/archive', current.file);
      // Cleared so the same bundle cannot be imported twice.
      candidate.current = null;
      dispatch({
        type: 'imported',
        outcome: {
          created: result.created,
          updated: result.updated,
          assetsImported: result.assets_imported ?? 0,
          assetsFailed: result.assets_failed ?? 0,
          // Optional-chained: an older server omits the report, and a missing report
          // must not turn a successful import into a failure (issue 105).
          policyErrors: result.validation?.summary.policyErrorCount ?? 0,
        },
      });
    } catch (err) {
      dispatch({ type: 'importFailed', message: errorMessage(err, 'Import failed.'), refusal: refusalReport(err) });
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void choose(event.dataTransfer.files);
  }

  const readiness = state.report ? importReadiness(state.report) : null;
  const status =
    state.phase === 'validating'
      ? `Validating ${state.label}…`
      : state.phase === 'importing'
        ? 'Importing…'
        : state.step === 'review' && readiness
          ? readiness.note
          : '';
  const change = state.report ? wouldChangeText(state.report) : null;

  return (
    <section className="OkfAdmin__panel DataImport" aria-labelledby="data-import-title" data-step={state.step}>
      <h2 id="data-import-title">Import</h2>
      <ol className="DataImport__steps" aria-label="Import steps">
        {IMPORT_STEPS.map(({ step, label }, n) => {
          const s = stepStatus(state.step, step);
          return (
            <li key={step} data-status={s} aria-current={s === 'current' ? 'step' : undefined}>
              <span className="DataImport__stepNumber" aria-hidden="true">
                {s === 'done' ? '✓' : n + 1}
              </span>
              <span>
                {label}
                {s === 'done' ? <span className="DataAdmin__vh"> (done)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Always rendered, so a screen reader announces each change — validating,
          the verdict, importing. A live region inserted with its content is often not read. */}
      <p className="OkfAdmin__importStatus" role="status" aria-live="polite" data-readiness={state.step === 'review' ? readiness?.kind : undefined}>
        {status}
      </p>

      {state.step === 'choose' ? (
        <div className="DataImport__body">
          <div
            className="DataImport__drop"
            data-dragging={dragging ? 'true' : undefined}
            data-testid="bundle-drop-zone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Icon icon={appIcons.floppyDisk} />
            <p className="DataImport__dropTitle">Drop an OKF bundle here</p>
            <p className="DataImport__dropHint">
              <strong>Archive recommended:</strong> a <code>.tar.gz</code> restores concepts and their images and attachments. A{' '}
              <code>.json</code> bundle or a folder of <code>.md</code> files restores concepts only. Choosing a bundle checks it first;
              nothing is written.
            </p>
            <div className="OkfAdmin__actions">
              <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => fileInput.current?.click()}>
                Choose file…
              </button>
              <button type="button" className="kp-admin-button" onClick={() => folderInput.current?.click()}>
                Choose folder…
              </button>
            </div>
            <input
              ref={fileInput}
              className="DataAdmin__vh"
              type="file"
              tabIndex={-1}
              aria-label="Bundle file"
              accept=".tar.gz,.tgz,.gz,application/gzip,.json,application/json,.md"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) void choose(e.target.files);
              }}
            />
            <input
              ref={folderInput}
              className="DataAdmin__vh"
              type="file"
              tabIndex={-1}
              aria-label="Bundle folder"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) void choose(e.target.files);
              }}
            />
          </div>
          {state.error ? (
            <p className="OkfAdmin__error" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.step === 'review' ? (
        <div className="DataImport__body">
          <h3 ref={reviewHeading} tabIndex={-1}>
            Review <code>{state.label}</code>
          </h3>
          {change ? (
            <p className="DataImport__change" data-testid="would-change">
              {change}
            </p>
          ) : null}
          {state.error ? (
            <p className="OkfAdmin__error" role="alert">
              {state.error}
            </p>
          ) : null}
          {state.report ? <BundleReport report={state.report} title="Validation" subject={state.label ?? ''} kind="validation" /> : null}
          <div className="OkfAdmin__actions DataImport__nav">
            <button type="button" className="kp-admin-button" onClick={() => {
              restartToken();
              dispatch({ type: 'back' });
            }} disabled={state.phase !== 'idle'}>
              Choose a different bundle
            </button>
            <button
              type="button"
              className="kp-admin-button kp-admin-button--primary"
              onClick={() => dispatch({ type: 'continue' })}
              disabled={!canContinue(state)}
              aria-describedby="data-import-continue-why"
            >
              Continue
            </button>
          </div>
          <p id="data-import-continue-why" className="OkfAdmin__hint">
            {state.phase === 'validating'
              ? 'Continue is available once validation finishes.'
              : !state.report
                ? 'Continue is available after a successful validation. Choose the bundle again to retry.'
                : canContinue(state)
                  ? 'Nothing has been written yet.'
                  : 'Continue is disabled: the bundle is not conformant. Fix it and choose it again.'}
          </p>
        </div>
      ) : null}

      {state.step === 'import' ? (
        <div className="DataImport__body">
          {state.outcome ? (
            <div className="OkfAdmin__outcome" data-outcome="import">
              <h3 ref={resultHeading} tabIndex={-1}>
                Import complete
              </h3>
              <p className="OkfAdmin__success" role="status">
                {importOutcomeText(state.outcome)}
              </p>
              <p className="DataImport__links">
                <Link to="/admin/health">Open Content health</Link>
                <Link to="/admin/audit" search={{ action: 'okf.import' } as never}>
                  View in the audit log
                </Link>
              </p>
              <div className="OkfAdmin__actions">
                <button type="button" className="kp-admin-button" onClick={() => {
                  restartToken();
                  dispatch({ type: 'reset' });
                }}>
                  Import another bundle
                </button>
              </div>
            </div>
          ) : state.refusal || (state.error && !state.report) ? (
            <div className="OkfAdmin__outcome" data-outcome="import">
              <h3 ref={resultHeading} tabIndex={-1}>
                {state.refusal ? 'Import refused' : 'Import failed'}
              </h3>
              <p className="OkfAdmin__error" role="alert">
                {state.error}
              </p>
              <p className="DataImport__links">
                <Link to="/admin/audit" search={{ action: 'okf.import_rejected' } as never}>
                  View in the audit log
                </Link>
              </p>
              {state.refusal ? <BundleReport report={state.refusal} title="Import refused" subject={state.label ?? ''} kind="refusal" /> : null}
              <div className="OkfAdmin__actions">
                <button type="button" className="kp-admin-button" onClick={() => {
                  restartToken();
                  dispatch({ type: 'back' });
                }}>
                  Choose a different bundle
                </button>
              </div>
            </div>
          ) : state.report ? (
            <>
              <h3>
                Import <code>{state.label}</code>
              </h3>
              <ul className="DataImport__statement" data-testid="import-statement">
                {importStatement(state.report).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="OkfAdmin__actions DataImport__nav">
                <button type="button" className="kp-admin-button" onClick={() => dispatch({ type: 'back' })} disabled={state.phase !== 'idle'}>
                  Back
                </button>
                <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => void runImport()} disabled={!canImport(state)}>
                  <Icon icon={appIcons.floppyDisk} />
                  {state.phase === 'importing' ? 'Importing…' : 'Import'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
