import { describe, expect, it } from 'vitest';
import {
  deleteBlockedReason,
  effectiveView,
  fileKind,
  filesListParams,
  filesSearchToParams,
  hasFileFilters,
  humanSize,
  libraryMeta,
  markdownReference,
  nextQueued,
  pageRangeText,
  readFilesSearch,
  uploadErrorMessage,
  uploadQueueReducer,
  uploadSummaryToast,
  uploadTally,
  usageLabel,
  withFilters,
  type UploadEntry,
} from './filesModel.js';

describe('type buckets', () => {
  it('buckets by MIME the way the server filters', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('image/svg+xml')).toBe('image');
    expect(fileKind('IMAGE/AVIF')).toBe('image');
    expect(fileKind('application/pdf')).toBe('document');
    expect(fileKind('text/csv')).toBe('document');
    expect(fileKind('application/json')).toBe('document');
    expect(fileKind('text/plain')).toBe('document');
    expect(fileKind('application/zip')).toBe('other');
    expect(fileKind('application/octet-stream')).toBe('other');
  });
});

describe('sizes and totals', () => {
  it('formats bytes with one decimal below 10 of a unit', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(812)).toBe('812 B');
    expect(humanSize(4300)).toBe('4.2 KB');
    expect(humanSize(180 * 1024 * 1024)).toBe('180 MB');
    expect(humanSize(1.4 * 1024 * 1024 * 1024)).toBe('1.4 GB');
  });

  it('writes the header meta with unused and reclaimable', () => {
    expect(libraryMeta(undefined)).toBeUndefined();
    expect(libraryMeta({ count: 0, total_bytes: 0, unused: 0, reclaimable_bytes: 0 })).toBe('0 files');
    expect(libraryMeta({ count: 1, total_bytes: 2048, unused: 0, reclaimable_bytes: 0 })).toBe('1 file · 2 KB · none unused');
    expect(
      libraryMeta({ count: 312, total_bytes: 1.4 * 1024 ** 3, unused: 23, reclaimable_bytes: 180 * 1024 ** 2 }),
    ).toBe('312 files · 1.4 GB · 23 unused, 180 MB reclaimable');
  });

  it('writes the page range', () => {
    expect(pageRangeText(0, 50, 312)).toBe('1–50 of 312');
    expect(pageRangeText(300, 12, 1312)).toBe('301–312 of 1,312');
    expect(pageRangeText(0, 0, 0)).toBe('0 of 0');
  });
});

describe('default view', () => {
  it('is grid up to 50 files and list above, unless the admin chose', () => {
    expect(effectiveView(undefined, undefined)).toBe('grid');
    expect(effectiveView(undefined, 50)).toBe('grid');
    expect(effectiveView(undefined, 51)).toBe('list');
    expect(effectiveView('grid', 5000)).toBe('grid');
    expect(effectiveView('list', 3)).toBe('list');
  });
});

describe('URL state', () => {
  it('reads defaults from an empty or malformed search', () => {
    expect(readFilesSearch(undefined)).toEqual({ q: '', sort: 'newest', page: 1 });
    expect(readFilesSearch({ type: 'video', usage: 'maybe', sort: 'oldest', page: '-2', view: 'tiles' })).toEqual({ q: '', sort: 'newest', page: 1 });
  });

  it('round-trips every field, dropping defaults', () => {
    const state = readFilesSearch({ q: 'diagram', type: 'image', usage: 'unused', sort: 'largest', page: 3, view: 'list', file: 'abc' });
    expect(state).toEqual({ q: 'diagram', type: 'image', usage: 'unused', sort: 'largest', page: 3, view: 'list', file: 'abc' });
    expect(filesSearchToParams(state)).toEqual({ q: 'diagram', type: 'image', usage: 'unused', sort: 'largest', page: 3, view: 'list', file: 'abc' });
    expect(filesSearchToParams(readFilesSearch({}))).toEqual({});
    // A number search value (the router parses `?q=2024`) is still text.
    expect(readFilesSearch({ q: 2024 }).q).toBe('2024');
  });

  it('keeps an explicit view and the open file across a filter change, but restarts paging', () => {
    const state = readFilesSearch({ page: 4, view: 'grid', file: 'x' });
    expect(withFilters(state, { usage: 'used' })).toMatchObject({ page: 1, view: 'grid', file: 'x', usage: 'used' });
    expect(hasFileFilters(state)).toBe(false);
    expect(hasFileFilters(withFilters(state, { q: ' a ' }))).toBe(true);
  });

  it('turns a state into list request parameters', () => {
    expect(filesListParams(readFilesSearch({ q: ' pdf ', type: 'document', page: 2 }))).toEqual({ q: 'pdf', type: 'document', sort: 'newest', limit: 50, offset: 50 });
  });
});

