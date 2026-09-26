/**
 * TanStack Query hooks for the source registry, the conflict queue, and the
 * review queue (plan §7.4, §8.1, §8.2).
 *
 * These sit on the same `apiClient` helper the rest of the app uses and stay
 * feature-local (like `features/tokens/queries.ts`) so the shared
 * `web/src/queries.ts` keeps owning only the legacy `/admin/repos/*` calls.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type ApiError } from '../../api.js';
import { toReviewEntry } from './types.js';
import type {
  ConflictRow,
  ReviewEntry,
  ReviewRecord,
  SourceStatusView,
  SourceUpsertInput,
  SyncStatus,
} from './types.js';

const SOURCES_KEY = ['admin', 'sources'] as const;

const enc = encodeURIComponent;

/** Never retry an admin route that told us we are not an admin. */
function retryUnlessForbidden(count: number, error: unknown): boolean {
  return (error as ApiError | null)?.statusCode !== 403 && count < 2;
}

export interface UseSourcesOptions {
  /**
   * Live polling for the Sources page (review §4.4): a function of the current
   * list, so the interval can tighten while a cycle runs. Other readers of the
   * same key (the admin nav badge) pass nothing and simply share the result.
   * Background tabs never poll — `refetchIntervalInBackground` stays false.
   */
  refetchInterval?: (sources: SourceStatusView[] | undefined) => number | false;
}

/** Every registered source with its live sync status. */
export function useSources(options: UseSourcesOptions = {}) {
  const { refetchInterval } = options;
  return useQuery({
    queryKey: SOURCES_KEY,
    queryFn: async () => (await apiClient.get<{ sources: SourceStatusView[] }>('/admin/sources')).sources,
    retry: retryUnlessForbidden,
    staleTime: 10_000,
    ...(refetchInterval ? { refetchInterval: (query: { state: { data: SourceStatusView[] | undefined } }) => refetchInterval(query.state.data) } : {}),
  });
}

export function useUpsertSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SourceUpsertInput }) =>
      apiClient.put<{ source: SourceStatusView }>(`/admin/sources/${enc(id)}`, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SOURCES_KEY }),
  });
}

