/**
 * Feature-local queries for the user sheet (the admin UX review §4.3). The
 * users list hooks themselves live in `web/src/queries.ts` with the rest of
 * user management.
 */
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../api.js';
import type { AuditPage } from '../audit/queries.js';

export const RECENT_ACTIVITY_LIMIT = 5;

/**
 * The last few audit rows this account wrote, from the existing audit endpoint.
 * `actor` accepts a username (the audit page resolves it to the id), which is
 * also what the "View all in audit log" link carries, so the two agree.
 */
export function useUserRecentActivity(username: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'audit', 'user-recent', username],
    queryFn: () =>
      apiClient.get<AuditPage>(`/admin/audit?actor=${encodeURIComponent(username!)}&limit=${RECENT_ACTIVITY_LIMIT}`),
    enabled: Boolean(username),
    staleTime: 5_000,
  });
}
