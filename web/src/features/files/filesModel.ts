/**
 * Pure helpers for Admin → Files (the admin UX review §4.9): the
 * list's URL state, the grid/list default, type buckets, sizes and totals, the
 * delete rule, and the upload queue. Kept out of the components so they can be
 * unit-tested without a router, a DOM or an XMLHttpRequest.
 */
import type { ImageAsset } from '../../queries.js';

// ---------------------------------------------------------------- URL state

export const FILES_PAGE_SIZE = 50;
/** Above this many files the list view is the default: thumbnails stop being scannable. */
export const LIST_VIEW_THRESHOLD = 50;

export type FileKind = 'image' | 'document' | 'other';
export type FileUsageFilter = 'used' | 'unused';
export type FileSort = 'newest' | 'largest' | 'name';
export type FilesView = 'grid' | 'list';

export const FILE_KIND_OPTIONS: { value: FileKind; label: string }[] = [
  { value: 'image', label: 'Images' },
  { value: 'document', label: 'Documents' },
  { value: 'other', label: 'Other' },
];
export const FILE_USAGE_OPTIONS: { value: FileUsageFilter; label: string }[] = [
  { value: 'used', label: 'Used' },
  { value: 'unused', label: 'Unused' },
];
export const FILE_SORT_OPTIONS: { value: FileSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'largest', label: 'Largest' },
  { value: 'name', label: 'Name' },
];

/**
 * Everything the Files page keeps in the query string, so a filtered library,
 * a page of it, or one open file is a link. Defaults are absent from the URL.
 * `view` is present only when the admin chose one: without it the page picks
 * by library size (`effectiveView`), and a choice made once must survive the
 * library crossing the threshold.
 */
export interface FilesSearch {
  q: string;
  type?: FileKind;
  usage?: FileUsageFilter;
  sort: FileSort;
  /** 1-based. */
  page: number;
  view?: FilesView;
  /** Open detail sheet (image id). */
  file?: string;
}

const KINDS: readonly string[] = ['image', 'document', 'other'];
const USAGES: readonly string[] = ['used', 'unused'];
const SORTS: readonly string[] = ['newest', 'largest', 'name'];

function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read the page's state from the router's (untyped) search object; anything malformed falls back to the default. */
export function readFilesSearch(search: Record<string, unknown> | undefined): FilesSearch {
  const s = search ?? {};
  const type = str(s['type']);
  const usage = str(s['usage']);
  const sort = str(s['sort']);
  const view = str(s['view']);
  const pageRaw = Number(str(s['page']) ?? '1');
  const file = str(s['file']);
  return {
    q: typeof s['q'] === 'string' ? s['q'] : typeof s['q'] === 'number' ? String(s['q']) : '',
    ...(type && KINDS.includes(type) ? { type: type as FileKind } : {}),
    ...(usage && USAGES.includes(usage) ? { usage: usage as FileUsageFilter } : {}),
    sort: sort && SORTS.includes(sort) ? (sort as FileSort) : 'newest',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    ...(view === 'grid' || view === 'list' ? { view } : {}),
    ...(file ? { file } : {}),
  };
}

/**
 * The query-string object for a state, defaults dropped. `page` is a NUMBER:
 * TanStack Router JSON-quotes a string that parses as JSON (`?page=%222%22`).
 */
export function filesSearchToParams(state: FilesSearch): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (state.q.trim()) out['q'] = state.q.trim();
  if (state.type) out['type'] = state.type;
  if (state.usage) out['usage'] = state.usage;
  if (state.sort !== 'newest') out['sort'] = state.sort;
  if (state.page > 1) out['page'] = state.page;
  if (state.view) out['view'] = state.view;
  if (state.file) out['file'] = state.file;
  return out;
}

/** A filter, search or sort change starts again at page 1. */
export function withFilters(state: FilesSearch, patch: Partial<Pick<FilesSearch, 'q' | 'type' | 'usage' | 'sort'>>): FilesSearch {
  return { ...state, ...patch, page: 1 };
}

export function hasFileFilters(state: FilesSearch): boolean {
  return Boolean(state.q.trim() || state.type || state.usage);
}

export interface FilesListParams {
  q?: string;
  type?: FileKind;
  usage?: FileUsageFilter;
  sort: FileSort;
  limit: number;
  offset: number;
}

