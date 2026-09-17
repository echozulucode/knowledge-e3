/**
 * The audit log read surface (plan §6 D1), `GET /admin/audit`.
 *
 * Feature-local like `features/sources/queries.ts` and `features/tokens/queries.ts`,
 * so the shared `web/src/queries.ts` keeps owning only what it already owns.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiClient, type ApiError } from '../../api.js';
import { auditRequestParams, filtersKey, type AuditFilters } from './auditFilters.js';

export interface AuditRecord {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  /** Null when the account is gone; `actor_id` still identifies it. */
  actor_username: string | null;
  action: string;
  page_id: string | null;
  /** Null when the target was hard-deleted — the row then cannot be linked. */
  page_slug: string | null;
  page_title: string | null;
  version_id: string | null;
  payload: unknown;
}

export interface AuditPage {
  entries: AuditRecord[];
  next_cursor: string | null;
  /** Every action string the log contains, for the filter select. */
  actions: string[];
  limit: number;
}

export const AUDIT_PAGE_SIZE = 50;
/** The server's per-request maximum; what an export pages with. */
export const AUDIT_MAX_PAGE = 200;

/** Never retry an admin route that told us we are not an admin. */
function retryUnlessForbidden(count: number, error: unknown): boolean {
  return (error as ApiError | null)?.statusCode !== 403 && count < 2;
}

/**
 * `at` is the "now" a preset ("Last 7 days") was measured from. It is fixed
 * when the first page loads and handed to every older page, so "Load older"
 * continues the same window instead of one that has slid forward since.
 */
interface PageParam {
  cursor: string;
  at: number | null;
}

export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: ['admin', 'audit', filtersKey(filters)],
    initialPageParam: { cursor: '', at: null } as PageParam,
    queryFn: async ({ pageParam }) => {
      const at = pageParam.at ?? Date.now();
      const params = auditRequestParams(filters, at);
      params.set('limit', String(AUDIT_PAGE_SIZE));
      if (pageParam.cursor) params.set('cursor', pageParam.cursor);
      const page = await apiClient.get<AuditPage>(`/admin/audit?${params.toString()}`);
      return { ...page, at };
    },
    getNextPageParam: (last): PageParam | undefined => (last.next_cursor ? { cursor: last.next_cursor, at: last.at } : undefined),
    retry: retryUnlessForbidden,
    staleTime: 5_000,
  });
}

const PICKER_OPTIONS = 20;

export interface AuditUserOption {
  id: string;
  username: string;
  email: string;
}

/**
 * Accounts for the Actor and Subject pickers, searched on the server so an
 * instance with a thousand users never ships them all to fill a dropdown.
 * Module-level (a stable function) because ReferencePicker re-runs its loader
 * whenever the function identity changes.
 */
export async function loadAuditUserOptions(query: string): Promise<AuditUserOption[]> {
  const params = new URLSearchParams({ limit: String(PICKER_OPTIONS), sort: 'username', direction: 'asc' });
  if (query.trim()) params.set('q', query.trim());
  const res = await apiClient.get<{ users: AuditUserOption[] }>(`/admin/users?${params.toString()}`);
  return res.users.map((u) => ({ id: u.id, username: u.username, email: u.email }));
}

export interface AuditItemOption {
  id: string;
  slug: string;
  title: string;
}

/** Items for the Item picker; keyed by id, which is what the log stores. */
export async function loadAuditItemOptions(query: string): Promise<AuditItemOption[]> {
  const params = new URLSearchParams({ limit: String(PICKER_OPTIONS), sort: 'title' });
  if (query.trim()) params.set('q', query.trim());
  const res = await apiClient.get<{ items: AuditItemOption[] }>(`/pages?${params.toString()}`);
  return res.items.map((item) => ({ id: item.id, slug: item.slug, title: item.title }));
}

/**
 * Every row for these filters, newest first, up to `cap`: what Export writes.
 * Pages at the server's maximum with the same cursor the table uses, so the
 * export and the table can never disagree about which rows match.
 */
export async function fetchAuditRows(filters: AuditFilters, cap: number): Promise<{ entries: AuditRecord[]; capped: boolean }> {
  const at = Date.now();
  const entries: AuditRecord[] = [];
  let cursor = '';
  for (;;) {
    const params = auditRequestParams(filters, at);
    params.set('limit', String(Math.min(AUDIT_MAX_PAGE, cap - entries.length)));
    if (cursor) params.set('cursor', cursor);
    const page = await apiClient.get<AuditPage>(`/admin/audit?${params.toString()}`);
    entries.push(...page.entries);
    if (!page.next_cursor) return { entries, capped: false };
    if (entries.length >= cap) return { entries: entries.slice(0, cap), capped: true };
    cursor = page.next_cursor;
  }
}
