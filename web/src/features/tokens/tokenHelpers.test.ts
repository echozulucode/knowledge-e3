import { describe, expect, it } from 'vitest';
import { TOKEN_STATE_LABELS, expiryOptions, mcpConfigSnippet, tokenState } from './tokenHelpers.js';

describe('expiryOptions', () => {
  it('offers every lifetime including "No expiry" when there is no maximum', () => {
    expect(expiryOptions(null).map((o) => o.value)).toEqual([30, 90, 365, null]);
  });

  it('drops "No expiry" and anything above the admin maximum', () => {
    expect(expiryOptions(90).map((o) => o.value)).toEqual([30, 90]);
    expect(expiryOptions(365).map((o) => o.value)).toEqual([30, 90, 365]);
    expect(expiryOptions(7)).toEqual([]);
  });
});

describe('mcpConfigSnippet', () => {
  it('points at the MCP endpoint on the current origin with a bearer header', () => {
    const snippet = mcpConfigSnippet('https://kb.example.com', 'e3_wABC');
    expect(snippet).toContain('https://kb.example.com/api/v1/mcp');
    expect(snippet).toContain('Authorization:  Bearer e3_wABC');
  });
});

describe('tokenState', () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  it('is revoked before anything else', () => {
    expect(tokenState({ revoked_at: '2026-01-01T00:00:00Z', expires_at: null }, now)).toBe('revoked');
  });
  it('is expired once expires_at is in the past', () => {
    expect(tokenState({ revoked_at: null, expires_at: '2026-09-06T00:00:00Z' }, now)).toBe('expired');
    expect(tokenState({ revoked_at: null, expires_at: '2026-09-08T00:00:00Z' }, now)).toBe('active');
  });
  it('never expires without an expires_at', () => {
    expect(tokenState({ revoked_at: null, expires_at: null }, now)).toBe('active');
  });
  it('is never active when the owner is disabled', () => {
    const live = { revoked_at: null, expires_at: '2026-09-08T00:00:00Z', owner_disabled: true };
    expect(tokenState(live, now)).toBe('owner_disabled');
    expect(tokenState({ ...live, expires_at: null }, now)).toBe('owner_disabled');
    expect(TOKEN_STATE_LABELS[tokenState(live, now)]).toBe('Owner disabled');
  });
  it('reports the permanent state first when the owner is also disabled', () => {
    expect(tokenState({ revoked_at: '2026-01-01T00:00:00Z', expires_at: null, owner_disabled: true }, now)).toBe('revoked');
    expect(tokenState({ revoked_at: null, expires_at: '2026-09-06T00:00:00Z', owner_disabled: true }, now)).toBe('expired');
  });
  it('treats an explicit owner_disabled=false like the self-service list', () => {
    expect(tokenState({ revoked_at: null, expires_at: null, owner_disabled: false }, now)).toBe('active');
  });
});
