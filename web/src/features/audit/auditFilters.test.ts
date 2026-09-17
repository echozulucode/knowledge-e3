import { describe, expect, it } from 'vitest';
import {
  activeFilterChips,
  auditRequestParams,
  auditSearchToParams,
  groupActionCodes,
  readAuditSearch,
  withFilter,
  withoutFilter,
} from './auditFilters.js';
import { fixedZone } from './auditModel.js';

const AT = Date.parse('2026-09-14T12:00:00.000Z');

describe('reading the URL', () => {
  it('reads every filter, trimming and dropping blanks', () => {
    expect(readAuditSearch({ actor: ' eric ', action: 'user.role_change', subject: 'bob', item: 'p1', entry: '', junk: 'x' })).toEqual({
      range: 'all',
      actor: 'eric',
      action: 'user.role_change',
      subject: 'bob',
      item: 'p1',
    });
    expect(readAuditSearch(undefined)).toEqual({ range: 'all' });
  });

  it('keeps the Users page link working: ?actor=<username>', () => {
    expect(readAuditSearch({ actor: 'bob' })).toEqual({ range: 'all', actor: 'bob' });
  });

  it('reads the older ?page_id= as the item', () => {
    expect(readAuditSearch({ page_id: 'p9' }).item).toBe('p9');
    expect(readAuditSearch({ page_id: 'old', item: 'new' }).item).toBe('new');
  });

  it('accepts numbers the router parsed out of the query string', () => {
    expect(readAuditSearch({ actor: 1234, entry: 42 })).toEqual({ range: 'all', actor: '1234', entry: '42' });
  });

  it('treats a bare since/until as a custom range, and ignores them under a preset', () => {
    expect(readAuditSearch({ since: '2026-09-01' })).toEqual({ range: 'custom', since: '2026-09-01' });
    expect(readAuditSearch({ range: '7d', since: '2026-09-01' })).toEqual({ range: '7d' });
    expect(readAuditSearch({ range: 'custom' })).toEqual({ range: 'custom' });
    expect(readAuditSearch({ range: 'forever' })).toEqual({ range: 'all' });
  });
});

describe('writing the URL', () => {
  it('drops unset filters so a shared link says only what was filtered', () => {
    expect(auditSearchToParams({ range: 'all' })).toEqual({});
    expect(auditSearchToParams({ range: '24h', action: 'auth.login_failed' })).toEqual({ range: '24h', action: 'auth.login_failed' });
  });

  it('writes a custom range as its days, or as range=custom while the days are still empty', () => {
    expect(auditSearchToParams({ range: 'custom', since: '2026-09-01', until: '2026-09-02' })).toEqual({ since: '2026-09-01', until: '2026-09-02' });
    expect(auditSearchToParams({ range: 'custom' })).toEqual({ range: 'custom' });
  });

  it('writes the entry id as a number, so the router does not quote it', () => {
    expect(auditSearchToParams({ range: 'all', entry: '42' })).toEqual({ entry: 42 });
  });

  it('round-trips through read', () => {
    const states = [
      { range: 'all' as const, actor: 'eric', subject: 'bob', item: 'p1', action: 'token.revoke' },
      { range: 'custom' as const, since: '2026-09-01', until: '2026-09-30' },
      { range: '30d' as const },
      { range: 'all' as const, entry: '7' },
    ];
    for (const state of states) expect(readAuditSearch(auditSearchToParams(state))).toEqual(state);
  });
});

describe('changing filters', () => {
  it('leaves the single-entry view on any other change, and switching to a preset clears the days', () => {
    expect(withFilter({ range: 'all', entry: '7' }, { actor: 'eric' })).toEqual({ range: 'all', actor: 'eric' });
    expect(withFilter({ range: 'custom', since: '2026-09-01' }, { range: '7d' })).toEqual({ range: '7d' });
    expect(withFilter({ range: 'all', actor: 'eric' }, { actor: undefined })).toEqual({ range: 'all' });
  });

  it('removes one filter at a time, and the date chip clears the whole range', () => {
    const state = { range: 'custom' as const, since: '2026-09-01', until: '2026-09-02', actor: 'eric' };
    expect(withoutFilter(state, 'range')).toEqual({ range: 'all', actor: 'eric' });
    expect(withoutFilter(state, 'actor')).toEqual({ range: 'custom', since: '2026-09-01', until: '2026-09-02' });
  });

  it('lists active chips in control order, and an empty custom range is not a filter yet', () => {
    expect(activeFilterChips({ range: 'custom', since: '2026-09-01', until: '2026-09-01', actor: 'eric', action: 'user.role_change' })).toEqual([
      { key: 'actor', label: 'actor', value: 'eric' },
      { key: 'action', label: 'action', value: 'user.role_change' },
      { key: 'range', label: 'when', value: '2026-09-01' },
    ]);
    expect(activeFilterChips({ range: 'custom' })).toEqual([]);
    expect(activeFilterChips({ range: '7d' })).toEqual([{ key: 'range', label: 'when', value: 'last 7 days' }]);
  });
});

describe('the request', () => {
  it('sends item as page_id and a custom range as local-day instants in the given zone', () => {
    const params = auditRequestParams({ range: 'custom', since: '2026-09-11', until: '2026-09-11', item: 'p1', subject: 'bob' }, AT, fixedZone(-300));
    expect(params.get('page_id')).toBe('p1');
    expect(params.get('subject')).toBe('bob');
    expect(params.get('since')).toBe('2026-09-11T05:00:00.000Z');
    expect(params.get('until')).toBe('2026-09-12T05:00:00.000Z');
    expect(params.has('item')).toBe(false);
    expect(params.has('range')).toBe(false);
  });

  it('sends a preset as a since measured from the pinned now, and nothing for all time', () => {
    expect(auditRequestParams({ range: '24h' }, AT).get('since')).toBe('2026-09-13T12:00:00.000Z');
    expect(auditRequestParams({ range: '24h' }, AT).has('until')).toBe(false);
    expect(auditRequestParams({ range: 'all', entry: '7' }, AT).toString()).toBe('entry=7');
  });
});

describe('groupActionCodes', () => {
  it('groups by prefix, sorted, and keeps a selected code the log does not contain yet', () => {
    expect(groupActionCodes(['user.create', 'auth.login', 'auth.login_failed'], 'content.refused')).toEqual([
      { prefix: 'auth', codes: ['auth.login', 'auth.login_failed'] },
      { prefix: 'content', codes: ['content.refused'] },
      { prefix: 'user', codes: ['user.create'] },
    ]);
    expect(groupActionCodes(['auth.login'], 'auth.login')).toEqual([{ prefix: 'auth', codes: ['auth.login'] }]);
  });
});
