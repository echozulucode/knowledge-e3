/**
 * TanStack Query hooks for personal access tokens (self-service + admin).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../api.js';
import { AUTH_SETTINGS_KEY } from '../../queries.js';

export type TokenScope = 'read' | 'write';

/** No part of the secret is listed - not even a prefix (secrets are presence-only). */
export interface ApiToken {
  id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AdminApiToken extends ApiToken {
  user_id: string;
  username: string;
  /** The owner's account is disabled, so the token cannot sign in even though
   * it is neither revoked nor expired. */
  owner_disabled: boolean;
}

export interface TokenPolicy {
  /** Longest allowed lifetime in days; null = unlimited. */
  max_days: number | null;
}

export interface CreateTokenInput {
  name: string;
  scope: TokenScope;
  expires_in_days: number | null;
}

/** The raw token is only ever present on the create response. */
export type CreatedToken = ApiToken & { token: string };

const MY_TOKENS = ['me', 'tokens'] as const;
const ADMIN_TOKENS = ['admin', 'tokens'] as const;
const TOKEN_POLICY = ['admin', 'token-policy'] as const;

export function useMyTokens() {
  return useQuery({
    queryKey: MY_TOKENS,
    queryFn: () => apiClient.get<{ tokens: ApiToken[]; policy: TokenPolicy }>('/me/tokens'),
  });
}

export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTokenInput) => apiClient.post<CreatedToken>('/me/tokens', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MY_TOKENS });
      queryClient.invalidateQueries({ queryKey: ADMIN_TOKENS });
    },
  });
}

export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/me/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MY_TOKENS });
      queryClient.invalidateQueries({ queryKey: ADMIN_TOKENS });
    },
  });
}

export type AdminTokenStateFilter = 'active' | 'expired' | 'revoked' | 'owner_disabled';

/** `GET /admin/tokens` query: every filter optional; `owner` is a username or user id. */
export interface AdminTokensPageParams {
  owner?: string;
  state?: AdminTokenStateFilter;
  scope?: TokenScope;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminTokensPage {
  tokens: AdminApiToken[];
  /** Every token matching the filters, not just this page. */
  total: number;
  limit: number;
  offset: number;
}

/**
 * One server page of every user's tokens. The previous page stays on screen
 * while the next loads (`keepPreviousData`), as on Users.
 */
export function useAdminTokensPage(params: AdminTokensPageParams) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return useQuery({
    queryKey: [...ADMIN_TOKENS, 'page', qs],
    queryFn: () => apiClient.get<AdminTokensPage>(`/admin/tokens${qs ? `?${qs}` : ''}`),
    placeholderData: keepPreviousData,
  });
}

export function useAdminRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/admin/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_TOKENS });
      queryClient.invalidateQueries({ queryKey: MY_TOKENS });
    },
  });
}

export function useTokenPolicy() {
  return useQuery({
    queryKey: TOKEN_POLICY,
    queryFn: () => apiClient.get<TokenPolicy>('/admin/auth/token-policy'),
  });
}

export function useSetTokenPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: TokenPolicy) => apiClient.put<TokenPolicy>('/admin/auth/token-policy', policy),
    onSuccess: (policy) => {
      queryClient.setQueryData(TOKEN_POLICY, policy);
      queryClient.invalidateQueries({ queryKey: MY_TOKENS });
      queryClient.invalidateQueries({ queryKey: AUTH_SETTINGS_KEY });
    },
  });
}
