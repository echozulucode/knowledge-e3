/**
 * ImagesAdmin — upload and manage attachments (Admin → Files). Bytes live in the
 * bundle's assets/ dir (git-of-record); this page surfaces usage counts, flags
 * orphans (referenced by no page), and — since the server returns the list
 * largest-first — doubles as the "what can I reclaim?" view (ADR-0003 §8).
 *
 * Images render inline and offer copy-Markdown; other attachments (PDF, zip,
 * data files) are downloads and offer copy-link.
 */
import { useRef, useState } from 'react';
import { useImages, useUploadImage, useDeleteImage, type ImageAsset } from '../queries.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { Icon, appIcons } from '../icons.js';
import './OkfAdmin.css';
import './ImagesAdmin.css';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Raster images render as a thumbnail; everything else shows a file icon. */
function isRaster(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime);
}

/** Short type label from a MIME, for the badge. */
function typeLabel(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WEBP',
    'image/svg+xml': 'SVG', 'application/pdf': 'PDF', 'application/zip': 'ZIP',
    'text/csv': 'CSV', 'application/json': 'JSON', 'text/plain': 'TXT',
  };
  return map[mime] ?? mime.split('/').pop()?.toUpperCase() ?? 'FILE';
}

const UPLOAD_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf,application/zip,text/csv,application/json,text/plain';

export function ImagesAdmin() {
  const { data: images = [], isLoading } = useImages();
  const upload = useUploadImage();
  const remove = useDeleteImage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  async function onFiles(files: FileList) {
    setMessage(null);
    setError(null);
    let ok = 0;
    for (const file of Array.from(files)) {
      try {
        await upload.mutateAsync(file);
        ok += 1;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
      }
    }
    if (ok) setMessage(`Uploaded ${ok} file(s).`);
    if (fileInput.current) fileInput.current.value = '';
  }

  /** Copy an insertable reference: image syntax for images, a link otherwise. */
  async function copyReference(a: ImageAsset) {
    const label = a.original_filename ?? a.alt ?? a.file;
    const md = isRaster(a.mime) ? `![${a.alt ?? ''}](${a.url})` : `[${label}](${a.url})`;
    try {
      await navigator.clipboard.writeText(md);
      setMessage(`Copied: ${md}`);
    } catch {
      setMessage(`Markdown: ${md}`);
    }
  }

  async function deleteOrphans() {
    const orphans = images.filter((i) => i.orphan);
    if (!orphans.length) return;
    if (!window.confirm(`Delete ${orphans.length} orphaned file(s)? This cannot be undone.`)) return;
    setMessage(null);
    setError(null);
    let removed = 0;
    for (const o of orphans) {
      try {
        await remove.mutateAsync(o.id);
        removed += 1;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed.');
      }
    }
    if (removed) setMessage(`Deleted ${removed} orphaned file(s).`);
  }

  const shown = onlyOrphans ? images.filter((i) => i.orphan) : images;
  const orphans = images.filter((i) => i.orphan);
  const reclaimable = orphans.reduce((sum, i) => sum + i.byte_size, 0);
  const totalBytes = images.reduce((sum, i) => sum + i.byte_size, 0);

  return (
    <main className="OkfAdmin" aria-labelledby="images-admin-title">
      <AdminTabs />
      <section className="OkfAdmin__hero">
        <div className="OkfAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin data</span>
        </div>
        <h1 id="images-admin-title">Files &amp; attachments</h1>
        <p>
          Uploaded files live in the bundle's <code>assets/</code> directory (part of the git-of-record
          repo). Reference one in any page with the Markdown shown on its card. Images render inline;
          PDFs, archives, and data files download. Files referenced by no page are flagged{' '}
          <strong>orphans</strong> — the list is largest-first so the biggest reclaimable files surface.
        </p>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Upload</h2>
        <input
          ref={fileInput}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          disabled={upload.isPending}
          onChange={(e) => {
            if (e.target.files && e.target.files.length) void onFiles(e.target.files);
          }}
        />
        <p className="OkfAdmin__muted">Allowed: images (PNG/JPG/GIF/WebP/SVG), PDF, ZIP, CSV, JSON, TXT.</p>
        {upload.isPending ? <p role="status">Uploading…</p> : null}
        {message ? <p className="OkfAdmin__success" role="status">{message}</p> : null}
        {error ? <p className="OkfAdmin__error" role="alert">{error}</p> : null}
      </section>

      <section className="OkfAdmin__panel">
        <div className="ImagesAdmin__toolbar">
          <h2>Library ({images.length})</h2>
          <div className="ImagesAdmin__toolbarRight">
            <span className="OkfAdmin__muted">
              {humanSize(totalBytes)} total · {humanSize(reclaimable)} reclaimable
            </span>
            <label className="ImagesAdmin__filter">
              <input type="checkbox" checked={onlyOrphans} onChange={(e) => setOnlyOrphans(e.target.checked)} />
              Only orphans ({orphans.length})
            </label>
            <button
              type="button"
              className="OkfAdmin__dangerBtn"
              disabled={orphans.length === 0 || remove.isPending}
              onClick={() => void deleteOrphans()}
            >
              Delete orphans ({orphans.length})
            </button>
          </div>
        </div>
        {isLoading ? (
          <p>Loading…</p>
        ) : shown.length === 0 ? (
          <p className="OkfAdmin__muted">{onlyOrphans ? 'No orphaned files.' : 'No files yet — upload some above.'}</p>
        ) : (
          <ul className="ImagesAdmin__grid">
            {shown.map((a) => (
              <li key={a.id} className={`ImagesAdmin__card${a.orphan ? ' ImagesAdmin__card--orphan' : ''}`}>
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="ImagesAdmin__thumbWrap">
                  {isRaster(a.mime) ? (
                    <img src={a.url} alt={a.alt ?? a.file} loading="lazy" className="ImagesAdmin__thumb" />
                  ) : (
                    <span className="ImagesAdmin__fileGlyph" aria-hidden="true">
                      <Icon icon={appIcons.fileLines ?? appIcons.layerGroup} fixedWidth={false} />
                      <span className="ImagesAdmin__fileGlyphExt">{typeLabel(a.mime)}</span>
                    </span>
                  )}
                </a>
                <div className="ImagesAdmin__meta">
                  <span className="ImagesAdmin__file" title={a.file}>
                    {a.original_filename ?? a.file}
                  </span>
                  <span className="ImagesAdmin__sub">
                    {typeLabel(a.mime)} · {humanSize(a.byte_size)} · {new Date(a.created_at).toLocaleDateString()}
                  </span>
                  <span className={a.orphan ? 'OkfAdmin__error' : 'OkfAdmin__success'}>
                    {a.orphan ? 'Orphan' : `Used by ${a.used_by}`}
                  </span>
                </div>
                <div className="OkfAdmin__actions">
                  <button type="button" onClick={() => void copyReference(a)}>
                    {isRaster(a.mime) ? 'Copy Markdown' : 'Copy link'}
                  </button>
                  <a href={a.url} download className="ImagesAdmin__download" target="_blank" rel="noopener noreferrer">
                    Download
                  </a>
                  <button type="button" onClick={() => void remove.mutateAsync(a.id)} disabled={remove.isPending} title="Delete file">
                    <Icon icon={appIcons.xmark} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
