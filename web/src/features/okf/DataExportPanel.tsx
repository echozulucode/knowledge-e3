/**
 * Data → Export (the admin UX review §4.9): a topic (or the whole
 * library), a format, one Download. The two formats are the two export routes:
 * the `.tar.gz` archive (concepts plus every referenced image and attachment)
 * and the `.json` envelope (concepts only, for quick re-import here).
 */
import { useState } from 'react';
import { apiClient, type ApiError } from '../../api.js';
import type { Topic } from '../../queries.js';
import { Icon, appIcons } from '../../icons.js';

type ExportFormat = 'archive' | 'json';

interface ExportResponse {
  okf_version: string;
  item_count: number;
  conformance: { conformant: boolean };
  files: { path: string; content: string }[];
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as ApiError).message) || fallback;
  return fallback;
}

export function DataExportPanel({ topics }: { topics: readonly Topic[] }) {
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState<ExportFormat>('archive');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ message?: string; error?: string } | null>(null);

  const query = topic ? `?space=${encodeURIComponent(topic)}` : '';
  const stamp = () => new Date().toISOString().slice(0, 10);
  const suffix = topic ? `-${topic}` : '';

  async function download() {
    setBusy(true);
    setOutcome(null);
    try {
      if (format === 'json') {
        const data = await apiClient.get<ExportResponse>(`/okf/export${query}`);
        downloadBlob(`knowledge-okf${suffix}-${stamp()}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const conform = data.conformance.conformant ? 'conformant' : 'NON-CONFORMANT';
        setOutcome({ message: `Exported ${data.item_count} item(s) — bundle is ${conform} (OKF v${data.okf_version}).` });
      } else {
        const res = await fetch(`/api/v1/okf/export/archive${query}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`Export failed (${res.status}).`);
        const blob = await res.blob();
        downloadBlob(`knowledge-okf${suffix}-${stamp()}.tar.gz`, blob);
        const count = res.headers.get('x-okf-item-count') ?? '?';
        setOutcome({ message: `Downloaded a .tar.gz bundle of ${count} item(s) — extract it and \`git init\` to start a repo.` });
      }
    } catch (err) {
      setOutcome({ error: errorMessage(err, 'Export failed.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="OkfAdmin__panel" aria-labelledby="data-export-title">
      <h2 id="data-export-title">Export</h2>
      <p className="DataAdmin__lead">Download the library, or one topic, as an OKF bundle for backup or moving to another instance.</p>
      <label className="DataAdmin__field">
        <span>Topic</span>
        <select value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Export topic">
          <option value="">All topics</option>
          {topics.map((t) => (
            <option key={t.id} value={t.slug}>
              {t.name.trim() || t.slug}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="DataAdmin__formats">
        <legend>Format</legend>
        <label>
          <input type="radio" name="data-export-format" value="archive" checked={format === 'archive'} onChange={() => setFormat('archive')} />
          <span>
            <strong>.tar.gz archive</strong> (recommended) — Markdown concept files plus every referenced image and attachment. Extract it
            and <code>git init</code> to start a repository.
          </span>
        </label>
        <label>
          <input type="radio" name="data-export-format" value="json" checked={format === 'json'} onChange={() => setFormat('json')} />
          <span>
            <strong>.json envelope</strong> — concepts only, for a quick re-import here.
          </span>
        </label>
      </fieldset>
      <div className="OkfAdmin__actions">
        <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => void download()} disabled={busy}>
          <Icon icon={appIcons.floppyDisk} />
          {busy ? 'Exporting…' : 'Download'}
        </button>
      </div>
      {outcome ? (
        <div className="OkfAdmin__outcome" data-outcome="export">
          {outcome.message ? (
            <p className="OkfAdmin__success" role="status">
              {outcome.message}
            </p>
          ) : null}
          {outcome.error ? (
            <p className="OkfAdmin__error" role="alert">
              {outcome.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
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
