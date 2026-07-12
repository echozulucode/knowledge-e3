/**
 * OkfAdmin — the human-facing OKF data bridge (Admin → Data).
 *
 * Export downloads the whole library (optionally one topic) as an Open Knowledge
 * Format bundle in a JSON envelope; import uploads such a file back. Re-importing
 * an export updates items in place (matched on their embedded e3_id), so this
 * doubles as backup/restore and instance-to-instance transfer. A directory of
 * `.md` files is also available via the CLI and the git-of-record mirror.
 */
import { useEffect, useRef, useState } from 'react';
import { apiClient, type ApiError } from '../api.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { Icon, appIcons } from '../icons.js';
import './OkfAdmin.css';

interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  issues: { path: string; severity: string; message: string }[];
}

interface ExportResponse {
  okf_version: string;
  item_count: number;
  conformance: ConformanceReport;
  files: { path: string; content: string }[];
}

interface ImportResponse {
  created: number;
  updated: number;
  ids: string[];
  conformance: ConformanceReport;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as ApiError).message) || fallback;
  }
  return fallback;
}

export function OkfAdmin() {
  const [space, setSpace] = useState('');
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // `webkitdirectory` enables folder selection but isn't in the React input types,
  // so set it imperatively. This lets a user import a real OKF bundle directory
  // (e.g. a checked-out git repo of .md files), not just a JSON envelope.
  useEffect(() => {
    if (folderInput.current) {
      folderInput.current.setAttribute('webkitdirectory', '');
      folderInput.current.setAttribute('directory', '');
    }
  }, []);

  async function handleExport() {
    setBusy('export');
    setMessage(null);
    setError(null);
    try {
      const query = space.trim() ? `?space=${encodeURIComponent(space.trim())}` : '';
      const data = await apiClient.get<ExportResponse>(`/okf/export${query}`);
      const stamp = new Date().toISOString().slice(0, 10);
      const suffix = space.trim() ? `-${space.trim()}` : '';
      downloadJson(`knowledge-okf${suffix}-${stamp}.json`, data);
      const conform = data.conformance.conformant ? 'conformant' : 'NON-CONFORMANT';
      setMessage(`Exported ${data.item_count} item(s) — bundle is ${conform} (OKF v${data.okf_version}).`);
    } catch (err) {
      setError(errorMessage(err, 'Export failed.'));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(files: { path: string; content: string }[]) {
    setBusy('import');
    setMessage(null);
    setError(null);
    try {
      if (files.length === 0) throw new Error('No OKF concept files found.');
      const result = await apiClient.post<ImportResponse>('/okf/import', { files });
      const conform = result.conformance.conformant ? '' : ' (source bundle had conformance issues)';
      setMessage(`Imported: ${result.created} created, ${result.updated} updated.${conform}`);
    } catch (err) {
      setError(errorMessage(err, 'Import failed.'));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  }

  /** Import a single JSON envelope ({ files }) previously exported here. */
  async function handleExportArchive() {
    setBusy('export');
    setMessage(null);
    setError(null);
    try {
      const query = space.trim() ? `?space=${encodeURIComponent(space.trim())}` : '';
      const res = await fetch(`/api/v1/okf/export/archive${query}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Export failed (${res.status}).`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const suffix = space.trim() ? `-${space.trim()}` : '';
      downloadBlob(`knowledge-okf${suffix}-${stamp}.tar.gz`, blob);
      const count = res.headers.get('x-okf-item-count') ?? '?';
      setMessage(`Downloaded a .tar.gz bundle of ${count} item(s) — extract it and \`git init\` to start a repo.`);
    } catch (err) {
      setError(errorMessage(err, 'Export failed.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as { files?: unknown };
      const files = Array.isArray(parsed.files) ? parsed.files : Array.isArray(parsed) ? parsed : null;
      if (!files) throw new Error('Unrecognized file — expected an OKF bundle with a "files" array.');
      await runImport(files as { path: string; content: string }[]);
    } catch (err) {
      setError(errorMessage(err, 'Import failed.'));
      setBusy(null);
    }
  }

  /** Import a real OKF bundle directory (a folder of .md files, e.g. a git repo). */
  async function handleImportFolder(fileList: FileList) {
    try {
      const mdFiles = Array.from(fileList).filter(
        (f) => f.name.endsWith('.md') && !relPath(f).split('/').includes('.git'),
      );
      const files = await Promise.all(
        mdFiles.map(async (f) => ({ path: relPath(f), content: await f.text() })),
      );
      await runImport(files);
    } catch (err) {
      setError(errorMessage(err, 'Import failed.'));
      setBusy(null);
    }
  }

  return (
    <main className="OkfAdmin" aria-labelledby="okf-admin-title">
      <AdminTabs />
      <section className="OkfAdmin__hero">
        <div className="OkfAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin data</span>
        </div>
        <h1 id="okf-admin-title">Open Knowledge Format</h1>
        <p>
          Export your library as an OKF bundle for backup, sharing, or moving between instances — and
          import one back. Re-importing an export updates items in place (matched on their stable id),
          so nothing is duplicated. A directory of <code>.md</code> files is also produced by the
          git-of-record mirror and the <code>export:okf</code> CLI.
        </p>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Export</h2>
        <p>
          Download a conformant OKF bundle. The <strong>.tar.gz</strong> contains the real
          Markdown concept files (extract it and <code>git init</code> to start a backend repo);
          the <strong>.json</strong> is a single-file envelope for quick re-import here.
        </p>
        <label className="OkfAdmin__field">
          <span>Space (optional)</span>
          <input
            value={space}
            onChange={(e) => setSpace(e.target.value)}
            placeholder="Leave blank to export everything; or a topic slug/name"
          />
        </label>
        <div className="OkfAdmin__actions">
          <button type="button" onClick={() => void handleExportArchive()} disabled={busy !== null}>
            <Icon icon={appIcons.floppyDisk} />
            {busy === 'export' ? 'Exporting…' : 'Download .tar.gz (full bundle)'}
          </button>
          <button type="button" onClick={() => void handleExport()} disabled={busy !== null}>
            <Icon icon={appIcons.fileLines} />
            Download .json
          </button>
        </div>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Import</h2>
        <p>
          Import an OKF bundle. Choose a <strong>folder</strong> (a real bundle directory, e.g. a
          checked-out git repo of <code>.md</code> files) or a single <strong>JSON file</strong>
          previously exported here. Concepts are matched on their embedded id then title, so
          re-importing updates rather than duplicates.
        </p>
        <label className="OkfAdmin__field">
          <span>Bundle folder (.md files)</span>
          <input
            ref={folderInput}
            type="file"
            multiple
            disabled={busy !== null}
            onChange={(e) => {
              if (e.target.files && e.target.files.length) void handleImportFolder(e.target.files);
            }}
          />
        </label>
        <label className="OkfAdmin__field">
          <span>Bundle file (.json)</span>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />
        </label>
        {busy === 'import' ? <p role="status">Importing…</p> : null}
      </section>

      {message ? <p className="OkfAdmin__success" role="status">{message}</p> : null}
      {error ? <p className="OkfAdmin__error" role="alert">{error}</p> : null}
    </main>
  );
}

/** Bundle-relative path for a picked file (folder selection sets webkitRelativePath). */
function relPath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function downloadJson(filename: string, data: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
