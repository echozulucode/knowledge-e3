/**
 * Page-view telemetry for an article, counted wherever it is read — the item
 * page and the reading pane alike (`POST /events/page-view`).
 *
 * The guard is a ref, not the effect's dependency list alone: React's
 * StrictMode runs every effect twice on mount in development, and the old
 * `useEffect(() => post(), [page?.id])` in PageView therefore recorded two views
 * per visit there. The ref survives that double run (it is the same component
 * instance), so one article shown once is one view; opening a different article
 * in the same reader is a new view, as it should be.
 */
import { useEffect, useRef } from 'react';
import { apiClient } from '../../api.js';

/** The page id to record now, or `null` when this one was already counted. */
export function pageViewToSend(lastSentId: string | null, pageId: string | null | undefined): string | null {
  if (!pageId || pageId === lastSentId) return null;
  return pageId;
}

/** Records one page view per article per mount. Best-effort: failures are swallowed. */
export function usePageViewTelemetry(pageId: string | null | undefined): void {
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    const id = pageViewToSend(lastSent.current, pageId);
    if (!id) return;
    lastSent.current = id;
    apiClient.post('/events/page-view', { page_id: id }).catch(() => {});
  }, [pageId]);
}
