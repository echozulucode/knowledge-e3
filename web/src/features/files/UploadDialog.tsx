/**
 * Upload files (Admin → Files, the admin UX review §4.9): a drop
 * zone with a keyboard-reachable "Choose files" button, and one row per file
 * with its own progress bar and, when the server refuses it, the reason next
 * to that file — not a single error for the whole batch at the end of the page.
 *
 * The page owns the queue (useUploadQueue), so closing this dialog leaves
 * uploads running; the toast still arrives when they finish.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { Modal } from '../../components/Modal.js';
import { humanSize, type UploadEntry } from './filesModel.js';

/** What the server's attachment policy accepts (server/src/images/attachment-policy.ts). */
export const UPLOAD_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf,application/zip,text/csv,application/json,text/plain';

export interface UploadDialogProps {
  entries: UploadEntry[];
  busy: boolean;
  onFiles: (files: File[]) => void;
  onClearFinished: () => void;
  onClose: () => void;
}

export function UploadDialog({ entries, busy, onFiles, onClearFinished, onClose }: UploadDialogProps): JSX.Element {
  const titleId = useId();
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // The page-level drop overlay must not also take this drop.
    e.stopPropagation();
    setOver(false);
    if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
  };

  const finished = entries.some((e) => e.status === 'done' || e.status === 'error');

  return (
    <Modal onClose={onClose} labelledBy={titleId} backdropClassName="kp-confirm-backdrop" className="Files__uploadDialog">
      <div className="Files__uploadHead">
        <h2 id={titleId} className="Files__uploadTitle">
          Upload files
        </h2>
        <button type="button" className="kp-sheet__close" onClick={onClose} aria-label="Close upload">
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div
        className="Files__drop"
        data-over={over || undefined}
        data-testid="files-drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p className="Files__dropText">Drop files here, or</p>
        <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => input.current?.click()} aria-describedby={helpId}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="Files__fileInput"
          data-testid="files-upload-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
        <p id={helpId} className="Files__dropHelp">
          PNG, JPG, GIF, WebP up to 10 MB · SVG up to 2 MB · PDF, ZIP up to 25 MB · CSV, JSON, TXT up to 10 MB
        </p>
      </div>

      {entries.length > 0 ? (
        // Not aria-live: "Uploading 45%" would be announced at every step. A
        // refusal is role="alert" on its row, and the batch ends in a toast.
        <ul className="Files__uploads" aria-label="Uploads">
          {entries.map((entry) => (
            <UploadRow key={entry.key} entry={entry} />
          ))}
        </ul>
      ) : null}

      <div className="Files__uploadFoot">
        {finished ? (
          <button type="button" className="kp-admin-button" onClick={onClearFinished}>
            Clear finished
          </button>
        ) : null}
        <button type="button" className="kp-admin-button" onClick={onClose}>
          {busy ? 'Hide (uploads continue)' : 'Done'}
        </button>
      </div>
    </Modal>
  );
}

function UploadRow({ entry }: { entry: UploadEntry }): JSX.Element {
  const percent = Math.round(entry.progress * 100);
  const status =
    entry.status === 'queued'
      ? 'Waiting'
      : entry.status === 'uploading'
        ? `Uploading ${percent}%`
        : entry.status === 'done'
          ? 'Uploaded'
          : 'Not uploaded';
  return (
    <li className="Files__upload" data-status={entry.status} data-testid="files-upload-row">
      <div className="Files__uploadLine">
        <span className="Files__uploadName" title={entry.name}>
          {entry.name}
        </span>
        <span className="Files__uploadMeta">
          {humanSize(entry.size)} · <span data-testid="files-upload-status">{status}</span>
        </span>
      </div>
      {entry.status === 'uploading' || entry.status === 'queued' ? (
        <progress className="Files__progress" max={100} value={percent} aria-label={`${entry.name} upload progress`} />
      ) : null}
      {entry.status === 'error' && entry.error ? (
        <p className="Files__uploadError" role="alert">
          {entry.error}
        </p>
      ) : null}
    </li>
  );
}
