/**
 * The library audit (OKF v0.2 three-tier check + trust/freshness roll-up) over
 * `GET /okf/audit?space=` — read on Data → Audit, its one home
 * (the admin UX review §6 decision 4).
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient, type ApiError } from '../../api.js';
import type { AuditIssue } from './dataAdminModel.js';

export interface LibraryAuditResponse {
  okf_version: string;
  item_count: number;
  conformant: boolean;
  conceptCount: number;
  conformance: AuditIssue[];
  policy: AuditIssue[];
  advisories: AuditIssue[];
  signals: {
    total: number;
    byTrustTier: { unverified: number; 'machine-confirmed': number; 'human-reviewed': number };
    byFreshness: { fresh: number; stale: number };
    withSources: number;
    withGenerated: number;
  };
}

/**
 * Loaded when the tab opens, not behind a "Run" button: it is read-only, and a
 * Content health tile links here expecting the findings to be on screen. It is
 * a whole-library export plus audit, so it is not refetched on focus — the
 * tab's Refresh is the way to re-run it.
 */
export function useLibraryAudit(topic: string, enabled = true) {
  return useQuery({
    queryKey: ['okf-audit', topic],
    queryFn: () => apiClient.get<LibraryAuditResponse>(`/okf/audit${topic ? `?space=${encodeURIComponent(topic)}` : ''}`),
    enabled,
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 403 && count < 2,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
