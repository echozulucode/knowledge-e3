import { describe, it, expect } from 'vitest';
import {
  STATE_LABELS,
  VERDICT_LABELS,
  VERDICT_TONE,
  countStates,
  formatCheckedAt,
  orderChecks,
  verdictAnnouncement,
  verdictReason,
  type SystemCheck,
} from './systemVerdict.js';

const check = (over: Partial<SystemCheck> & { id: string; state: SystemCheck['state'] }): SystemCheck => ({
  title: over.id,
  summary: 's',
  action: null,
  link: null,
  evidence: [],
  ...over,
});

describe('system health presentation', () => {
  describe('verdictReason', () => {
    it('names the single failing check, so the verdict does not need interpreting', () => {
      const checks = [check({ id: 'a', state: 'ok' }), check({ id: 'b', title: 'Restore drill', state: 'fail' })];
      expect(verdictReason({ verdict: 'at_risk', checks })).toBe('Restore drill needs attention now.');
    });

    it('names two failing checks', () => {
      const checks = [check({ id: 'a', title: 'Database', state: 'fail' }), check({ id: 'b', title: 'Sources', state: 'fail' })];
      expect(verdictReason({ verdict: 'at_risk', checks })).toBe('Database and Sources need attention now.');
    });

    it('summarises more than two', () => {
      const checks = [
        check({ id: 'a', title: 'Database', state: 'fail' }),
        check({ id: 'b', title: 'Sources', state: 'fail' }),
        check({ id: 'c', title: 'Secrets', state: 'fail' }),
        check({ id: 'd', title: 'Disk headroom', state: 'fail' }),
      ];
      expect(verdictReason({ verdict: 'at_risk', checks })).toBe('Database, Sources and 2 more need attention now.');
    });

    it('falls back to the warns when nothing has failed', () => {
      const checks = [check({ id: 'a', state: 'ok' }), check({ id: 'b', title: 'Sources', state: 'warn' })];
      expect(verdictReason({ verdict: 'degraded', checks })).toBe('Sources is working but not fully.');
    });

    it('says how many passed when everything is ok', () => {
      const checks = [check({ id: 'a', state: 'ok' }), check({ id: 'b', state: 'ok' })];
      expect(verdictReason({ verdict: 'healthy', checks })).toBe('All 2 checks passed.');
    });

    it('survives a server that sent no checks at all', () => {
      expect(verdictReason({ verdict: 'healthy', checks: [] })).toBe('All 0 checks passed.');
    });
  });

  describe('orderChecks', () => {
    it('puts the rows that caused the verdict first, worst first', () => {
      const checks = [
        check({ id: 'ok1', state: 'ok' }),
        check({ id: 'warn1', state: 'warn' }),
        check({ id: 'fail1', state: 'fail' }),
        check({ id: 'ok2', state: 'ok' }),
      ];
      expect(orderChecks(checks).map((c) => c.id)).toEqual(['fail1', 'warn1', 'ok1', 'ok2']);
    });

    it('keeps the server order within a group, so refreshes do not reshuffle', () => {
      const checks = [check({ id: 'x', state: 'fail' }), check({ id: 'y', state: 'fail' })];
      expect(orderChecks(checks).map((c) => c.id)).toEqual(['x', 'y']);
    });

    it('does not mutate its input', () => {
      const checks = [check({ id: 'ok1', state: 'ok' }), check({ id: 'fail1', state: 'fail' })];
      orderChecks(checks);
      expect(checks.map((c) => c.id)).toEqual(['ok1', 'fail1']);
    });
  });

  it('counts states', () => {
    const checks = [
      check({ id: 'a', state: 'ok' }),
      check({ id: 'b', state: 'warn' }),
      check({ id: 'c', state: 'fail' }),
      check({ id: 'd', state: 'fail' }),
    ];
    expect(countStates(checks)).toEqual({ ok: 1, warn: 1, fail: 2 });
  });

  it('labels every verdict and every state in human words', () => {
    expect(VERDICT_LABELS).toEqual({ healthy: 'Healthy', degraded: 'Degraded', at_risk: 'At risk' });
    expect(STATE_LABELS.fail).toBe('At risk');
    expect(STATE_LABELS.warn).toBe('Needs attention');
    expect(VERDICT_TONE.at_risk).toBe('alert');
  });

  describe('formatCheckedAt', () => {
    it('renders a readable timestamp', () => {
      expect(formatCheckedAt('2026-09-12T12:00:00.000Z')).toMatch(/2026/);
    });

    it('hands back anything it cannot parse rather than printing Invalid Date', () => {
      expect(formatCheckedAt('not a date')).toBe('not a date');
    });
  });
});

describe('verdictAnnouncement', () => {
  it('announces only a change, never the first load or a repeat', () => {
    expect(verdictAnnouncement(undefined, 'at_risk')).toBeNull();
    expect(verdictAnnouncement('at_risk', 'at_risk')).toBeNull();
    expect(verdictAnnouncement('at_risk', undefined)).toBeNull();
    expect(verdictAnnouncement('at_risk', 'healthy')).toBe('System health changed from At risk to Healthy.');
    expect(verdictAnnouncement('healthy', 'degraded')).toBe('System health changed from Healthy to Degraded.');
  });
});
