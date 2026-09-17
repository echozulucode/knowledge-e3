/**
 * Content-health hooks (plan §6.3): the admin fix-it report over
 * `GET /admin/health/content?topic=`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ItemSummary } from '@echozedlabs/knowledge-types';
import { apiClient, type ApiError } from '../../api.js';
import type { AuditPage } from '../audit/queries.js';
import type { MirrorHealth } from './mirrorHealth.js';
import { RECENT_REFUSALS_LIMIT, REFUSED_ACTION } from './refusals.js';
import type { SystemHealthReport } from './systemVerdict.js';

export const QUEUE_NAMES = [
  'untyped',
  'uncategorized',
  'stale',
  'superseded_without_successor',
  'machine_unverified',
  'drafts_older_than_30d',
  'lint_failed_inbound',
  'declined_removal_still_deleted',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_LABELS: Record<QueueName, string> = {
  untyped: 'Untyped',
  uncategorized: 'Uncategorized',
  stale: 'Stale',
  superseded_without_successor: 'Superseded without successor',
  machine_unverified: 'Machine-generated, unverified',
  drafts_older_than_30d: 'Draft older than 30 days',
  // Both doors write the queue's table — git sync and the OKF import — so the
  // label names both. The KEY stays `lint_failed_inbound`; only the words moved.
  lint_failed_inbound: 'Arrived with lint errors (sync or import)',
  // The only queue whose members are DELETED rows: a removal was proposed
  // upstream, the reviewer declined, and the automatic restore could not
  // complete. Each row links to the change request that settled.
  declined_removal_still_deleted: 'Removal declined upstream, still deleted here',
};

/**
 * Where a `lint_failed_inbound` member came from and what the lint said (plan
 * B4). Optional on the item: only that queue carries it, and a server that
 * predates B4 omits it.
 */
export interface InboundLint {
  /** A registry source id, or the OKF import door's own id for a bundle an admin imported. */
  source_id: string;
  /** The file, relative to its repository. */
  path: string;
  detected_at: string;
  /** Capped by the server, error-severity first. `path` here is the frontmatter KEY. */
  diagnostics: { code: string; severity: 'error' | 'warning' | 'info'; message: string; path?: string }[];
  /** The row's full count; more than `diagnostics.length` means some were left off. */
  diagnostics_total: number;
}

export type HealthQueueItem = ItemSummary & { lint?: InboundLint };

export interface HealthQueue {
  count: number;
  /** The first members; `count` is the full size. */
  items: HealthQueueItem[];
}

export interface ContentHealthReport {
  totals: { items: number; published: number; drafts: number };
  audit: { conformant: boolean; conformance: number; policy: number; advisories: number };
  signals: {
    total: number;
    byTrustTier: Record<string, number>;
    byFreshness: Record<string, number>;
    withSources: number;
    withGenerated: number;
  };
  queues: Record<QueueName, HealthQueue>;
  /** Sync engine trouble (plan §8.1): open merge conflicts and the sources they block. */
  sync?: { conflicts: number; sources_in_conflict: string[] };
  /**
   * Git-mirror durability (issue 88): content indexed but not yet committed.
   * Optional — a server that predates the section simply omits it.
   */
  mirror?: MirrorHealth;
}

export function useContentHealth(topic?: string) {
  return useQuery({
    queryKey: ['content-health', topic ?? ''],
    queryFn: () => apiClient.get<ContentHealthReport>(`/admin/health/content${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`),
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 403 && count < 2,
    staleTime: 30_000,
  });
}

/** Rows per page of the selected queue's table (the server's default `limit`). */
export const QUEUE_PAGE_SIZE = 50;

/**
 * One page of one queue (`GET /admin/health/content/queues/:queue`, review §4.9).
 * `total` is the queue's full size; the report's own `queues` still carry the
 * first 50 of each, which is what the counts and the attention strip read.
 */
export interface HealthQueuePage {
  queue: QueueName;
  count: number;
  total: number;
  offset: number;
  limit: number;
  items: HealthQueueItem[];
}

/**
 * A page of the selected queue. Its own key under `content-health`, so the
 * page's Refresh (which invalidates that prefix) refetches it with the report;
 * the previous page stays on screen while the next loads.
 */
export function useContentHealthQueue(queue: QueueName | null, topic: string | undefined, offset: number) {
  return useQuery({
    queryKey: ['content-health', topic ?? '', 'queue', queue, offset],
    queryFn: () => {
      const params = new URLSearchParams({ offset: String(offset), limit: String(QUEUE_PAGE_SIZE) });
      if (topic) params.set('topic', topic);
      return apiClient.get<HealthQueuePage>(`/admin/health/content/queues/${queue}?${params.toString()}`);
    },
    enabled: queue !== null,
    placeholderData: keepPreviousData,
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 403 && count < 2,
    staleTime: 30_000,
  });
}

/**
 * System health (plan §5, issue 71): the instance-level report over
 * `GET /admin/health/system`.
 *
 * A separate hook with its own key on purpose — the two reports have different
 * costs and different refresh rates, and §5 is explicit that they must not
 * share a code path. This one is cheap (process- and database-level probes),
 * so it refreshes more eagerly than Content health's 30 s: an operator who has
 * just restarted something wants the page to agree.
 */
export function useSystemHealth() {
  return useQuery({
    queryKey: ['system-health'],
    queryFn: () => apiClient.get<SystemHealthReport>('/admin/health/system'),
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 403 && count < 2,
    staleTime: 10_000,
  });
}

/**
 * Recent refusals (plan B2): the newest `content.refused` rows, read through
 * `GET /admin/audit` — the existing admin-only audit read, not a second
 * endpoint with its own authorization to get right. Instance-wide, like Sync
 * and the Git mirror: the page's topic filter does not narrow it, because the
 * log records a refused create's topic as the author typed it, not as a slug.
 */
export function useRecentRefusals() {
  return useQuery({
    queryKey: ['admin', 'audit', 'recent-refusals'],
    queryFn: () =>
      apiClient.get<AuditPage>(
        `/admin/audit?action=${encodeURIComponent(REFUSED_ACTION)}&limit=${RECENT_REFUSALS_LIMIT}`,
      ),
    retry: (count, error) => (error as unknown as ApiError).statusCode !== 403 && count < 2,
    staleTime: 30_000,
  });
}
