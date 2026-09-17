/**
 * Pure helpers behind the OKF bundle report on Admin → Data: the dry-run result
 * of `POST /okf/validate*` and the 422 `bundle_not_conformant` body of a refused
 * import are the same three-tier report, so one set of functions reads both.
 *
 * Kept free of React so the grouping, the verdict and the copied text are unit
 * tested rather than asserted through a browser.
 */
import type {
  BundleValidationIssue,
  BundleValidationReport,
  BundleValidationSeverity,
} from '@echozedlabs/knowledge-types';

export type BundleTier = 'conformance' | 'policy' | 'advisory';

/** What `POST /okf/validate` and `/okf/validate/archive` return. */
export interface BundleValidateResponse extends BundleValidationReport {
  /** The server's prose verdict (the MCP tool's `summary_line`). */
  summary_line?: string;
  /** Archive dry run only: binary asset files the import would try to restore. */
  assets?: number;
  /**
   * What the import would change (review §4.9), matched as the import matches.
   * Absent for a bundle that would be refused, when the import could not run
   * (two concepts with one identity), and from a server that predates them.
   */
  would_create?: number;
  would_update?: number;
}

/**
 * The gate's own tier names, in the order that matters to an admin, with what
 * each one means for the import. `blocks` is true for conformance alone — the
 * one tier that may refuse a bundle (runbook §3.5).
 */
export const BUNDLE_TIERS: readonly { tier: BundleTier; label: string; blocks: boolean; meaning: string }[] = [
  { tier: 'conformance', label: 'Conformance', blocks: true, meaning: 'critical issues block the import' },
  { tier: 'policy', label: 'Policy', blocks: false, meaning: 'imported anyway; errors are listed in Content health' },
  { tier: 'advisory', label: 'Advisory', blocks: false, meaning: 'never blocks' },
];

/** Past this many rows a tier's table collapses behind "Show all". */
export const REPORT_ROW_LIMIT = 50;

/** One issue, flattened for a table row and a line of copied text. */
export interface ReportRow {
  tier: BundleTier;
  path: string;
  field: string | null;
  code: string;
  severity: BundleValidationSeverity;
  message: string;
}

export interface TierGroup {
  tier: BundleTier;
  label: string;
  blocks: boolean;
  meaning: string;
  rows: ReportRow[];
  /** Distinct files with at least one issue in this tier. */
  fileCount: number;
  /** Issue count per severity, most severe first, zero counts omitted. */
  severities: { severity: BundleValidationSeverity; count: number }[];
}

const SEVERITY_ORDER: readonly BundleValidationSeverity[] = ['critical', 'error', 'warning', 'info'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function issuesOf(value: unknown): BundleValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (i): i is BundleValidationIssue => isRecord(i) && typeof i['path'] === 'string' && typeof i['message'] === 'string',
  );
}

/**
 * Narrow an untyped body (`ApiError.validation`, a JSON response) to a report,
 * or null when it is not one. Lenient about the issue lists — a malformed entry
 * is dropped, not fatal — and strict about the one field every decision reads:
 * `summary.conformant`. A report without a verdict is not a report.
 */
export function asBundleReport(value: unknown): BundleValidateResponse | null {
  if (!isRecord(value) || !isRecord(value['summary'])) return null;
  const summary = value['summary'];
  if (typeof summary['conformant'] !== 'boolean') return null;
  const conformance = issuesOf(value['conformance']);
  const policy = issuesOf(value['policy']);
  const advisory = issuesOf(value['advisory']);
  const count = (key: string, fallback: number) => (typeof summary[key] === 'number' ? (summary[key] as number) : fallback);
  return {
    conformance,
    policy,
    advisory,
    summary: {
      conformant: summary['conformant'],
      meetsPolicy: typeof summary['meetsPolicy'] === 'boolean' ? summary['meetsPolicy'] : true,
      conceptCount: count('conceptCount', 0),
      conformanceCount: count('conformanceCount', conformance.length),
      policyCount: count('policyCount', policy.length),
      advisoryCount: count('advisoryCount', advisory.length),
      criticalCount: count('criticalCount', conformance.filter((i) => i.severity === 'critical').length),
      policyErrorCount: count('policyErrorCount', policy.filter((i) => i.severity === 'error').length),
    },
    ...(typeof value['summary_line'] === 'string' ? { summary_line: value['summary_line'] } : {}),
    ...(typeof value['assets'] === 'number' ? { assets: value['assets'] } : {}),
    ...(typeof value['would_create'] === 'number' ? { would_create: value['would_create'] } : {}),
    ...(typeof value['would_update'] === 'number' ? { would_update: value['would_update'] } : {}),
  };
}

/**
 * The report carried by a refused import, or null for any other failure. Reads
 * `validation` from the error the API client threw (see `ApiError`), so a 422
 * shows its per-file list instead of a one-line message.
 */
export function refusalReport(error: unknown): BundleValidateResponse | null {
  return isRecord(error) ? asBundleReport(error['validation']) : null;
}

