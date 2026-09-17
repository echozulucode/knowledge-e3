import type { ApiToken } from './queries.js';

export interface ExpiryOption {
  /** Days, or null for "No expiry". */
  value: number | null;
  label: string;
}

const LIFETIMES: ExpiryOption[] = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '365 days' },
  { value: null, label: 'No expiry' },
];

/** Lifetimes a user may pick, given the admin maximum (null = unlimited). */
export function expiryOptions(maxDays: number | null): ExpiryOption[] {
  if (maxDays === null) return LIFETIMES;
  return LIFETIMES.filter((o) => o.value !== null && o.value <= maxDays);
}

/** Header + endpoint an MCP client needs; `origin` is the site the user is on. */
export function mcpConfigSnippet(origin: string, token: string): string {
  return [
    `URL:            ${origin}/api/v1/mcp`,
    `Authorization:  Bearer ${token}`,
  ].join('\n');
}

export type TokenState = 'active' | 'expired' | 'revoked' | 'owner_disabled';

/**
 * What a token can do right now. Revoked and expired are checked first because
 * they are permanent: re-enabling the owner would not bring such a token back,
 * so "Owner disabled" would promise something untrue. `owner_disabled` only
 * arrives on the admin list; a person's own list never needs it (a disabled
 * account cannot sign in to look).
 */
export function tokenState(
  token: Pick<ApiToken, 'expires_at' | 'revoked_at'> & { owner_disabled?: boolean },
  now = Date.now(),
): TokenState {
  if (token.revoked_at) return 'revoked';
  if (token.expires_at && new Date(token.expires_at).getTime() < now) return 'expired';
  if (token.owner_disabled) return 'owner_disabled';
  return 'active';
}

export const TOKEN_STATE_LABELS: Record<TokenState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  owner_disabled: 'Owner disabled',
};

export function formatTokenDate(iso: string | null, empty = '—'): string {
  if (!iso) return empty;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return empty;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
