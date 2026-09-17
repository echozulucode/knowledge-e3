/**
 * The Git mirror section of Content health (issue 88) has to read as an
 * operational alert — "indexed, not yet durable in git", and a restart replays
 * it — rather than as one more content queue. These are the pure helpers behind
 * that wording.
 */
import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatThreshold,
  itemLabel,
  mirrorAlert,
  mirrorDiagnosticsText,
  type MirrorHealth,
} from './mirrorHealth.js';

const empty: MirrorHealth = {
  stuck_after_ms: 5 * 60 * 1000,
  pending: { count: 0, items: [] },
  mirror_errors: { count: 0, items: [] },
};

describe('formatAge', () => {
  it('stays in seconds under a minute', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(59.7)).toBe('59s');
  });

  it('rolls up to minutes, hours, and days', () => {
    expect(formatAge(60)).toBe('1m');
    expect(formatAge(59 * 60)).toBe('59m');
    expect(formatAge(3600)).toBe('1h');
    expect(formatAge(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatAge(48 * 3600)).toBe('2d');
    expect(formatAge(52 * 3600)).toBe('2d 4h');
  });

  it('never renders a negative or nonsense age', () => {
    expect(formatAge(-10)).toBe('0s');
    expect(formatAge(Number.NaN)).toBe('0s');
  });
});

describe('formatThreshold', () => {
  it('words the server-supplied bound in the largest sensible unit', () => {
    expect(formatThreshold(1000)).toBe('1 second');
    expect(formatThreshold(90_000)).toBe('2 minutes');
    expect(formatThreshold(5 * 60 * 1000)).toBe('5 minutes');
    expect(formatThreshold(60 * 60 * 1000)).toBe('1 hour');
    expect(formatThreshold(2 * 60 * 60 * 1000)).toBe('2 hours');
  });
});

describe('itemLabel', () => {
  it('prefers the title, then the slug, then the page id', () => {
    expect(itemLabel({ title: 'Stuck Concept', slug: 'stuck-concept', page_id: 'p1' })).toBe('Stuck Concept');
    expect(itemLabel({ title: '  ', slug: 'stuck-concept', page_id: 'p1' })).toBe('stuck-concept');
    expect(itemLabel({ title: null, slug: null, page_id: 'p1' })).toBe('p1');
  });
});

describe('mirrorAlert', () => {
  it('reports the healthy case with the bound that produced it', () => {
    const alert = mirrorAlert(empty);
    expect(alert.tone).toBe('ok');
    expect(alert.headline).toContain('reached git');
    expect(alert.detail).toContain('5 minutes');
  });

  it('degrades gracefully on a server that predates the section', () => {
    expect(mirrorAlert(undefined).tone).toBe('ok');
    expect(mirrorAlert(undefined).headline).toContain('does not report');
  });

  it('names both halves of the symptom and explains what a restart does', () => {
    const alert = mirrorAlert({ ...empty, pending: { count: 2, items: [] }, mirror_errors: { count: 1, items: [] } });
    expect(alert.tone).toBe('alert');
    expect(alert.headline).toBe('2 changes pending for more than 5 minutes · 1 mirror in error or stuck dirty.');
    expect(alert.detail).toContain('not yet durable in git');
    expect(alert.detail).toContain('replays');
  });

  it('singularises a lone stuck row and omits the half that is clean', () => {
    const alert = mirrorAlert({ ...empty, pending: { count: 1, items: [] } });
    expect(alert.headline).toBe('1 change pending for more than 5 minutes.');
    expect(alert.headline).not.toContain('mirror');
  });

  it('alerts on mirror errors alone, with no pending rows at all', () => {
    const alert = mirrorAlert({ ...empty, mirror_errors: { count: 3, items: [] } });
    expect(alert.tone).toBe('alert');
    expect(alert.headline).toBe('3 mirrors in error or stuck dirty.');
  });
});

/**
 * B6 — the button that replaces runbook §3.1's "capture the evidence" SQL. The
 * text is going into an issue, so every column that query returns has to be in
 * it, and it has to survive a paste.
 */
describe('mirrorDiagnosticsText', () => {
  const stuck: MirrorHealth = {
    stuck_after_ms: 5 * 60 * 1000,
    pending: {
      count: 2,
      items: [
        {
          outbox_id: 'ob_1',
          page_id: 'pg_1',
          slug: 'weld-procedure',
          title: 'Weld | procedure',
          kind: 'upsert',
          source_id: 'main',
          file_path: 'main/ai/concepts/weld.md',
          created_at: '2026-09-12T08:00:00.000Z',
          age_seconds: 900,
          error: null,
          mirror_state: 'missing',
          mirror_error: null,
          last_commit: null,
        },
      ],
    },
    mirror_errors: {
      count: 1,
      items: [
        {
          page_id: 'pg_2',
          slug: null,
          title: null,
          path: 'topics/matlab/concepts/x.md',
          dirty: true,
          error: 'push rejected\nnon-fast-forward',
          updated_at: '2026-09-12T07:00:00.000Z',
          age_seconds: 7200,
          last_commit: 'abc1234',
        },
      ],
    },
  };

  it('carries every field the runbook SQL returns, for the rows the page holds', () => {
    const text = mirrorDiagnosticsText(stuck, new Date('2026-09-12T09:00:00.000Z'));
    for (const field of ['ob_1', 'pg_1', 'upsert', 'main', 'main/ai/concepts/weld.md', '2026-09-12T08:00:00.000Z', '15m', 'No mirror state']) {
      expect(text).toContain(field);
    }
    expect(text).toContain('pg_2');
    expect(text).toContain('topics/matlab/concepts/x.md');
    expect(text).toContain('abc1234');
    expect(text).toContain('Captured 2026-09-12T09:00:00.000Z');
    expect(text).toContain('2 changes pending');
  });

  it('survives the paste: no cell breaks its row', () => {
    const text = mirrorDiagnosticsText(stuck, new Date('2026-09-12T09:00:00.000Z'));
    // A pipe in a title and a newline in an error are the two ways a markdown
    // table loses its shape — and an error text is exactly where both occur.
    expect(text).toContain('Weld \\| procedure');
    expect(text).toContain('push rejected non-fast-forward');
    for (const row of text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))) {
      expect(row.split('|').length).toBeGreaterThan(2);
    }
  });

  it('says so, briefly, when the server reports no mirror health at all', () => {
    const text = mirrorDiagnosticsText(undefined, new Date('2026-09-12T09:00:00.000Z'));
    expect(text).toContain('does not report');
    expect(text).not.toContain('|');
  });
});