function severityRank(severity: string): number {
  const rank = SEVERITY_ORDER.indexOf(severity as BundleValidationSeverity);
  return rank === -1 ? SEVERITY_ORDER.length : rank;
}

/**
 * The report as one group per tier, in `BUNDLE_TIERS` order, every tier present
 * even when empty (the counts line names all three). Rows are ordered most
 * severe first, then by file — so the first page of a long list is the part
 * that blocks — and otherwise keep the server's bundle order.
 */
export function groupReport(report: BundleValidationReport): TierGroup[] {
  return BUNDLE_TIERS.map(({ tier, label, blocks, meaning }) => {
    const rows = report[tier]
      .map((issue, index) => ({ issue, index }))
      .sort(
        (a, b) =>
          severityRank(a.issue.severity) - severityRank(b.issue.severity) ||
          a.issue.path.localeCompare(b.issue.path) ||
          a.index - b.index,
      )
      .map(({ issue }) => ({
        tier,
        path: issue.path,
        field: issue.field ?? null,
        code: issue.code ?? '',
        severity: issue.severity,
        message: issue.message,
      }));
    const severities = SEVERITY_ORDER.map((severity) => ({
      severity,
      count: rows.filter((r) => r.severity === severity).length,
    })).filter((s) => s.count > 0);
    return { tier, label, blocks, meaning, rows, fileCount: new Set(rows.map((r) => r.path)).size, severities };
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 critical issues across 2 files" — the blocking part of a report, in one line. */
export function criticalSummary(report: BundleValidationReport): string {
  const critical = report.conformance.filter((i) => i.severity === 'critical');
  const files = new Set(critical.map((i) => i.path)).size;
  return `${plural(critical.length, 'critical issue')} across ${plural(files, 'file')}`;
}

/** "2 critical · 1 warning", or "none" for an empty tier. */
export function severityLine(group: TierGroup): string {
  if (group.severities.length === 0) return 'none';
  return group.severities.map((s) => `${s.count} ${s.severity}`).join(' · ');
}

export interface ImportReadiness {
  kind: 'blocked' | 'flagged' | 'clean';
  canImport: boolean;
  /** One sentence for the status region and beside the Import button. */
  note: string;
}

/**
 * Whether the Import button may be pressed, and the sentence that says why. Only
 * `summary.conformant` decides; policy and advisory findings enable it with a
 * note, because refusing a valid bundle over a style rule is exactly what the
 * tier split exists to prevent.
 */
export function importReadiness(report: BundleValidationReport): ImportReadiness {
  const s = report.summary;
  const concepts = plural(s.conceptCount, 'concept document');
  if (!s.conformant) {
    return {
      kind: 'blocked',
      canImport: false,
      note: `Not a conformant OKF bundle: ${criticalSummary(report)}. Fix them and choose the bundle again — nothing can be imported until then.`,
    };
  }
  if (!s.meetsPolicy) {
    return {
      kind: 'flagged',
      canImport: true,
      note: `Conformant (${concepts}). ${plural(s.policyErrorCount, 'policy error')} will not block the import; the affected items are listed in Content health afterwards.`,
    };
  }
  const notes = s.conformanceCount + s.policyCount + s.advisoryCount;
  return {
    kind: 'clean',
    canImport: true,
    note:
      notes > 0
        ? `Conformant (${concepts}) with ${plural(notes, 'non-blocking note')}. Ready to import.`
        : `Conformant (${concepts}) and meets policy. Ready to import.`,
  };
}

/** The first `limit` rows unless the admin asked for all of them. */
export function visibleRows<T>(rows: readonly T[], showAll: boolean, limit = REPORT_ROW_LIMIT): readonly T[] {
  return showAll || rows.length <= limit ? rows : rows.slice(0, limit);
}

/**
 * The report as plain text for the clipboard: a heading, the verdict, then one
 * issue per line (`tier | severity | file | field | rule | message`). Pipe
 * separated so it pastes legibly into an issue or a chat and still splits
 * cleanly; every issue is included, not just the rows on screen.
 */
export function reportText(report: BundleValidationReport, heading: string): string {
  const s = report.summary;
  const verdict = !s.conformant
    ? `Not conformant: ${criticalSummary(report)}.`
    : s.meetsPolicy
      ? 'Conformant; meets policy.'
      : `Conformant; ${plural(s.policyErrorCount, 'policy error')}.`;
  const counts = groupReport(report)
    .map((g) => `${g.label}: ${g.rows.length}`)
    .join(', ');
  const lines = groupReport(report).flatMap((g) =>
    g.rows.map((r) => [r.tier, r.severity, r.path, r.field ?? '-', r.code || '-', oneLine(r.message)].join(' | ')),
  );
  return [heading, `${verdict} ${plural(s.conceptCount, 'concept document')}. ${counts}.`, '', ...lines].join('\n') + '\n';
}

/** A message on one line: a copied report is one issue per line, whatever the message holds. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}
