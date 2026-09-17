import { afterAll, describe, expect, it } from 'vitest';
import {
  auditActor,
  auditWindow,
  exactUtc,
  fixedZone,
  localDayInstant,
  presetSince,
  utcOffsetLabel,
} from './auditModel.js';

// Pin the timezone before any Date is built, for the tests that exercise the
// BROWSER's zone (the default): a DST boundary only exists in a zone that has
// one. The explicit-offset tests below do not depend on it. Restored afterwards
// so a reused test worker does not inherit it.
const originalTz = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const row = (over: Partial<Parameters<typeof auditActor>[0]>) => ({
  actor_id: null,
  actor_username: null,
  action: 'page.update',
  payload: null,
  ...over,
});

describe('auditActor', () => {
  it('names a current account by username', () => {
    expect(auditActor(row({ actor_id: 'u1', actor_username: 'eric' }))).toEqual({
      kind: 'user',
      label: 'eric',
      username: 'eric',
    });
  });

  it('shows a failed sign-in as (anonymous); the name tried belongs to the summary, not the actor', () => {
    const actor = auditActor(
      row({ action: 'auth.login_failed', payload: { username_attempted: 'bob', ip: '10.0.0.9', throttled: false } }),
    );
    expect(actor).toEqual({ kind: 'anonymous', label: '(anonymous)' });
  });

  it('shows a throttled sign-in as (anonymous) too, with or without a name', () => {
    expect(auditActor(row({ action: 'auth.login_throttled', payload: { username_attempted: 'bob' } })).label).toBe('(anonymous)');
    expect(auditActor(row({ action: 'auth.login_failed', payload: {} })).label).toBe('(anonymous)');
  });

  it('shows an actor id with no account behind it as a deleted account, keeping the id to filter by', () => {
    expect(auditActor(row({ actor_id: 'gone', actor_username: null }))).toEqual({
      kind: 'deleted',
      label: 'deleted account',
      id: 'gone',
    });
  });

  it('keeps "system" for rows the server wrote itself', () => {
    expect(auditActor(row({ action: 'audit.retention_trim', payload: { removed: 3 } }))).toEqual({
      kind: 'system',
      label: 'system',
    });
  });
});

describe('local day → UTC instant, with an explicit offset', () => {
  it('west of UTC (UTC−5): local midnight is 05:00 UTC the same day', () => {
    const zone = fixedZone(-300);
    expect(localDayInstant('2026-09-11', 0, zone)).toBe('2026-09-11T05:00:00.000Z');
    expect(localDayInstant('2026-09-11', 1, zone)).toBe('2026-09-12T05:00:00.000Z');
  });

  it('east of UTC (UTC+5:30): local midnight is 18:30 UTC the day BEFORE', () => {
    const zone = fixedZone(330);
    expect(localDayInstant('2026-09-11', 0, zone)).toBe('2026-09-10T18:30:00.000Z');
    const { since, until } = auditWindow({ since: '2026-09-11', until: '2026-09-11' }, zone);
    expect(since).toBe('2026-09-10T18:30:00.000Z');
    expect(until).toBe('2026-09-11T18:30:00.000Z');
  });

  it('includes the whole chosen day: To is the start of the NEXT local day', () => {
    // 22:30 on Sep 11 at UTC−5 is 03:30 on Sep 12 in UTC - the row a UTC-midnight bound excluded.
    const evening = '2026-09-12T03:30:00.000Z';
    const { since, until } = auditWindow({ since: '2026-09-11', until: '2026-09-11' }, fixedZone(-300));
    expect(since! <= evening && evening < until!).toBe(true);
  });

  it('crosses a month and a year boundary on the calendar, not by adding hours', () => {
    expect(localDayInstant('2026-12-31', 1, fixedZone(60))).toBe('2026-12-31T23:00:00.000Z');
  });

  it('is exactly UTC midnight at offset 0', () => {
    expect(localDayInstant('2026-09-11', 0, fixedZone(0))).toBe('2026-09-11T00:00:00.000Z');
  });
});

describe("local day → UTC instant, in the browser's own zone across DST", () => {
  it('is local midnight, not UTC midnight', () => {
    // EDT (UTC−4) in September.
    expect(localDayInstant('2026-09-11')).toBe('2026-09-11T04:00:00.000Z');
    expect(localDayInstant('2026-09-11', 1)).toBe('2026-09-12T04:00:00.000Z');
  });

  it('ends a 25-hour day at the next local midnight when DST ends', () => {
    // US DST ends 2026-11-01: EDT (UTC−4) → EST (UTC−5).
    const { since, until } = auditWindow({ since: '2026-11-01', until: '2026-11-01' });
    expect(since).toBe('2026-11-01T04:00:00.000Z');
    expect(until).toBe('2026-11-02T05:00:00.000Z');
    expect(Date.parse(until!) - Date.parse(since!)).toBe(25 * 60 * 60 * 1000);
  });

  it('ends a 23-hour day at the next local midnight when DST starts', () => {
    // US DST starts 2026-03-08: EST (UTC−5) → EDT (UTC−4).
    const { since, until } = auditWindow({ since: '2026-03-08', until: '2026-03-08' });
    expect(since).toBe('2026-03-08T05:00:00.000Z');
    expect(until).toBe('2026-03-09T04:00:00.000Z');
    expect(Date.parse(until!) - Date.parse(since!)).toBe(23 * 60 * 60 * 1000);
  });

  it('passes an ISO instant through untouched and omits blanks', () => {
    expect(localDayInstant('2026-09-11T18:02:11.000Z', 1)).toBe('2026-09-11T18:02:11.000Z');
    expect(auditWindow({ since: '', until: '  ' })).toEqual({});
  });
});

describe('presets', () => {
  it('are rolling windows ending at the pinned "now"', () => {
    const at = Date.parse('2026-09-14T09:00:00.000Z');
    expect(presetSince('24h', at)).toBe('2026-09-13T09:00:00.000Z');
    expect(presetSince('7d', at)).toBe('2026-09-07T09:00:00.000Z');
    expect(presetSince('30d', at)).toBe('2026-08-15T09:00:00.000Z');
  });
});

describe('utcOffsetLabel', () => {
  it('names the offset in effect on the given date, with a true minus sign', () => {
    expect(utcOffsetLabel(new Date('2026-09-13T12:00:00Z'))).toBe('UTC−4');
    expect(utcOffsetLabel(new Date('2026-12-13T12:00:00Z'))).toBe('UTC−5');
  });

  it('shows minutes and a plus east of UTC, and plain UTC at zero', () => {
    expect(utcOffsetLabel(new Date(), fixedZone(330))).toBe('UTC+5:30');
    expect(utcOffsetLabel(new Date(), fixedZone(0))).toBe('UTC');
  });
});

describe('exactUtc', () => {
  it('shows the UTC time, and the UTC date only when it differs from the local date', () => {
    // 18:02 EDT on Sep 13 is 22:02 UTC the same day.
    expect(exactUtc('2026-09-13T22:02:11.000Z')).toBe('22:02:11 UTC');
    // 21:00 EDT on Sep 13 is 01:00 UTC on Sep 14.
    expect(exactUtc('2026-09-14T01:00:00.000Z')).toBe('2026-09-14 01:00:00 UTC');
  });
});
