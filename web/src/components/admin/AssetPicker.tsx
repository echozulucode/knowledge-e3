/**
 * AssetPicker — choose an uploaded image, or upload one, instead of pasting an
 * `/assets/…` URL (the admin UX review §3.2, §4.2).
 *
 * The pinned-topics editor took covers as typed URLs copied from the Files
 * page; a mistyped one was dropped by the server and the card lost its cover
 * without a word. Here the value is still that URL — what the API stores — but
 * it only ever comes from Files: a thumbnail shows what is chosen, "Choose from
 * Files" opens a searchable grid of uploaded images, and "Upload" sends a new
 * file through the same content-addressed path Files uses (`useUploadImage`)
 * and chooses it.
 *
 * The chooser is a `Modal` that may sit inside another dialog (Pin a topic).
 * It is portalled to `<body>` so the outer dialog's panel (its overflow, its
 * focus trap's idea of "first" and "last") cannot clip or fight it, and
 * `useEscapeLayer` makes Esc close only the chooser.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../Modal.js';
import { useImages, useUploadImage } from '../../queries.js';
import { assetDisplayName, filterAssets } from './assetPickerModel.js';
import { useEscapeLayer } from './useEscapeLayer.js';
import './AssetPicker.css';

export interface AssetPickerProps {
  /**
   * Id of the group. Deliberately NOT the Choose button's: a `<label for>`
   * pointing at a button would rename it "Cover" and hide "Choose from Files"
   * from assistive tech. The group is named by `label` instead.
   */
  id: string;
  /** What is being chosen, e.g. "Cover" — names the group and the chooser's title. */
  label: string;
  /** The chosen asset URL, or '' for none. */
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
  'aria-describedby'?: string;
  testId?: string;
}

export function AssetPicker({ id, label, value, onChange, disabled, testId, ...rest }: AssetPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadImage();

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const asset = await upload.mutateAsync(file);
      onChange(asset.url);
      setOpen(false);
    } catch {
      // Rendered from `upload.error` next to the button.
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div id={id} className="kp-asset" data-testid={testId} role="group" aria-label={label} aria-describedby={rest['aria-describedby']}>
      <div className="kp-asset__thumb" data-empty={!value || undefined}>
        {value ? <img src={value} alt="" /> : <span className="kp-asset__none">No image</span>}
      </div>
      <div className="kp-asset__body">
        {value ? (
          <code className="kp-asset__url" title={value}>
            {value}
          </code>
        ) : null}
        <div className="kp-asset__actions">
          <button type="button" className="kp-asset__button" onClick={() => setOpen(true)} disabled={disabled}>
            Choose from Files
          </button>
          <button type="button" className="kp-asset__button" onClick={() => fileRef.current?.click()} disabled={disabled || upload.isPending}>
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
          {value ? (
            <button type="button" className="kp-asset__button kp-asset__button--quiet" onClick={() => onChange('')} disabled={disabled}>
              Clear
            </button>
          ) : null}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} tabIndex={-1} aria-hidden="true" />
        </div>
        {upload.isError ? (
          <p className="kp-asset__error" role="alert">
            {(upload.error as Error)?.message || 'Upload failed.'}
          </p>
        ) : null}
      </div>
      {open ? (
        <AssetChooser
          label={label}
          value={value}
          uploading={upload.isPending}
          onUpload={() => fileRef.current?.click()}
          onChoose={(url) => {
            onChange(url);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function AssetChooser({
  label,
  value,
  uploading,
  onUpload,
  onChoose,
  onClose,
}: {
  label: string;
  value: string;
  uploading: boolean;
  onUpload: () => void;
  onChoose: (url: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const { data, isLoading, isError, refetch } = useImages();
  const images = useMemo(() => filterAssets(data ?? [], query), [data, query]);
  useEscapeLayer(true, onClose);

  return createPortal(
    <Modal onClose={onClose} labelledBy={titleId} backdropClassName="kp-asset-chooser__backdrop" className="kp-asset-chooser">
      <div className="kp-asset-chooser__head">
        <h2 id={titleId} className="kp-asset-chooser__title">
          Choose {label.toLowerCase()}
        </h2>
        <button type="button" className="kp-asset__button kp-asset__button--quiet" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="kp-asset-chooser__tools">
        <label htmlFor={searchId} className="kp-asset-chooser__searchLabel">
          Search files
        </label>
        <input id={searchId} type="search" className="kp-asset-chooser__search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        <button type="button" className="kp-asset__button" onClick={onUpload} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload new image'}
        </button>
      </div>
      {isLoading ? (
        <p className="kp-asset-chooser__state" role="status">
          Loading files…
        </p>
      ) : isError ? (
        <p className="kp-asset-chooser__state" role="alert">
          Files could not be loaded.{' '}
          <button type="button" className="kp-asset__button kp-asset__button--quiet" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      ) : images.length === 0 ? (
        <p className="kp-asset-chooser__state">{query.trim() ? 'No images match.' : 'No images uploaded yet. Upload one to use it here.'}</p>
      ) : (
        <ul className="kp-asset-chooser__grid" aria-label="Images">
          {images.map((image) => {
            const name = assetDisplayName(image);
            return (
              <li key={image.id}>
                <button type="button" className="kp-asset-chooser__item" aria-pressed={image.url === value} onClick={() => onChoose(image.url)}>
                  <img src={image.url} alt="" loading="lazy" />
                  <span className="kp-asset-chooser__name">{name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>,
    document.body,
  );
}
