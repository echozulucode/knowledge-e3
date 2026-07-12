import { describe, it, expect } from 'vitest';
import { redact } from './redact.js';

describe('audit redact()', () => {
  it('redacts password field', () => {
    const obj = { username: 'alice', password: 'secret123' };
    const redacted = redact(obj);
    expect(redacted).toEqual({ username: 'alice' });
  });

  it('redacts password_hash field', () => {
    const obj = { id: '123', password_hash: 'scrypt$...' };
    const redacted = redact(obj);
    expect(redacted).toEqual({ id: '123' });
  });

  it('redacts old_password and new_password fields', () => {
    const obj = { old_password: 'old', new_password: 'new' };
    const redacted = redact(obj);
    expect(redacted).toEqual({});
  });

  it('redacts token, secret, authorization, cookie fields', () => {
    const obj = {
      token: 'abc123',
      secret: 'xyz789',
      authorization: 'Bearer token',
      cookie: 'session=...',
      safe_field: 'value',
    };
    const redacted = redact(obj);
    expect(redacted).toEqual({ safe_field: 'value' });
  });

  it('redacts keys case-insensitively', () => {
    const obj = { Password: 'secret', PASSWORD: 'secret2', Token: 'token' };
    const redacted = redact(obj);
    expect(redacted).toEqual({});
  });

  it('redacts nested objects', () => {
    const obj = {
      user: { username: 'alice', password: 'secret' },
      config: { api_key: 'key', db_password: 'pass' },
    };
    const redacted = redact(obj);
    // `db_password` matches the `password` substring rule, so it's stripped
    // alongside top-level `password`. `api_key` doesn't match any rule and
    // is kept.
    expect(redacted).toEqual({
      user: { username: 'alice' },
      config: { api_key: 'key' },
    });
  });

  it('redacts arrays of objects', () => {
    const obj = {
      users: [
        { username: 'alice', password: 'secret1' },
        { username: 'bob', password: 'secret2' },
      ],
    };
    const redacted = redact(obj);
    expect(redacted).toEqual({
      users: [{ username: 'alice' }, { username: 'bob' }],
    });
  });

  it('truncates long strings', () => {
    const longString = 'x'.repeat(5000);
    const obj = { data: longString };
    const redacted = redact(obj);
    const redactedStr = redacted.data as string;
    expect(redactedStr.length).toBeLessThan(longString.length);
    expect(redactedStr).toContain('...<truncated>');
  });

  it('does not truncate strings under 4096 chars', () => {
    const mediumString = 'x'.repeat(100);
    const obj = { data: mediumString };
    const redacted = redact(obj);
    expect(redacted).toEqual({ data: mediumString });
  });

  it('handles null and undefined', () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('handles primitives', () => {
    expect(redact(123)).toBe(123);
    expect(redact(true)).toBe(true);
    expect(redact('string')).toBe('string');
  });

  it('handles empty objects and arrays', () => {
    expect(redact({})).toEqual({});
    expect(redact([])).toEqual([]);
  });
});