/** What the list request sends for a page state. */
export function filesListParams(state: FilesSearch, pageSize = FILES_PAGE_SIZE): FilesListParams {
  return {
    ...(state.q.trim() ? { q: state.q.trim() } : {}),
    ...(state.type ? { type: state.type } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    sort: state.sort,
    limit: pageSize,
    offset: (state.page - 1) * pageSize,
  };
}

/** The admin's explicit choice, else list above LIST_VIEW_THRESHOLD files (the whole library, not the filtered page). */
export function effectiveView(explicit: FilesView | undefined, libraryCount: number | undefined): FilesView {
  if (explicit) return explicit;
  return (libraryCount ?? 0) > LIST_VIEW_THRESHOLD ? 'list' : 'grid';
}

export function pageCount(total: number, pageSize = FILES_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// ---------------------------------------------------------------- types, sizes, totals

/**
 * Readable documents, mirroring the server's "Documents" bucket
 * (`attachmentMimesIn('document', 'data')` in attachment-policy.ts).
 */
const DOCUMENT_MIMES: readonly string[] = ['application/pdf', 'text/csv', 'application/json', 'text/plain'];

/** The type bucket for a stored MIME: the same rule the server filters by. */
export function fileKind(mime: string): FileKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (DOCUMENT_MIMES.includes(m)) return 'document';
  return 'other';
}

/** Raster images render as a thumbnail; SVG is served as a download (it can carry script), so it gets the icon. */
export function isRaster(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime);
}

/** Short type label from a MIME, for the badge. */
export function typeLabel(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WEBP',
    'image/svg+xml': 'SVG', 'application/pdf': 'PDF', 'application/zip': 'ZIP',
    'text/csv': 'CSV', 'application/json': 'JSON', 'text/plain': 'TXT',
  };
  return map[mime] ?? mime.split('/').pop()?.toUpperCase() ?? 'FILE';
}

/** `812 B`, `4.2 KB`, `180 MB`, `1.4 GB` — one decimal below 10, none above. */
export function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