export function useRemoveSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<{ ok: boolean }>(`/admin/sources/${enc(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SOURCES_KEY }),
  });
}

/** One fetch → merge → index cycle, now. */
export function useSyncSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<{ status: SyncStatus }>(`/admin/sources/${enc(id)}/sync`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SOURCES_KEY }),
  });
}

/** Flag a push and run a cycle. */
export function usePushSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<{ status: SyncStatus }>(`/admin/sources/${enc(id)}/push`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SOURCES_KEY }),
  });
}

// ---------------------------------------------------------------- conflicts

/** Prefix shared by both conflict queries for a source (open-only and with-history). */
export function conflictsKeyPrefix(sourceId: string) {
  return ['admin', 'sources', sourceId, 'conflicts'] as const;
}

export function conflictsKey(sourceId: string, includeResolved = false) {
  return [...conflictsKeyPrefix(sourceId), includeResolved ? 'with-history' : 'open'] as const;
}

/** How many resolved conflicts the history asks for; the server caps this at 100. */
export const RESOLVED_HISTORY_LIMIT = 20;

/**
 * The conflict queue for one source. `includeResolved` asks the server for the
 * bounded resolved history too, so the panel's collapsed history is the
 * server's record rather than what this browser session happens to remember.
 */
export function useSourceConflicts(sourceId: string | null, opts: { includeResolved?: boolean } = {}) {
  const includeResolved = opts.includeResolved ?? false;
  return useQuery({
    queryKey: conflictsKey(sourceId ?? '', includeResolved),
    queryFn: async () => {
      const query = includeResolved ? `?includeResolved=true&resolvedLimit=${RESOLVED_HISTORY_LIMIT}` : '';
      return (await apiClient.get<{ conflicts: ConflictRow[] }>(`/admin/sources/${enc(sourceId!)}/conflicts${query}`))
        .conflicts;
    },
    enabled: !!sourceId,
    retry: retryUnlessForbidden,
  });
}

export interface ResolveConflictInput {
  sourceId: string;
  conflictId: string;
  choice: 'ours' | 'theirs';
  /** Merged content to use instead of either side (recorded as a `manual` resolution). */
  content?: string;
}

export function useResolveConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conflictId, choice, content }: ResolveConflictInput) =>
      apiClient.post<{ conflict: ConflictRow; status: SyncStatus }>(
        `/admin/sources/conflicts/${enc(conflictId)}/resolve`,
        content === undefined ? { choice } : { choice, content },
      ),
    onSuccess: (_data, variables) => {
      // Both cache entries for this source (open-only and with-history) go stale.
      void queryClient.invalidateQueries({ queryKey: conflictsKeyPrefix(variables.sourceId) });
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

// ------------------------------------------------------------------ reviews

export function reviewsKey(sourceId: string) {
  return ['admin', 'sources', sourceId, 'reviews'] as const;
}

async function fetchReviews(sourceId: string): Promise<ReviewEntry[]> {
  const res = await apiClient.get<{ reviews: ReviewRecord[] }>(`/admin/sources/${enc(sourceId)}/reviews`);
  return (res.reviews ?? []).map(toReviewEntry);
}

/** Open change requests for one `review`-mode source. */
export function useSourceReviews(sourceId: string | null) {
  return useQuery({
    queryKey: reviewsKey(sourceId ?? ''),
    queryFn: () => fetchReviews(sourceId!),
    enabled: !!sourceId,
    retry: retryUnlessForbidden,
  });
}

/**
 * The review queue across every `review`-mode source, one query per source so
 * a failing source does not blank the others.
 */
export function useReviewsBySource(sourceIds: string[]) {
  return useQueries({
    queries: sourceIds.map((id) => ({
      queryKey: reviewsKey(id),
      queryFn: () => fetchReviews(id),
      retry: retryUnlessForbidden,
      staleTime: 15_000,
    })),
    combine: (results) => ({
      isLoading: results.some((r) => r.isLoading),
      isError: results.length > 0 && results.every((r) => r.isError),
      error: results.find((r) => r.isError)?.error ?? null,
      groups: sourceIds.map((id, i) => ({
        sourceId: id,
        reviews: results[i]?.data ?? [],
        isLoading: results[i]?.isLoading ?? false,
        isError: results[i]?.isError ?? false,
      })),
    }),
  });
}

export interface ReviewActionInput {
  sourceId: string;
  pageId: string;
}

/** Ask the host for the change request's current state and re-index a merge. */
export function useRefreshReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, pageId }: ReviewActionInput) =>
      apiClient.post<{ review: ReviewRecord | null }>(`/admin/sources/${enc(sourceId)}/reviews/${enc(pageId)}/refresh`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: reviewsKey(variables.sourceId) });
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

/** Approve in-app: calls the host's merge API for this item's change request. */
export function useMergeReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, pageId }: ReviewActionInput) =>
      apiClient.post<{ review: ReviewRecord | null }>(`/admin/sources/${enc(sourceId)}/reviews/${enc(pageId)}/merge`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: reviewsKey(variables.sourceId) });
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

// ---------------------------------------------------------- connectivity

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

/** What the probe tests: a URL, plus the NAMES of the credential to try it with. */
export interface ConnectionProbe {
  remoteUrl: string;
  /** `host_token_env` as typed in the form — a name, never a token (issue 122). */
  hostTokenEnv?: string;
  hostKind?: string;
}

/**
 * Read-connectivity probe for a remote URL (`git ls-remote` server-side) before
 * the row is saved. Still the legacy `/admin/repos/test` route — it is about a
 * URL, not about a registered source, so there is no registry equivalent.
 *
 * The credential variable's NAME goes with it so the server tries the same
 * token the sync engine would (issue 122); a private repository would otherwise
 * report "not reachable" for a source that is configured perfectly well. The
 * value never travels in either direction — the server answers with presence
 * and a message, nothing more.
 */
export function useTestConnection() {
  return useMutation({
    mutationFn: (probe: ConnectionProbe) =>
      apiClient.post<ConnectionResult>('/admin/repos/test', {
        remote_url: probe.remoteUrl,
        ...(probe.hostTokenEnv ? { host_token_env: probe.hostTokenEnv } : {}),
        ...(probe.hostKind ? { host_kind: probe.hostKind } : {}),
      }),
  });
}
