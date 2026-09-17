import { describe, expect, it } from 'vitest';
import { auditSubject, compactPayload, summarizeAuditEntry } from './auditSummary.js';

const entry = (action: string, payload: unknown, item: { page_id?: string; page_slug?: string; page_title?: string } = {}) => ({
  action,
  payload,
  page_id: item.page_id ?? null,
  page_slug: item.page_slug ?? null,
  page_title: item.page_title ?? null,
});

const summary = (action: string, payload: unknown, item?: Parameters<typeof entry>[2]) => summarizeAuditEntry(entry(action, payload, item));

describe('summarizeAuditEntry — sign-in', () => {
  it('auth.login / auth.logout: where from', () => {
    expect(summary('auth.login', { ip: '10.0.0.9' })).toBe('from 10.0.0.9');
    expect(summary('auth.logout', { ip: null })).toBe('');
  });

  it('auth.login_failed: the name tried and where from, and the one that started a lockout', () => {
    expect(summary('auth.login_failed', { username_attempted: 'bob', ip: '10.0.0.9', throttled: false })).toBe('as "bob" from 10.0.0.9');
    expect(summary('auth.login_failed', { username_attempted: 'bob', ip: '10.0.0.9', throttled: true })).toBe('as "bob" from 10.0.0.9 (started a lockout)');
    expect(summary('auth.login_failed', {})).toBe('');
  });

  it('auth.login_throttled: the name, and how long the lock lasts', () => {
    expect(summary('auth.login_throttled', { username_attempted: 'bob', ip: '10.0.0.9', buckets: ['username'], retry_after_seconds: 890 })).toBe(
      'as "bob" from 10.0.0.9 · locked for 15 min',
    );
  });
});

describe('summarizeAuditEntry — accounts', () => {
  it('user.create', () => {
    expect(summary('user.create', { user_id: 'u2', username: 'bob', role: 'user' })).toBe('bob (user)');
  });

  it('user.role_change: "bob: user → admin"', () => {
    expect(summary('user.role_change', { user_id: 'u2', username: 'bob', from: 'user', to: 'admin' })).toBe('bob: user → admin');
  });

  it('user.disable, both directions', () => {
    expect(summary('user.disable', { user_id: 'u2', username: 'bob', disabled: true })).toBe('bob disabled');
    expect(summary('user.disable', { user_id: 'u2', username: 'bob', disabled: false })).toBe('bob enabled');
  });

  it('user.password_reset: the account by name, and by id on an older row without one', () => {
    expect(summary('user.password_reset', { user_id: 'u2', username: 'bob' })).toBe('temporary password for bob');
    expect(summary('user.password_reset', { user_id: 'u2' })).toBe('temporary password for account u2');
    expect(summary('user.password_reset', null)).toBe('temporary password for an account');
  });

  it('user.password_change', () => {
    expect(summary('user.password_change', { sessions_rotated: true })).toBe('own password · other sessions signed out');
  });
});

describe('summarizeAuditEntry — tokens', () => {
  it('token.create: name, scope, expiry; never a secret', () => {
    const line = summary('token.create', { id: 't1', name: 'ci-bot', scope: 'read', expires_at: '2026-12-01T00:00:00.000Z' });
    expect(line).toMatch(/^"ci-bot" · read · expires /);
    expect(summary('token.create', { id: 't1', name: 'ci-bot', scope: 'write', expires_at: null })).toBe('"ci-bot" · write · no expiry');
  });

  it('token.revoke: the token name and its owner', () => {
    expect(summary('token.revoke', { id: 't1', token_name: 'ci-bot', owner_username: 'bob', self: false })).toBe('"ci-bot" owned by bob');
    expect(summary('token.revoke', { id: 't1', token_name: 'ci-bot', owner_username: 'eric', self: true })).toBe('"ci-bot" (own token)');
  });

  it('token.revoke on an older row without names falls back to the id', () => {
    expect(summary('token.revoke', { id: 't1', self: false })).toBe('token t1');
    expect(summary('token.revoke', { id: 't1', self: true })).toBe('token t1 (own token)');
  });
});

describe('summarizeAuditEntry — configuration', () => {
  it('config.read_access_change: "login required → public"', () => {
    expect(summary('config.read_access_change', { from: 'authenticated', to: 'public' })).toBe('login required → public');
  });

  it('config.password_policy: the fields that changed', () => {
    expect(
      summary('config.password_policy', {
        from: { min_length: 8, require_number: false, require_symbol: false, require_uppercase: false },
        to: { min_length: 12, require_number: true, require_symbol: false, require_uppercase: false },
      }),
    ).toBe('min_length 8 → 12, require_number false → true');
    expect(summary('config.password_policy', { from: { min_length: 8 }, to: { min_length: 8 } })).toBe('no change');
  });

  it('config.token_policy, including unlimited', () => {
    expect(summary('config.token_policy', { from_max_days: 90, to_max_days: null })).toBe('max token lifetime 90 days → no limit');
  });

  it('space.visibility_change', () => {
    expect(summary('space.visibility_change', { space_id: 's1', slug: 'eng', from: 'private', to: 'public' })).toBe('eng: private → public');
  });
});

