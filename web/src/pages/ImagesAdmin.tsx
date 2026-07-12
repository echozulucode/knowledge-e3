/**
 * ImagesAdmin — upload, view, and manage images (Admin → Images). Images are
 * stored in the bundle's assets/ dir (git-of-record); this page surfaces usage
 * counts and flags orphans (images no page references). Editor insertion is a
 * separate, upcoming phase — for now, copy an image's Markdown from here.
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

export function ImagesAdmin() {
  const { data: images = [], isLoading } = useImages();
  const upload = useUploadImage();
  const remove = useDeleteImage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  async function onFiles(files: FileList) {
    setMessage(null);
    let ok = 0;
    for (const file of Array.from(files)) {
      try {
        await upload.mutateAsync(file);
        ok += 1;
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Upload failed.');
      }
    }
    if (ok) setMessage(`Uploaded ${ok} image(s).`);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function copyMarkdown(img: ImageAsset) {
    const md = `![${img.alt ?? ''}](${img.url})`;
    try {
      await navigator.clipboard.writeText(md);
      setMessage(`Copied Markdown: ${md}`);
    } catch {
      setMessage(`Markdown: ${md}`);
    }
  }

  const shown = onlyOrphans ? images.filter((i) => i.orphan) : images;
  const orphanCount = images.filter((i) => i.orphan).length;

  return (
    <main className="OkfAdmin" aria-labelledby="images-admin-title">
      <AdminTabs />
      <section className="OkfAdmin__hero">
        <div className="OkfAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin data</span>
        </div>
        <h1 id="images-admin-title">Images</h1>
        <p>
          Uploaded images live in the bundle's <code>assets/</code> directory (part of the git-of-record
          repo). Reference one in any page with the Markdown shown on its card. Images referenced by no
          page are flagged as <strong>orphans</strong>.
        </p>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Upload</h2>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          disabled={upload.isPending}
          onChange={(e) => {
            if (e.target.files && e.target.files.length) void onFiles(e.target.files);
          }}
        />
        {upload.isPending ? <p role="status">Uploading…</p> : null}
        {message ? <p className="OkfAdmin__success" role="status">{message}</p> : null}
      </section>

      <section className="OkfAdmin__panel">
        <div className="ImagesAdmin__toolbar">
          <h2>Library ({images.length})</h2>
          <label className="ImagesAdmin__filter">
            <input type="checkbox" checked={onlyOrphans} onChange={(e) => setOnlyOrphans(e.target.checked)} />
            Only orphans ({orphanCount})
          </label>
        </div>
        {isLoading ? (
          <p>Loading…</p>
        ) : shown.length === 0 ? (
          <p className="OkfAdmin__muted">{onlyOrphans ? 'No orphaned images.' : 'No images yet — upload some above.'}</p>
        ) : (
          <ul className="ImagesAdmin__grid">
            {shown.map((img) => (
              <li key={img.id} className={`ImagesAdmin__card${img.orphan ? ' ImagesAdmin__card--orphan' : ''}`}>
                <a href={img.url} target="_blank" rel="noopener noreferrer" className="ImagesAdmin__thumbWrap">
                  <img src={img.url} alt={img.alt ?? img.file} loading="lazy" className="ImagesAdmin__thumb" />
                </a>
                <div className="ImagesAdmin__meta">
                  <span className="ImagesAdmin__file" title={img.file}>{img.file}</span>
                  <span>{humanSize(img.byte_size)}</span>
                  <span className={img.orphan ? 'OkfAdmin__error' : 'OkfAdmin__success'}>
                    {img.orphan ? 'Orphan' : `Used by ${img.used_by}`}
                  </span>
                </div>
                <div className="OkfAdmin__actions">
                  <button type="button" onClick={() => void copyMarkdown(img)}>Copy Markdown</button>
                  <button type="button" onClick={() => void remove.mutateAsync(img.id)} disabled={remove.isPending} title="Delete image">
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
