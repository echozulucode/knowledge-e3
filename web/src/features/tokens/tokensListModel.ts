/**
 * Pure helpers for Admin → API tokens (`/admin/auth/tokens`,
 * the admin UX review §4.7): the page's URL state, the request it
 * sends, and how a token's state is shown and whether it can still be revoked.
 * Same shape as the Users page (features/users/usersModel.ts), whose pager
 * helpers this reuses.
 */
import type { StatusTone } from '../../components/admin/StatusChip.js';
import type { AdminTokenStateFilter, AdminTokensPageParams, TokenScope } from './queries.js';
import type { TokenState } from './tokenHelpers.js';

export const TOKENS_PAGE_SIZE = 50;

/**
 * Everything the page keeps in the query string, so a filtered list is a link
 * (the user sheet's "Manage →" opens `?owner=bob`) and Back undoes a filter.
 * Defaults are absent from the URL: no state filter means every state.
 */
export interface TokensSearch {
  q: string;
  /** Owner's username. */
  owner?: string;
  state?: AdminTokenStateFilter;
  scope?: TokenScope;
  /** 1-based. */
  page: number;
}

const STATES: readonly AdminTokenStateFilter[] = ['active', 'expired', 'revoked', 'owner_disabled'];

/** The State filter's choices, in the order the select lists them. `''` is All. */
export const TOKEN_STATE_FILTER_OPTIONS: { value: AdminTokenStateFilter | ''; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'owner_disabled', label: 'Owner disabled' },
];

function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read the page state from the router's untyped search object; anything malformed falls back to the default. */
export function readTokensSearch(search: Record<string, unknown> | undefined): TokensSearch {
  const s = search ?? {};
  const state = str(s['state']);
  const scope = str(s['scope']);
  const pageRaw = Number(str(s['page']) ?? '1');
  return {
    q: typeof s['q'] === 'string' ? s['q'] : typeof s['q'] === 'number' ? String(s['q']) : '',
    ...(str(s['owner']) ? { owner: str(s['owner']) } : {}),
    ...(state && (STATES as readonly string[]).includes(state) ? { state: state as AdminTokenStateFilter } : {}),
    ...(scope === 'read' || scope === 'write' ? { scope } : {}),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

/**
 * The query-string object for a state, defaults dropped. `page` is a NUMBER for
 * the reason usersSearchToParams gives (a string that parses as JSON is quoted
 * by the router's serializer).
 */
export function tokensSearchToParams(state: TokensSearch): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (state.q.trim()) out['q'] = state.q.trim();
  if (state.owner) out['owner'] = state.owner;
  if (state.state) out['state'] = state.state;
  if (state.scope) out['scope'] = state.scope;
  if (state.page > 1) out['page'] = state.page;
  return out;
}

/** A filter change starts again at page 1. */
export function withTokenFilters(state: TokensSearch, patch: Partial<Pick<TokensSearch, 'q' | 'owner' | 'state' | 'scope'>>): TokensSearch {
  return { ...state, ...patch, page: 1 };
}

export function hasTokenFilters(state: TokensSearch): boolean {
  return Boolean(state.q.trim() || state.owner || state.state || state.scope);
}

/** What `GET /admin/tokens` is sent for a page state. */
export function tokensListParams(state: TokensSearch, pageSize = TOKENS_PAGE_SIZE): AdminTokensPageParams {
  return {
    ...(state.owner ? { owner: state.owner } : {}),
    ...(state.state ? { state: state.state } : {}),
    ...(state.scope ? { scope: state.scope } : {}),
    ...(state.q.trim() ? { q: state.q.trim() } : {}),
    limit: pageSize,
    offset: (state.page - 1) * pageSize,
  };
}

/**
 * The chip tone for a token's state. Owner disabled is a warning: the token
 * looks live but opens nothing, and re-enabling the owner brings it back.
 * Expired and revoked are settled facts, not problems.
 */
export const TOKEN_STATE_TONES: Record<TokenState, StatusTone> = {
  active: 'ok',
  owner_disabled: 'warn',
  expired: 'info',
  revoked: 'info',
};

/**
 * Why Revoke is unavailable for a token, as the menu shows it; null when it can
 * be revoked. A token of a disabled owner CAN be: it would work again the moment
 * the owner is re-enabled, and revoking is how an admin makes sure it does not.
 */
export function revokeDisabledReason(state: TokenState): string | null {
  if (state === 'revoked') return 'Already revoked.';
  if (state === 'expired') return 'Expired, so it already cannot sign in.';
  return null;
}

export const SCOPE_LABELS: Record<TokenScope, string> = { read: 'Read', write: 'Write' };