describe('summarizeAuditEntry — content', () => {
  const item = { page_id: 'p1', page_slug: 'onboarding', page_title: 'Onboarding' };

  it('page.create / update / delete / restore name the item', () => {
    expect(summary('page.create', { title: 'Onboarding', slug: 'onboarding', status: 'draft' }, item)).toBe('"Onboarding" · draft');
    expect(summary('page.update', { expected_version: 3 }, item)).toBe('"Onboarding"');
    expect(summary('page.delete', null, { page_id: 'p1' })).toBe('item p1');
    expect(summary('page.restore', null, item)).toBe('"Onboarding"');
  });

  it('page.rename', () => {
    expect(summary('page.rename', { new_title: 'Welcome', link_action: 'update_all', affected_count: 4 }, item)).toBe('"Onboarding" → "Welcome" · 4 items updated');
    expect(summary('page.rename', { new_title: 'Onboarding', affected_count: 1 }, item)).toBe('→ "Onboarding"');
  });

  it('content.refused: the item, the reason and the rules', () => {
    expect(
      summary('content.refused', {
        reason: 'lint_failed',
        source: 'mcp',
        operation: 'create',
        title: 'Draft note',
        slug: 'draft-note',
        topic: 'eng',
        rules: [{ code: 'type-required', path: 'type' }, { code: 'description-required', path: null }],
      }),
    ).toBe('"Draft note" · lint_failed · rules: type-required, description-required · via MCP agent');
  });

  it('content.refused with many rules says how many more', () => {
    const rules = ['a', 'b', 'c', 'd', 'e'].map((code) => ({ code, path: null }));
    expect(summary('content.refused', { reason: 'lint_failed', title: 'X', rules })).toBe('"X" · lint_failed · rules: a, b, c, +2 more');
  });

  it('content.publish_lint_override and mcp.create_item', () => {
    expect(summary('content.publish_lint_override', { source: 'ui', diagnostics: [{}, {}] }, item)).toBe('"Onboarding" · published over 2 errors');
    expect(summary('mcp.create_item', { tool: 'create_item', client: 'claude', source_fingerprint: 'abc' }, item)).toBe('"Onboarding" · via claude');
  });
});

describe('summarizeAuditEntry — data, sources, system', () => {
  it('okf.export / okf.import / okf.import_rejected', () => {
    expect(summary('okf.export', { format: 'archive', item_count: 12, assets: 3, space: 'eng', type: null })).toBe('archive · 12 items · 3 assets · topic eng');
    expect(summary('okf.import', { format: 'json', files: 4, created: 2, updated: 1 })).toBe('json · 2 created, 1 updated');
    expect(summary('okf.import_rejected', { format: 'archive', bytes: 100, reason: 'bundle_not_conformant' })).toBe('archive · bundle_not_conformant');
  });

  it('source.upsert / remove / conflict_resolve', () => {
    expect(summary('source.upsert', { id: 'docs', created: true, fields: ['mode'], mode_from: null, mode_to: 'mirror' })).toBe('created docs');
    expect(summary('source.upsert', { id: 'docs', created: false, fields: ['enabled', 'mode'], mode_from: 'mirror', mode_to: 'review' })).toBe(
      'updated docs · mode mirror → review · fields: enabled, mode',
    );
    expect(summary('source.remove', { id: 'docs', mode: 'mirror', remote_url: 'x' })).toBe('removed docs · mirror');
    expect(summary('source.conflict_resolve', { conflict_id: 'c1', source_id: 'docs', path: 'a.md', resolution: 'ours' })).toBe('docs · a.md · ours');
  });

  it('audit.retention_trim and backup.drill_run', () => {
    expect(summary('audit.retention_trim', { removed: 1, cutoff: '2026-06-01T00:00:00.000Z', retention_days: 90 })).toMatch(/^removed 1 entry · older than .+ · retention 90 days$/);
    expect(summary('backup.drill_run', { outcome: 'passed', rpo_seconds: 30, rto_seconds: 12 })).toBe('passed · RPO 30s · RTO 12s');
    expect(summary('backup.drill_run', { outcome: 'failed', failure: 'restore check failed' })).toBe('failed · restore check failed');
  });
});

describe('unknown action codes', () => {
  it('render up to three primitive fields as key: value', () => {
    expect(summary('widget.frob', { a: 1, b: 'two', nested: { x: 1 }, c: true, d: 'four' })).toBe('a: 1, b: two, c: true');
  });

  it('never render a secret-shaped key, even if the server let one through', () => {
    expect(compactPayload({ api_key: 'k', session_token: 't', password_hint: 'p', name: 'ok' })).toBe('name: ok');
  });

  it('handle a non-object payload', () => {
    expect(summary('legacy.text', 'not json {')).toBe('not json {');
    expect(summary('legacy.none', null)).toBe('');
  });
});

describe('auditSubject', () => {
  it('names the account a user.* row acted on, by username or by id on older rows', () => {
    expect(auditSubject(entry('user.role_change', { user_id: 'u2', username: 'bob' }))).toEqual({ value: 'bob', label: 'bob' });
    expect(auditSubject(entry('user.password_reset', { user_id: 'u2' }))).toEqual({ value: 'u2', label: 'account u2' });
  });

  it('names the username tried at a failed sign-in', () => {
    expect(auditSubject(entry('auth.login_failed', { username_attempted: 'bob' }))?.value).toBe('bob');
  });

  it("names a revoked token's owner, else the token", () => {
    expect(auditSubject(entry('token.revoke', { id: 't1', token_name: 'ci', owner_username: 'bob' }))?.value).toBe('bob');
    expect(auditSubject(entry('token.revoke', { id: 't1' }))).toEqual({ value: 't1', label: 'token t1' });
  });

  it('names sources and topics by id, and nothing for rows without a subject', () => {
    expect(auditSubject(entry('source.conflict_resolve', { source_id: 'docs', conflict_id: 'c1' }))?.value).toBe('docs');
    expect(auditSubject(entry('space.visibility_change', { space_id: 's1', slug: 'eng' }))).toEqual({ value: 's1', label: 'topic eng' });
    expect(auditSubject(entry('auth.login', { ip: '1.2.3.4' }))).toBeNull();
  });
});