describe('usage and delete', () => {
  it('labels usage, with the site as a user', () => {
    expect(usageLabel({ used_by: 0, orphan: true, site_asset: false })).toBe('Unused');
    expect(usageLabel({ used_by: 1, orphan: false, site_asset: false })).toBe('Used by 1 item');
    expect(usageLabel({ used_by: 3, orphan: false, site_asset: true })).toBe('Used by 3 items');
    expect(usageLabel({ used_by: 0, orphan: false, site_asset: true })).toBe('Used by the site');
  });

  it('explains why Delete is unavailable, or allows it', () => {
    expect(deleteBlockedReason({ used_by: 0, orphan: true, site_asset: false })).toBeNull();
    expect(deleteBlockedReason({ used_by: 2, orphan: false, site_asset: false })).toBe('In use by 2 items');
    expect(deleteBlockedReason({ used_by: 0, orphan: false, site_asset: true })).toMatch(/^In use by the site/);
  });

  it('copies an image as an embed and anything else as a link', () => {
    const base = { url: '/assets/abc.png', alt: 'Chart', file: 'abc.png', original_filename: 'chart.png' };
    expect(markdownReference({ ...base, mime: 'image/png' })).toBe('![Chart](/assets/abc.png)');
    expect(markdownReference({ ...base, mime: 'application/pdf', url: '/assets/r.pdf', original_filename: 'Report.pdf' })).toBe('[Report.pdf](/assets/r.pdf)');
  });
});

describe('upload queue', () => {
  const add = (state: UploadEntry[], ...names: string[]) =>
    uploadQueueReducer(state, { type: 'add', files: names.map((name) => ({ key: name, name, size: 10 })) });

  it('sends one file at a time, in order', () => {
    let q = add([], 'a.png', 'b.pdf');
    expect(nextQueued(q)?.key).toBe('a.png');
    q = uploadQueueReducer(q, { type: 'start', key: 'a.png' });
    expect(nextQueued(q)).toBeUndefined();
    q = uploadQueueReducer(q, { type: 'done', key: 'a.png', assetId: 'id-a' });
    expect(nextQueued(q)?.key).toBe('b.pdf');
  });

  it('holds progress below 100% until the server answers', () => {
    let q = uploadQueueReducer(add([], 'a.png'), { type: 'start', key: 'a.png' });
    q = uploadQueueReducer(q, { type: 'progress', key: 'a.png', loaded: 5, total: 10 });
    expect(q[0]!.progress).toBe(0.5);
    q = uploadQueueReducer(q, { type: 'progress', key: 'a.png', loaded: 10, total: 10 });
    expect(q[0]!.progress).toBeLessThan(1);
    q = uploadQueueReducer(q, { type: 'done', key: 'a.png', assetId: 'x' });
    expect(q[0]).toMatchObject({ status: 'done', progress: 1, assetId: 'x' });
  });

  it('keeps a failure next to its file and clears only finished rows', () => {
    let q = add([], 'bad.exe', 'ok.png', 'later.csv');
    q = uploadQueueReducer(q, { type: 'start', key: 'bad.exe' });
    q = uploadQueueReducer(q, { type: 'failed', key: 'bad.exe', error: 'Unsupported or unrecognized file type.' });
    q = uploadQueueReducer(q, { type: 'start', key: 'ok.png' });
    q = uploadQueueReducer(q, { type: 'done', key: 'ok.png', assetId: 'y' });
    expect(q.find((e) => e.key === 'bad.exe')).toMatchObject({ status: 'error', error: 'Unsupported or unrecognized file type.' });
    expect(uploadTally(q)).toEqual({ done: 1, failed: 1, pending: 1 });
    expect(uploadQueueReducer(q, { type: 'clearFinished' }).map((e) => e.key)).toEqual(['later.csv']);
  });

  it('summarises a settled batch in one toast', () => {
    expect(uploadSummaryToast({ done: 2, failed: 0, pending: 1 })).toBeNull();
    expect(uploadSummaryToast({ done: 0, failed: 0, pending: 0 })).toBeNull();
    expect(uploadSummaryToast({ done: 3, failed: 0, pending: 0 })).toEqual({ kind: 'success', message: 'Uploaded 3 files.' });
    expect(uploadSummaryToast({ done: 2, failed: 1, pending: 0 })).toEqual({ kind: 'error', message: 'Uploaded 2 files; 1 could not be uploaded.' });
    expect(uploadSummaryToast({ done: 0, failed: 1, pending: 0 })).toEqual({ kind: 'error', message: '1 file could not be uploaded.' });
  });

  it("shows the server's reason for a refused file", () => {
    expect(uploadErrorMessage(400, JSON.stringify({ statusCode: 400, message: 'unsupported or unrecognized file type' }))).toBe('Unsupported or unrecognized file type.');
    expect(uploadErrorMessage(400, JSON.stringify({ message: 'file exceeds the 2 MB limit for image/svg+xml' }))).toBe('File exceeds the 2 MB limit for image/svg+xml.');
    expect(uploadErrorMessage(413, '<html>Payload Too Large</html>')).toBe('File is larger than the 25 MB upload limit.');
    expect(uploadErrorMessage(0, '')).toBe('Upload failed: the connection was lost.');
    expect(uploadErrorMessage(500, 'oops')).toBe('Upload failed (500).');
  });
});
