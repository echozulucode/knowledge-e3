/**
 * The Files page's upload queue: files dropped or chosen are sent one at a time
 * with per-file progress, each failure kept next to its file, and one toast
 * when the batch settles.
 *
 * One at a time on purpose: the server hashes and writes each body in full
 * before answering, and parallel 25 MB bodies would only contend for that; a
 * sequential queue also makes the progress bars read in order.
 *
 * The queue lives on the page, not in the Upload dialog, so closing the dialog
 * does not cancel what is on the wire and a page-level drop can feed it.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { pushToast } from '../../hooks/useToast.js';
import { nextQueued, uploadQueueReducer, uploadSummaryToast, uploadTally, type UploadEntry } from './filesModel.js';
import { UploadError, uploadFileWithProgress, useInvalidateFiles } from './queries.js';

export interface UploadQueue {
  entries: UploadEntry[];
  add: (files: Iterable<File>) => void;
  clearFinished: () => void;
  busy: boolean;
}

let keySeq = 0;

export function useUploadQueue(): UploadQueue {
  const [entries, dispatch] = useReducer(uploadQueueReducer, []);
  const files = useRef(new Map<string, File>());
  const invalidate = useInvalidateFiles();
  /**
   * Outcomes since the last toast. Counted here rather than from `entries`,
   * which still holds earlier batches' rows (and loses rows to Clear finished).
   */
  const batch = useRef({ done: 0, failed: 0 });

  const add = useCallback((incoming: Iterable<File>) => {
    const list = Array.from(incoming).map((file) => {
      keySeq += 1;
      const key = `upload-${keySeq}`;
      files.current.set(key, file);
      return { key, name: file.name || 'untitled', size: file.size };
    });
    if (list.length === 0) return;
    dispatch({ type: 'add', files: list });
  }, []);

  const next = nextQueued(entries);
  useEffect(() => {
    if (!next) return;
    const file = files.current.get(next.key);
    if (!file) {
      batch.current.failed += 1;
      dispatch({ type: 'failed', key: next.key, error: 'The file is no longer available. Choose it again.' });
      return;
    }
    dispatch({ type: 'start', key: next.key });
    uploadFileWithProgress(file, (loaded, total) => dispatch({ type: 'progress', key: next.key, loaded, total }))
      .then((asset) => {
        batch.current.done += 1;
        dispatch({ type: 'done', key: next.key, assetId: asset.id });
        // Refresh as each file lands, so the library fills in while the rest upload.
        void invalidate();
      })
      .catch((err: unknown) => {
        batch.current.failed += 1;
        dispatch({ type: 'failed', key: next.key, error: err instanceof UploadError ? err.message : 'Upload failed.' });
      })
      .finally(() => files.current.delete(next.key));
    // Keyed on the entry to send; `invalidate` is stable enough and must not restart an upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.key]);

  const tally = uploadTally(entries);
  useEffect(() => {
    const toast = uploadSummaryToast({ ...batch.current, pending: tally.pending });
    if (!toast) return;
    batch.current = { done: 0, failed: 0 };
    pushToast(toast);
  }, [tally.done, tally.failed, tally.pending]);

  const clearFinished = useCallback(() => dispatch({ type: 'clearFinished' }), []);

  return { entries, add, clearFinished, busy: tally.pending > 0 };
}
