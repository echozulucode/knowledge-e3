import { describe, expect, it } from 'vitest';
import type { PasswordPolicy } from '../../queries.js';
import {
  CREATE_USER_MIN_PASSWORD,
  GENERATED_PASSWORD_LENGTH,
  accountRules,
  cryptoRandomInts,
  errorText,
  generatePassword,
  newUserErrorField,
  pageCount,
  pageRangeText,
  passwordChecklist,
  passwordMeetsPolicy,
  readUsersSearch,
  relativeTime,
  shortDate,
  usersListParams,
  usersSearchToParams,
  withFilters,
  type RandomInts,
} from './usersModel.js';

const policy = (p: Partial<PasswordPolicy> = {}): PasswordPolicy => ({
  min_length: 8,
  require_number: false,
  require_symbol: false,
  require_uppercase: false,
  ...p,
});

describe('users URL state', () => {
  it('reads defaults from an empty search', () => {
    expect(readUsersSearch(undefined)).toEqual({ q: '', page: 1, create: false });
  });

  it('reads every key, and ignores malformed values', () => {
    expect(readUsersSearch({ q: 'bob', role: 'admin', status: 'disabled', page: '3', sort: 'last_seen', dir: 'desc', user: 'u1', new: 1 })).toEqual({
      q: 'bob',
      role: 'admin',
      status: 'disabled',
      page: 3,
      sort: 'last_seen',
      dir: 'desc',
      user: 'u1',
      create: true,
    });
    expect(readUsersSearch({ role: 'owner', status: 'gone', page: '-2', sort: 'password', dir: 'up', user: '  ' })).toEqual({ q: '', page: 1, create: false });
    // The router may hand numbers back for numeric-looking values.
    expect(readUsersSearch({ q: 42, page: 2 })).toMatchObject({ q: '42', page: 2 });
  });

  it('writes only what differs from the defaults, and round-trips', () => {
    expect(usersSearchToParams({ q: '  ', page: 1, create: false })).toEqual({});
    const state = { q: 'ann', role: 'user' as const, page: 2, sort: 'username' as const, dir: 'desc' as const, user: 'x', create: false };
    const params = usersSearchToParams(state);
    expect(params).toEqual({ q: 'ann', role: 'user', page: 2, sort: 'username', dir: 'desc', user: 'x' });
    expect(readUsersSearch(params)).toEqual(state);
    expect(usersSearchToParams({ q: '', page: 1, create: true })).toEqual({ new: 1 });
  });

  it('a filter, search or sort change goes back to page 1', () => {
    const state = { q: '', page: 7, create: false };
    expect(withFilters(state, { role: 'admin' })).toMatchObject({ role: 'admin', page: 1 });
    expect(withFilters(state, { q: 'x' }).page).toBe(1);
  });

  it('maps a page state to limit/offset and server sort', () => {
    expect(usersListParams({ q: ' bob ', status: 'active', page: 3, create: false })).toEqual({ q: 'bob', status: 'active', limit: 50, offset: 100 });
    expect(usersListParams({ q: '', page: 1, sort: 'created', create: false })).toEqual({ limit: 50, offset: 0, sort: 'created', direction: 'asc' });
  });

  it('pager text and page count', () => {
    expect(pageRangeText(0, 50, 1204)).toBe('1–50 of 1,204');
    expect(pageRangeText(1200, 4, 1204)).toBe('1,201–1,204 of 1,204');
    expect(pageRangeText(0, 0, 0)).toBe('0 of 0');
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
  });
});

