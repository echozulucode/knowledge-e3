/**
 * Export ▾ on Admin → Audit: the CURRENT filtered result as JSON or CSV
 * (the admin UX review §4.8).
 *
 * Everything exported is what the API returned for these filters - the same
 * redacted payloads the page shows - plus the derived summary and actor label.
 * Nothing is looked up or reconstructed on the way out.
 *
 * CSV is opened in spreadsheets, and a spreadsheet EXECUTES a cell that starts
 * with `=`, `+`, `-` or `@` (CSV/formula injection, OWASP). Audit cells carry
 * text strangers control - the username typed at a failed sign-in, an item
 * title - so every such cell is prefixed with `'`, which spreadsheets treat as
 * "this is text". Tab and carriage return lead the same way in some tools.
 */
import { auditActor } from './auditModel.js';
import { activeFilterChips, type AuditFilters } from './auditFilters.js';
import { auditSubject, summarizeAuditEntry } from './auditSummary.js';
import type { AuditRecord } from './queries.js';

/** The most rows one export fetches. Beyond it the filters, not the export, are the tool. */
export const AUDIT_EXPORT_CAP = 5_000;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV field: formula-guarded, then quoted when it holds a quote, comma or line break. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_COLUMNS = ['id', 'occurred_at_utc', 'actor', 'actor_id', 'action', 'summary', 'subject', 'item_id', 'item_title', 'payload'] as const;

/** RFC 4180-style CSV (CRLF rows), header first. */
export function auditCsv(entries: readonly AuditRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const entry of entries) {
    const row = [
      entry.id,
      entry.occurred_at,
      auditActor(entry).label,
      entry.actor_id,
      entry.action,
      summarizeAuditEntry(entry),
      auditSubject(entry)?.value ?? '',
      entry.page_id,
      entry.page_title,
      entry.payload,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface AuditExportMeta {
  exportedAt: string;
  filters: AuditFilters;
  capped: boolean;
}

/** JSON export: the entries as the API returned them, each with its summary, under a header saying what was exported. */
export function auditJson(entries: readonly AuditRecord[], meta: AuditExportMeta): string {
  return `${JSON.stringify(
    {
      exported_at: meta.exportedAt,
      filters: Object.fromEntries(activeFilterChips(meta.filters).map((c) => [c.key, c.value])),
      count: entries.length,
      capped: meta.capped,
      cap: AUDIT_EXPORT_CAP,
      entries: entries.map((e) => ({ ...e, summary: summarizeAuditEntry(e) })),
    },
    null,
    2,
  )}\n`;
}

/** `audit-2026-09-14T18-02.csv` - sortable, no characters a filesystem refuses. */
export function exportFilename(format: 'json' | 'csv', at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(':', '-');
  return `audit-${stamp}.${format}`;
}

/**
 * Hand the viewer a file. A Blob URL on a temporary anchor works inside the
 * app (same origin, a user gesture); revoked on the next tick so the browser
 * has started the download before the URL goes away.
 */
export function downloadText(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
