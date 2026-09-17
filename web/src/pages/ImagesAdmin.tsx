/**
 * ImagesAdmin — Admin → Files (`/admin/images`, the admin UX review §4.9).
 * Bytes live in the bundle's assets/ dir (git-of-record, ADR-0003); this page
 * answers "what is in the library, what uses it, and what can go?".
 *
 * The old page was a thumbnail wall with no search, a "Used by N" that led
 * nowhere, orphans drawn in the error colour, and results painted at the end
 * of the page. Now:
 *
 *   ?q= &type= &usage= &sort= &page=   the toolbar, filtered and paged on the server
 *   ?view=grid|list                    only when chosen; otherwise list above 50 files
 *   ?file=<id>                         the detail sheet, with the items that use it
 *
 * so a filtered library or one file is a link. Each card or row has one primary
 * action (open details) and a `⋯` menu; Delete is disabled with its reason as
 * text while anything uses the file, and confirmed otherwise. Uploads take a
 * drop anywhere on the page or the Upload dialog, with per-file progress and
 * per-file errors; every outcome is a toast or sits next to its file.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { OverflowMenu, type OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { Sheet } from '../components/admin/Sheet.js';
import { useEscapeLayer } from '../components/admin/useEscapeLayer.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { pushToast } from '../hooks/useToast.js';
import { Icon, appIcons } from '../icons.js';
import { useDeleteImage, type ImageAsset } from '../queries.js';
import { imageActionError } from '../features/admin/imageAssetPolicy.js';
import { FileDetailSheet, UsageBadge } from '../features/files/FileDetailSheet.js';
import { UploadDialog } from '../features/files/UploadDialog.js';
import { useUploadQueue } from '../features/files/useUploadQueue.js';
import { fetchUnusedFiles, useFileDetail, useFilesPage, useInvalidateFiles } from '../features/files/queries.js';
import { absoluteTime, shortDate } from '../features/users/usersModel.js';
import {
  FILES_PAGE_SIZE,
  FILE_KIND_OPTIONS,
  FILE_SORT_OPTIONS,
  FILE_USAGE_OPTIONS,
  deleteBlockedReason,
  effectiveView,
  fileDisplayName,
  filesListParams,
  filesSearchToParams,
  hasFileFilters,
  humanSize,
  isRaster,
  libraryMeta,
  markdownReference,
  pageCount,
  pageRangeText,
  readFilesSearch,
  typeLabel,
  withFilters,
  type FileKind,
  type FileSort,
  type FileUsageFilter,
  type FilesSearch,
  type FilesView,
} from '../features/files/filesModel.js';
import './ImagesAdmin.css';

const SEARCH_DEBOUNCE_MS = 300;

async function copyToClipboard(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ kind: 'success', message: `Copied ${what}.` });
  } catch {
    // No clipboard permission (or an insecure origin): show the text so it can be copied by hand.
    pushToast({ kind: 'error', message: `Couldn't copy. ${what}: ${text}` });
  }
}

function download(asset: ImageAsset): void {
  const a = document.createElement('a');
  a.href = asset.url;
  a.download = fileDisplayName(asset);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ImagesAdmin() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const state = readFilesSearch(rawSearch);
  const remove = useDeleteImage();
  const invalidate = useInvalidateFiles();
  const uploads = useUploadQueue();

  const go = (next: FilesSearch, replace = false) => {
    void navigate({ to: '/admin/images', search: filesSearchToParams(next) as never, replace });
  };

  // Search: typed locally, pushed to the URL after a pause (replace, so a typed
  // word is one history entry). `pushedQ` tells our own navigation apart from
  // an outside one (Back, a pasted link), which must overwrite the box.
  const [qInput, setQInput] = useState(state.q);
  const debouncedQ = useDebouncedValue(qInput, SEARCH_DEBOUNCE_MS);
  const pushedQ = useRef(state.q);
  useEffect(() => {
    if (debouncedQ.trim() === state.q.trim()) return;
    pushedQ.current = debouncedQ.trim();
    go(withFilters(state, { q: debouncedQ }), true);
    // `state` is rebuilt every render; only the debounced text should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    if (state.q.trim() !== pushedQ.current) {
      pushedQ.current = state.q.trim();
      setQInput(state.q);
    }
  }, [state.q]);

  const listQuery = useFilesPage(filesListParams(state));
  const page = listQuery.data;
  const rows = page?.images ?? [];
  const total = page?.total ?? 0;
  const summary = page?.summary;
  const view = effectiveView(state.view, summary?.count);

  // A page past the end (its last file was just deleted, or a link outlived the data): step back.
  useEffect(() => {
    if (page && !listQuery.isPlaceholderData && rows.length === 0 && total > 0 && state.page > 1) {
      go({ ...state, page: pageCount(total) }, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, listQuery.isPlaceholderData, rows.length, total, state.page]);

  // The sheet's file: the row on screen when there is one, else fetched by id
  // so a shared `?file=` link opens on any page.
  const detailQuery = useFileDetail(state.file);
  const rowFile = state.file ? rows.find((r) => r.id === state.file) : undefined;
  const sheetFile: ImageAsset | undefined = detailQuery.data ?? rowFile;

  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<ImageAsset | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Delete… opens over the detail sheet, and both Modals hear Esc on document:
  // take it first so Esc cancels only the confirmation, not the sheet under it.
  useEscapeLayer(Boolean(deleting) || bulkOpen, () => {
    if (remove.isPending || bulkPending) return;
    setDeleting(null);
    setBulkOpen(false);
  });

  const openFile = (asset: ImageAsset) => go({ ...state, file: asset.id });
  const closeFile = () => go({ ...state, file: undefined });

  const askDelete = (asset: ImageAsset) => {
    if (deleteBlockedReason(asset)) return;
    setDeleteError(null);
    setDeleting(asset);
  };

  async function confirmDelete() {
    if (!deleting) return;
    const name = fileDisplayName(deleting);
    try {
      await remove.mutateAsync(deleting.id);
      if (state.file === deleting.id) closeFile();
      setDeleting(null);
      pushToast({ kind: 'success', message: `Deleted ${name}.` });
    } catch (err) {
      // e.g. an item started using it since the list loaded: say so in the dialog.
      setDeleteError(imageActionError(err, 'Delete failed.'));
      void invalidate();
    }
  }

  async function confirmBulkDelete() {
    setBulkPending(true);
    setBulkError(null);
    let removed = 0;
    let skipped = 0;
    let freed = 0;
    try {
      // Re-read at confirm time: the header count may be stale, and only what is unused NOW may go.
      const unused = await fetchUnusedFiles();
      for (const asset of unused.images) {
        try {
          await remove.mutateAsync(asset.id);
          removed += 1;
          freed += asset.byte_size;
        } catch {
          // Used since the list was read (409) or already gone: leave it.
          skipped += 1;
        }
      }
      setBulkOpen(false);
      pushToast({
        kind: skipped > 0 ? 'error' : 'success',
        message:
          `Deleted ${removed.toLocaleString('en-US')} unused ${removed === 1 ? 'file' : 'files'} (${humanSize(freed)}).` +
          (skipped > 0 ? ` ${skipped.toLocaleString('en-US')} could not be deleted.` : ''),
      });
      if (state.usage === 'unused' || state.page > 1) go({ ...state, page: 1 }, true);
    } catch (err) {
      setBulkError(imageActionError(err, 'Could not read the unused files.'));
    } finally {
      setBulkPending(false);
      void invalidate();
    }
  }

  const menuItems = (asset: ImageAsset): OverflowMenuItem[] => {
    const blocked = deleteBlockedReason(asset);
    return [
      { id: 'copy-url', label: 'Copy URL', onSelect: () => void copyToClipboard(asset.url, 'URL') },
      { id: 'copy-md', label: 'Copy Markdown', onSelect: () => void copyToClipboard(markdownReference(asset), 'Markdown') },
      { id: 'download', label: 'Download', onSelect: () => download(asset) },
      {
        id: 'delete',
        label: 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => askDelete(asset),
        disabledReason: blocked ?? undefined,
      },
    ];
  };

  // ------------------------------------------------------------ page-level drop

  /** dragenter/dragleave fire for every child crossed; count them so the overlay does not flicker. */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!carriesFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (carriesFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!carriesFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length) {
        uploads.add(Array.from(e.dataTransfer.files));
        setUploadOpen(true);
      }
    },
  };

  // ------------------------------------------------------------ toolbar

  const filtered = hasFileFilters(state);
  const setView = (next: FilesView) => go({ ...state, view: next }, true);

  const toolbar = (
    <div className="Files__toolbar" role="search" aria-label="Filter files">
      <label className="Files__filter Files__filter--search">
        <span>Search</span>
        <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="File name…" />
      </label>
      <label className="Files__filter">
        <span>Type</span>
        <select value={state.type ?? ''} onChange={(e) => go(withFilters(state, { type: (e.target.value || undefined) as FileKind | undefined }), true)}>
          <option value="">All types</option>
          {FILE_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="Files__filter">
        <span>Usage</span>
        <select value={state.usage ?? ''} onChange={(e) => go(withFilters(state, { usage: (e.target.value || undefined) as FileUsageFilter | undefined }), true)}>
          <option value="">All</option>
          {FILE_USAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="Files__filter">
        <span>Sort</span>
        <select value={state.sort} onChange={(e) => go(withFilters(state, { sort: e.target.value as FileSort }), true)}>
          {FILE_SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="Files__viewToggle" role="group" aria-label="View">
        <button type="button" className="Files__viewButton" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
          <Icon icon={appIcons.image} /> Grid
        </button>
        <button type="button" className="Files__viewButton" aria-pressed={view === 'list'} onClick={() => setView('list')}>
          <Icon icon={appIcons.list} /> List
        </button>
      </div>
      {filtered ? (
        <button
          type="button"
          className="kp-admin-button"
          onClick={() => {
            pushedQ.current = '';
            setQInput('');
            go(withFilters(state, { q: '', type: undefined, usage: undefined }));
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );

  const uploadButton = (
    <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setUploadOpen(true)}>
      <Icon icon={appIcons.plus} /> Upload
    </button>
  );

  const empty = filtered ? (
    <EmptyState
      title="No files match"
      body="Try a different search, or clear the filters."
      action={
        <button type="button" className="kp-admin-button" onClick={() => go(withFilters(state, { q: '', type: undefined, usage: undefined }))}>
          Clear filters
        </button>
      }
    />
  ) : (
    <EmptyState title="No files yet" body="Upload images, PDFs and data files to reference them from any item." action={uploadButton} />
  );

  // ------------------------------------------------------------ list view

  const columns: DataTableColumn<ImageAsset>[] = [
    {
      id: 'name',
      header: 'Name',
      primary: true,
      cell: (a) => (
        <span className="Files__nameCell">
          <span className="Files__rowThumb" aria-hidden="true">
            {isRaster(a.mime) ? <img src={a.url} alt="" loading="lazy" /> : <span className="Files__rowThumbExt">{typeLabel(a.mime)}</span>}
          </span>
          <span className="Files__name" title={a.file}>
            {fileDisplayName(a)}
          </span>
        </span>
      ),
    },
    { id: 'type', header: 'Type', cell: (a) => typeLabel(a.mime) },
    { id: 'size', header: 'Size', align: 'end', cell: (a) => humanSize(a.byte_size) },
    { id: 'usage', header: 'Usage', cell: (a) => <UsageBadge asset={a} /> },
    {
      id: 'uploaded',
      header: 'Uploaded',
      hideBelow: 'md',
      cell: (a) => (
        <time dateTime={a.created_at} title={absoluteTime(a.created_at)}>
          {shortDate(a.created_at)}
        </time>
      ),
    },
  ];

  const busy = listQuery.isLoading || listQuery.isPlaceholderData;
  const offset = (state.page - 1) * FILES_PAGE_SIZE;
  const pages = pageCount(total);

  return (
    <main className="ImagesAdmin" aria-labelledby="images-admin-title" {...dropHandlers}>
      <AdminPageHeader
        titleId="images-admin-title"
        title="Files"
        description="Uploaded images and attachments, where each one is used, and what can be deleted."
        meta={libraryMeta(summary)}
        primaryAction={uploadButton}
        secondaryActions={
          summary && summary.unused > 0 ? (
            <button type="button" className="kp-admin-button" onClick={() => { setBulkError(null); setBulkOpen(true); }}>
              Delete unused…
            </button>
          ) : null
        }
      />

      <section className="Files__library" aria-label="Files">
        {view === 'list' ? (
          <DataTable
            rows={rows}
            rowKey={(a) => a.id}
            columns={columns}
            caption="Files"
            state={listQuery.isError ? 'error' : busy ? 'loading' : 'ready'}
            errorMessage="Couldn't load files."
            onRetry={() => void listQuery.refetch()}
            empty={empty}
            onRowOpen={openFile}
            rowActions={menuItems}
            rowLabel={fileDisplayName}
            toolbar={toolbar}
            selectedKey={state.file ?? null}
          />
        ) : (
          <>
            {toolbar}
            {listQuery.isError ? (
              <div className="Files__state" role="alert">
                <p>Couldn&apos;t load files.</p>
                <button type="button" className="kp-admin-button" onClick={() => void listQuery.refetch()}>
                  Retry
                </button>
              </div>
            ) : listQuery.isLoading ? (
              <p className="Files__state" role="status">
                Loading files…
              </p>
            ) : rows.length === 0 ? (
              empty
            ) : (
              <ul className="Files__grid" aria-busy={busy || undefined} data-testid="files-grid">
                {rows.map((a) => (
                  <FileCard key={a.id} asset={a} selected={state.file === a.id} onOpen={() => openFile(a)} menuItems={menuItems(a)} />
                ))}
              </ul>
            )}
          </>
        )}
        {total > 0 ? (
          <nav className="kp-dt__pager Files__pager" aria-label="Files pages">
            <span className="kp-dt__range" aria-live="polite">
              {pageRangeText(offset, rows.length, total)}
            </span>
            <button type="button" className="kp-dt__button" disabled={state.page <= 1} onClick={() => go({ ...state, page: state.page - 1 })}>
              Previous
            </button>
            <button type="button" className="kp-dt__button" disabled={state.page >= pages} onClick={() => go({ ...state, page: state.page + 1 })}>
              Next
            </button>
          </nav>
        ) : null}
      </section>

      {dragging && !uploadOpen ? (
        <div className="Files__dropOverlay" aria-hidden="true">
          <p>Drop to upload</p>
        </div>
      ) : null}

      {uploadOpen ? (
        <UploadDialog
          entries={uploads.entries}
          busy={uploads.busy}
          onFiles={uploads.add}
          onClearFinished={uploads.clearFinished}
          onClose={() => setUploadOpen(false)}
        />
      ) : null}

      {state.file ? (
        sheetFile ? (
          <FileDetailSheet
            file={sheetFile}
            detail={detailQuery.data}
            detailLoading={detailQuery.isLoading}
            detailError={detailQuery.isError}
            onRetry={() => void detailQuery.refetch()}
            onClose={closeFile}
            onCopyUrl={() => void copyToClipboard(sheetFile.url, 'URL')}
            onCopyMarkdown={() => void copyToClipboard(markdownReference(sheetFile), 'Markdown')}
            onDownload={() => download(sheetFile)}
            onDelete={() => askDelete(sheetFile)}
          />
        ) : detailQuery.isError ? (
          <Sheet title="File not found" onClose={closeFile}>
            <EmptyState title="No such file" body="It may have been deleted, or the link is out of date. Close this panel to see the library." />
          </Sheet>
        ) : null
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${fileDisplayName(deleting)}?`}
          body="No item and nothing on the site uses this file."
          consequences={[`Removes ${humanSize(deleting.byte_size)} from the library and its git repository.`, 'This cannot be undone; upload the file again to restore it.']}
          confirmLabel="Delete file"
          tone="danger"
          pending={remove.isPending}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}

      {bulkOpen && summary ? (
        <ConfirmDialog
          title="Delete unused files?"
          body={`${summary.unused.toLocaleString('en-US')} ${summary.unused === 1 ? 'file is' : 'files are'} used by no item and not by the site.`}
          consequences={[`Frees about ${humanSize(summary.reclaimable_bytes)}.`, 'A file that becomes used before its turn is kept.', 'This cannot be undone.']}
          confirmLabel="Delete unused files"
          tone="danger"
          pending={bulkPending}
          error={bulkError}
          onConfirm={() => void confirmBulkDelete()}
          onCancel={() => setBulkOpen(false)}
        />
      ) : null}
    </main>
  );
}

function FileCard({ asset, selected, onOpen, menuItems }: { asset: ImageAsset; selected: boolean; onOpen: () => void; menuItems: OverflowMenuItem[] }): JSX.Element {
  const name = fileDisplayName(asset);
  return (
    <li className="Files__card" aria-current={selected || undefined} data-testid="file-card">
      {/* The thumbnail is a mouse shortcut to the same action as Details; keyboard and AT use the button. */}
      <div className="Files__thumb" onClick={onOpen} aria-hidden="true">
        {isRaster(asset.mime) ? (
          <img src={asset.url} alt="" loading="lazy" />
        ) : (
          <span className="Files__glyph">
            <Icon icon={appIcons.fileLines} fixedWidth={false} />
            <span className="Files__glyphExt">{typeLabel(asset.mime)}</span>
          </span>
        )}
      </div>
      <div className="Files__cardMeta">
        <span className="Files__name" title={asset.file}>
          {name}
        </span>
        <span className="Files__muted">
          {typeLabel(asset.mime)} · {humanSize(asset.byte_size)}
        </span>
        <UsageBadge asset={asset} />
      </div>
      <div className="Files__cardActions">
        <button type="button" className="kp-admin-button Files__smallButton" onClick={onOpen} aria-label={`Open details for ${name}`}>
          Details
        </button>
        <OverflowMenu label={`Actions for ${name}`} items={menuItems} />
      </div>
    </li>
  );
}