describe('relative time', () => {
  const now = new Date(2026, 8, 14, 12, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('never, just now, minutes, hours', () => {
    expect(relativeTime(null, now)).toBe('Never');
    expect(relativeTime('not a date', now)).toBe('—');
    expect(relativeTime(ago(10_000), now)).toBe('just now');
    // A clock slightly ahead is still just now.
    expect(relativeTime(ago(-5_000), now)).toBe('just now');
    expect(relativeTime(ago(60_000), now)).toBe('1 minute ago');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 minutes ago');
    expect(relativeTime(ago(60 * 60_000), now)).toBe('1 hour ago');
    expect(relativeTime(ago(2 * 60 * 60_000), now)).toBe('2 hours ago');
  });

  it('yesterday, days, then a short date with the year only when it differs', () => {
    const day = 24 * 60 * 60_000;
    expect(relativeTime(ago(day + 60_000), now)).toBe('yesterday');
    expect(relativeTime(ago(3 * day), now)).toBe('3 days ago');
    expect(relativeTime(new Date(2026, 7, 30, 9).toISOString(), now)).toBe('Aug 30');
    expect(relativeTime(new Date(2025, 5, 1, 9).toISOString(), now)).toBe('Jun 01, 2025');
    expect(shortDate(new Date(2026, 5, 1).toISOString(), now)).toBe('Jun 01');
    expect(shortDate(null, now)).toBe('—');
  });
});

describe('password checklist', () => {
  it('never asks for less than the create endpoint accepts', () => {
    const checks = passwordChecklist(policy({ min_length: 4 }), 'abcde');
    expect(checks).toEqual([{ id: 'length', label: `At least ${CREATE_USER_MIN_PASSWORD} characters`, met: false }]);
    expect(passwordChecklist(undefined, 'abcdefgh')[0]).toMatchObject({ met: true });
  });

  it('lists only the rules the policy turns on, each with the server’s test', () => {
    const p = policy({ min_length: 12, require_number: true, require_uppercase: true, require_symbol: true });
    expect(passwordChecklist(p, '').map((c) => [c.id, c.label, c.met])).toEqual([
      ['length', 'At least 12 characters', false],
      ['number', 'A number', false],
      ['uppercase', 'An uppercase letter', false],
      ['symbol', 'A symbol', false],
    ]);
    expect(passwordMeetsPolicy(p, 'Abcdefghijk1')).toBe(false);
    expect(passwordMeetsPolicy(p, 'Abcdefghij1!')).toBe(true);
  });
});

describe('password generator', () => {
  it('satisfies every policy combination with the real random source', () => {
    for (const require_number of [false, true]) {
      for (const require_uppercase of [false, true]) {
        for (const require_symbol of [false, true]) {
          for (const min_length of [1, 8, 32]) {
            const p = policy({ min_length, require_number, require_uppercase, require_symbol });
            for (let i = 0; i < 25; i += 1) {
              const pw = generatePassword(p);
              expect(passwordMeetsPolicy(p, pw)).toBe(true);
              expect(pw.length).toBe(Math.max(GENERATED_PASSWORD_LENGTH, min_length));
            }
          }
        }
      }
    }
  });

  it('places required classes even when the random pool picks never hit them', () => {
    // Always index 0: the pool's first character ("a"), so without forced
    // placement there would be no digit, uppercase or symbol at all.
    const zeros: RandomInts = (count) => Array.from({ length: count }, () => 0);
    const p = policy({ require_number: true, require_uppercase: true, require_symbol: true });
    const pw = generatePassword(p, zeros);
    expect(passwordMeetsPolicy(p, pw)).toBe(true);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
  });

  it('avoids look-alike characters', () => {
    for (let i = 0; i < 50; i += 1) expect(generatePassword(undefined)).not.toMatch(/[0O1lI]/);
  });

  it('cryptoRandomInts stays in range and is not stuck', () => {
    const values = cryptoRandomInts(2000, 7);
    expect(values).toHaveLength(2000);
    expect(values.every((v) => Number.isInteger(v) && v >= 0 && v < 7)).toBe(true);
    expect(new Set(values).size).toBe(7);
  });
});

describe('account rules', () => {
  const bob = { id: 'b', username: 'bob', role: 'admin' as const, status: 'active' as const };

  it('states the self rules', () => {
    const rules = accountRules(bob, 'b', 3);
    expect(rules.roleLockedReason).toMatch(/your own role/);
    expect(rules.disableLockedReason).toMatch(/your own account/);
  });

  it('states the only-active-admin rule, from the active admin count', () => {
    const rules = accountRules(bob, 'me', 1);
    expect(rules.roleLockedReason).toBe('bob is the only active admin, so their role cannot change until another account is an admin.');
    expect(rules.disableLockedReason).toMatch(/only active admin/);
    expect(accountRules(bob, 'me', 2)).toEqual({ roleLockedReason: null, disableLockedReason: null });
  });

  it('claims nothing while the count loads, and nothing about disabling an already-disabled account', () => {
    expect(accountRules(bob, 'me', undefined)).toEqual({ roleLockedReason: null, disableLockedReason: null });
    expect(accountRules({ ...bob, status: 'disabled' }, 'me', 1).disableLockedReason).toBeNull();
    expect(accountRules({ ...bob, role: 'user' }, 'me', 1)).toEqual({ roleLockedReason: null, disableLockedReason: null });
  });
});

describe('create errors', () => {
  it('maps server reasons and messages to fields', () => {
    expect(newUserErrorField({ statusCode: 409, reason: 'username_taken' })).toBe('username');
    expect(newUserErrorField({ statusCode: 409, reason: 'email_taken' })).toBe('email');
    expect(newUserErrorField({ statusCode: 400, message: 'Password must include a number.' })).toBe('password');
    expect(newUserErrorField({ statusCode: 400, message: ['email must be an email'] })).toBe('email');
    expect(newUserErrorField({ statusCode: 400, message: ['username must be longer than or equal to 2 characters'] })).toBe('username');
    expect(newUserErrorField({ statusCode: 500, message: 'boom' })).toBeNull();
    expect(newUserErrorField(null)).toBeNull();
  });

  it('errorText joins a validation array', () => {
    expect(errorText({ message: ['a', 'b'] })).toBe('a. b');
    expect(errorText({ message: '' }, 'fallback')).toBe('fallback');
    expect(errorText(undefined, 'fallback')).toBe('fallback');
  });
});
