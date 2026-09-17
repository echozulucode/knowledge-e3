import { describe, expect, it } from 'vitest';
import { TOKEN_STATE_LABELS, tokenState } from './tokenHelpers.js';
import {
  TOKEN_STATE_TONES,
  hasTokenFilters,
  readTokensSearch,
  revokeDisabledReason,
  tokensListParams,
  tokensSearchToParams,
  withTokenFilters,
} from './tokensListModel.js';

describe('tokens page URL state', () => {
  it('reads every filter and the page, dropping anything malformed', () => {
    expect(readTokensSearch({ q: 'ci', owner: 'bob', state: 'owner_disabled', scope: 'write', page: 3 })).toEqual({
      q: 'ci',
      owner: 'bob',
      state: 'owner_disabled',
      scope: 'write',
      page: 3,
    });
    expect(readTokensSearch({ state: 'dormant', scope: 'admin', page: '0', owner: '  ' })).toEqual({ q: '', page: 1 });
    expect(readTokensSearch(undefined)).toEqual({ q: '', page: 1 });
  });

  it('writes only what differs from the defaults, with page as a number', () => {
    expect(tokensSearchToParams({ q: '', page: 1 })).toEqual({});
    expect(tokensSearchToParams({ q: ' ci ', owner: 'bob', state: 'active', scope: 'read', page: 2 })).toEqual({
      q: 'ci',
      owner: 'bob',
      state: 'active',
      scope: 'read',
      page: 2,
    });
  });

  it('round-trips through the URL', () => {
    const state = { q: 'laptop', owner: 'alice', state: 'revoked' as const, page: 4 };
    expect(readTokensSearch(tokensSearchToParams(state))).toEqual(state);
  });

  it('returns to page 1 when a filter changes', () => {
    expect(withTokenFilters({ q: '', page: 5 }, { state: 'expired' })).toEqual({ q: '', state: 'expired', page: 1 });
  });

  it('knows when any filter is applied', () => {
    expect(hasTokenFilters({ q: '', page: 3 })).toBe(false);
    expect(hasTokenFilters({ q: ' ', page: 1 })).toBe(false);
    expect(hasTokenFilters({ q: '', scope: 'write', page: 1 })).toBe(true);
  });

  it('sends the filters and the page window to the server', () => {
    expect(tokensListParams({ q: ' ci ', owner: 'bob', state: 'active', scope: 'write', page: 3 })).toEqual({
      owner: 'bob',
      state: 'active',
      scope: 'write',
      q: 'ci',
      limit: 50,
      offset: 100,
    });
    expect(tokensListParams({ q: '', page: 1 }, 10)).toEqual({ limit: 10, offset: 0 });
  });
});

describe('token status and revoke', () => {
  const now = Date.parse('2026-09-14T00:00:00Z');

  it('labels a live token of a disabled owner "Owner disabled" as a warning, never as active', () => {
    const state = tokenState({ revoked_at: null, expires_at: null, owner_disabled: true }, now);
    expect(TOKEN_STATE_LABELS[state]).toBe('Owner disabled');
    expect(TOKEN_STATE_TONES[state]).toBe('warn');
    expect(TOKEN_STATE_TONES.active).toBe('ok');
  });

  it('explains why a revoked or expired token cannot be revoked, and allows the rest', () => {
    expect(revokeDisabledReason('revoked')).toBe('Already revoked.');
    expect(revokeDisabledReason('expired')).toMatch(/expired/i);
    expect(revokeDisabledReason('active')).toBeNull();
    // Re-enabling the owner would bring it back, so revoking still matters.
    expect(revokeDisabledReason('owner_disabled')).toBeNull();
  });
});