export interface LibrarySummary {
  count: number;
  total_bytes: number;
  unused: number;
  reclaimable_bytes: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The header meta: "312 files · 1.4 GB · 23 unused, 180 MB reclaimable". */
export function libraryMeta(summary: LibrarySummary | undefined): string | undefined {
  if (!summary) return undefined;
  if (summary.count === 0) return plural(0, 'file', 'files');
  const head = `${plural(summary.count, 'file', 'files')} · ${humanSize(summary.total_bytes)}`;
  if (summary.unused === 0) return `${head} · none unused`;
  return `${head} · ${summary.unused.toLocaleString('en-US')} unused, ${humanSize(summary.reclaimable_bytes)} reclaimable`;
}

/** `1–50 of 312`; `0 of 0` when empty. */
export function pageRangeText(offset: number, count: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (total === 0 || count === 0) return `0 of ${fmt(total)}`;
  return `${fmt(offset + 1)}–${fmt(offset + count)} of ${fmt(total)}`;
}

// ---------------------------------------------------------------- usage and delete

type UsageFields = Pick<ImageAsset, 'used_by' | 'orphan'> & { site_asset?: boolean };

/** The name a person recognises: the uploaded filename, else the stored name. */
export function fileDisplayName(asset: Pick<ImageAsset, 'file' | 'original_filename'>): string {
  return asset.original_filename?.trim() || asset.file;
}

/** The usage chip's text. Unused is a neutral fact, not an error (§4.9). */
export function usageLabel(asset: UsageFields): string {
  if (asset.used_by > 0) return `Used by ${plural(asset.used_by, 'item', 'items')}`;
  if (asset.site_asset) return 'Used by the site';
  return 'Unused';
}

/**
 * Why Delete is unavailable, as visible text, or null when it may be deleted.
 * The server refuses the same two cases (409); this says so before the admin tries.
 */
export function deleteBlockedReason(asset: UsageFields): string | null {
  if (asset.used_by > 0) return `In use by ${plural(asset.used_by, 'item', 'items')}`;
  if (asset.site_asset) return 'In use by the site (logo, favicon or a pinned-topic cover)';
  return null;
}

/** What "Copy Markdown" puts on the clipboard: an embed for images, a link otherwise. */
export function markdownReference(asset: Pick<ImageAsset, 'url' | 'mime' | 'alt' | 'file' | 'original_filename'>): string {
  if (isRaster(asset.mime)) return `![${asset.alt ?? ''}](${asset.url})`;
  return `[${fileDisplayName(asset)}](${asset.url})`;
}

// ---------------------------------------------------------------- upload queue

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadEntry {
  /** Local key; two files may share a name. */
  key: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 0–1 of the request body sent. */
  progress: number;
  error?: string;
  /** The stored file, once done. */
  assetId?: string;
}

export type UploadAction =
  | { type: 'add'; files: { key: string; name: string; size: number }[] }
  | { type: 'start'; key: string }
  | { type: 'progress'; key: string; loaded: number; total: number }
  | { type: 'done'; key: string; assetId: string }
  | { type: 'failed'; key: string; error: string }
  | { type: 'clearFinished' };

export function uploadQueueReducer(state: UploadEntry[], action: UploadAction): UploadEntry[] {
  const patch = (key: string, next: Partial<UploadEntry>) => state.map((e) => (e.key === key ? { ...e, ...next } : e));
  switch (action.type) {
    case 'add':
      return [...state, ...action.files.map((f) => ({ ...f, status: 'queued' as const, progress: 0 }))];
    case 'start':
      return patch(action.key, { status: 'uploading', progress: 0, error: undefined });
    case 'progress':
      // Never report 100% before the server has answered: the bytes are sent
      // but the type/size check has not run, and that is where a file fails.
      return patch(action.key, { progress: action.total > 0 ? Math.min(0.99, action.loaded / action.total) : 0 });
    case 'done':
      return patch(action.key, { status: 'done', progress: 1, assetId: action.assetId });
    case 'failed':
      return patch(action.key, { status: 'error', error: action.error });
    case 'clearFinished':
      return state.filter((e) => e.status === 'queued' || e.status === 'uploading');
  }
}

/** The next file to send, or undefined when nothing is waiting or one is already on the wire. */
export function nextQueued(state: readonly UploadEntry[]): UploadEntry | undefined {
  if (state.some((e) => e.status === 'uploading')) return undefined;
  return state.find((e) => e.status === 'queued');
}

export interface UploadTally {
  done: number;
  failed: number;
  pending: number;
}

export function uploadTally(state: readonly UploadEntry[]): UploadTally {
  return {
    done: state.filter((e) => e.status === 'done').length,
    failed: state.filter((e) => e.status === 'error').length,
    pending: state.filter((e) => e.status === 'queued' || e.status === 'uploading').length,
  };
}

/** The toast after a batch settles, or null while files are still going. */
export function uploadSummaryToast(tally: UploadTally): { kind: 'success' | 'error'; message: string } | null {
  if (tally.pending > 0 || tally.done + tally.failed === 0) return null;
  if (tally.failed === 0) return { kind: 'success', message: `Uploaded ${plural(tally.done, 'file', 'files')}.` };
  if (tally.done === 0) return { kind: 'error', message: `${plural(tally.failed, 'file', 'files')} could not be uploaded.` };
  return { kind: 'error', message: `Uploaded ${plural(tally.done, 'file', 'files')}; ${tally.failed.toLocaleString('en-US')} could not be uploaded.` };
}

/** 25 MB: the server's raw-body ceiling (bootstrap.ts). Per-type caps are lower and come back as the server's message. */
export const UPLOAD_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * The message shown next to a failed file. The server's reason (allowlist,
 * signature mismatch, per-type size cap) is the useful text, so it wins; the
 * body-size ceiling is enforced before the controller and answers 413 with no
 * JSON, and a dropped connection has no status at all.
 */
export function uploadErrorMessage(status: number, responseText: string): string {
  let message = '';
  try {
    const body = JSON.parse(responseText) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message;
    else if (Array.isArray(body.message)) message = body.message.filter((m) => typeof m === 'string').join('; ');
  } catch {
    /* not JSON */
  }
  if (status === 413) return 'File is larger than the 25 MB upload limit.';
  if (message) return message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/.test(message) ? '' : '.');
  if (status === 0) return 'Upload failed: the connection was lost.';
  if (status === 401 || status === 403) return 'Your session cannot upload files. Sign in again.';
  return `Upload failed (${status}).`;
}
