/**
 * The `lint_failed_inbound` row's diagnostics, as the Content health table
 * renders them (plan B4). Pure and React-free so the wording is unit-tested.
 *
 * Runbook §3.5(b) used to end in a SQL query because the queue named the item
 * and nothing else. The server now ships the `sync_diagnostics` row that put
 * the item there; this module turns it into the three things an operator acts
 * on — which door it came through, which file, and which keys to fix.
 */
import type { HealthQueueItem, InboundLint } from './queries.js';

/**
 * The `source_id` the OKF import door writes for a bundle (server
 * `okf-import.service.ts`). A bundle has no registered source, so the door
 * records its own constant; it is a wire value, and the only one that is not a
 * registry id.
 */
export const OKF_IMPORT_SOURCE_ID = 'okf-import';

/** "OKF import", or "Sync from topic:handbook" — the door, in words. */
export function inboundDoorLabel(sourceId: string): string {
  return sourceId === OKF_IMPORT_SOURCE_ID ? 'OKF import' : `Sync from ${sourceId}`;
}

export interface LintDiagnosticLine {
  code: string;
  severity: string;
  message: string;
  /** The frontmatter key the rule points at, when the lint named one. */
  key: string | null;
}

export interface LintDetail {
  door: string;
  sourceId: string;
  path: string;
  lines: LintDiagnosticLine[];
  /** How many diagnostics the server left off this row; 0 when it sent them all. */
  more: number;
}

/**
 * The row's detail, or null when there is none to show (another queue, or a
 * server that predates B4). Defensive about the payload's inner shape for the
 * same reason the refusal rows are: it is stored JSON, read back.
 */
export function lintDetailOf(item: Pick<HealthQueueItem, 'lint'>): LintDetail | null {
  const lint: InboundLint | undefined = item.lint;
  if (!lint || typeof lint.path !== 'string' || typeof lint.source_id !== 'string') return null;
  const diagnostics = Array.isArray(lint.diagnostics) ? lint.diagnostics : [];
  const lines = diagnostics
    .filter((d) => d && typeof d.code === 'string' && d.code)
    .map((d) => ({
      code: d.code,
      severity: typeof d.severity === 'string' ? d.severity : 'error',
      message: typeof d.message === 'string' ? d.message : '',
      key: typeof d.path === 'string' && d.path ? d.path : null,
    }));
  const total = Number.isFinite(lint.diagnostics_total) ? lint.diagnostics_total : lines.length;
  return {
    door: inboundDoorLabel(lint.source_id),
    sourceId: lint.source_id,
    path: lint.path,
    lines,
    more: Math.max(0, total - lines.length),
  };
}

/** `+3 more`, or an empty string. */
export function moreDiagnosticsText(more: number): string {
  return more > 0 ? `+${more} more` : '';
}
