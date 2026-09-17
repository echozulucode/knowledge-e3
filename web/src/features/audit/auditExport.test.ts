import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, auditCsv, auditJson, csvCell, exportFilename } from './auditExport.js';
import type { AuditRecord } from './queries.js';

const record = (over: Partial<AuditRecord>): AuditRecord => ({
  id: 1,
  occurred_at: '2026-09-13T23:02:11.000Z',
  actor_id: null,
  actor_username: null,
  action: 'auth.login_failed',
  page_id: null,
  page_slug: null,
  page_title: null,
  version_id: null,
  payload: null,
  ...over,
});

describe('csvCell', () => {
  it('leaves plain text alone and writes null as empty', () => {
    expect(csvCell('eric')).toBe('eric');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a comma, a line break, and doubles a quote', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('cr\r\nlf')).toBe('"cr\r\nlf"');
    expect(csvCell('as "bob"')).toBe('"as ""bob"""');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    // Only a LEADING sign is dangerous.
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('writes an object as JSON, quoted', () => {
    expect(csvCell({ from: 'user', to: 'admin' })).toBe('"{""from"":""user"",""to"":""admin""}"');
  });
});

describe('auditCsv', () => {
  it('writes a header and one CRLF row per entry, with the derived actor, summary and subject', () => {
    const csv = auditCsv([
      record({ id: 7, payload: { username_attempted: '=cmd', ip: '10.0.0.9', throttled: false } }),
      record({ id: 6, actor_id: 'u1', actor_username: 'eric', action: 'user.role_change', payload: { user_id: 'u2', username: 'bob', from: 'user', to: 'admin' } }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[1]).toBe(
      `7,2026-09-13T23:02:11.000Z,(anonymous),,auth.login_failed,"as ""=cmd"" from 10.0.0.9",'=cmd,,,"{""username_attempted"":""=cmd"",""ip"":""10.0.0.9"",""throttled"":false}"`,
    );
    expect(lines[2]).toContain(',eric,u1,user.role_change,bob: user → admin,bob,');
    expect(lines[3]).toBe('');
  });
});

describe('auditJson', () => {
  it('says what was exported and whether it was capped', () => {
    const parsed = JSON.parse(
      auditJson([record({ id: 3 })], { exportedAt: '2026-09-14T00:00:00.000Z', filters: { range: '7d', actor: 'eric' }, capped: true }),
    );
    expect(parsed).toMatchObject({ exported_at: '2026-09-14T00:00:00.000Z', filters: { actor: 'eric', range: 'last 7 days' }, count: 1, capped: true, cap: 5000 });
    expect(parsed.entries[0]).toMatchObject({ id: 3, action: 'auth.login_failed', summary: '' });
  });
});

describe('exportFilename', () => {
  it('is sortable and filesystem-safe', () => {
    expect(exportFilename('csv', new Date('2026-09-14T18:02:59.000Z'))).toBe('audit-2026-09-14T18-02.csv');
  });
});
