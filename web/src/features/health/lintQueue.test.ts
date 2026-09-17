/**
 * The lint queue's per-row detail (plan B4). The payload is a stored
 * `sync_diagnostics` row read back by the server, so the reading must never
 * throw and must never invent a key the lint did not name.
 */
import { describe, expect, it } from 'vitest';
import { QUEUE_LABELS } from './queries.js';
import { OKF_IMPORT_SOURCE_ID, inboundDoorLabel, lintDetailOf, moreDiagnosticsText } from './lintQueue.js';

describe('inboundDoorLabel', () => {
  it('names the door: a registry source syncs, the import constant is the OKF import', () => {
    expect(inboundDoorLabel('topic:handbook')).toBe('Sync from topic:handbook');
    expect(inboundDoorLabel('main')).toBe('Sync from main');
    expect(inboundDoorLabel(OKF_IMPORT_SOURCE_ID)).toBe('OKF import');
  });
});

describe('lintDetailOf', () => {
  it('is null for a row with no detail — another queue, or a server that predates B4', () => {
    expect(lintDetailOf({})).toBeNull();
    expect(lintDetailOf({ lint: undefined })).toBeNull();
  });

  it('reads the source, file, and each diagnostic with its frontmatter key', () => {
    const detail = lintDetailOf({
      lint: {
        source_id: 'topic:handbook',
        path: 'docs/onboarding.md',
        detected_at: '2026-09-13T10:00:00.000Z',
        diagnostics: [
          { code: 'type.missing', severity: 'error', message: 'No type.', path: 'type' },
          { code: 'link.unresolved', severity: 'warning', message: 'Link to nowhere.' },
        ],
        diagnostics_total: 2,
      },
    });
    expect(detail).toEqual({
      door: 'Sync from topic:handbook',
      sourceId: 'topic:handbook',
      path: 'docs/onboarding.md',
      lines: [
        { code: 'type.missing', severity: 'error', message: 'No type.', key: 'type' },
        { code: 'link.unresolved', severity: 'warning', message: 'Link to nowhere.', key: null },
      ],
      more: 0,
    });
  });

  it('counts what the server left off, and drops an entry with no code rather than inventing one', () => {
    const detail = lintDetailOf({
      lint: {
        source_id: OKF_IMPORT_SOURCE_ID,
        path: 'concepts/orders.md',
        detected_at: '2026-09-13T10:00:00.000Z',
        diagnostics: [
          { code: 'category.missing', severity: 'error', message: 'No category.', path: 'categories' },
          { code: '', severity: 'error', message: 'Blank code.' } as never,
        ],
        diagnostics_total: 14,
      },
    });
    expect(detail?.door).toBe('OKF import');
    expect(detail?.lines.map((l) => l.code)).toEqual(['category.missing']);
    expect(detail?.more).toBe(13);
    expect(moreDiagnosticsText(detail!.more)).toBe('+13 more');
  });

  it('survives a payload whose inner shape is wrong', () => {
    const detail = lintDetailOf({
      lint: { source_id: 'main', path: 'concepts/x.md', detected_at: '', diagnostics: null as never, diagnostics_total: Number.NaN },
    });
    expect(detail).toMatchObject({ lines: [], more: 0 });
    expect(moreDiagnosticsText(0)).toBe('');
  });
});

describe('the lint queue label', () => {
  it('covers both doors that write the queue', () => {
    expect(QUEUE_LABELS.lint_failed_inbound).toBe('Arrived with lint errors (sync or import)');
  });
});
