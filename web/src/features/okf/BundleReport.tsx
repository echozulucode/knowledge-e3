/**
 * The three-tier OKF bundle report on Admin → Data — shown for a validation
 * (before anything is written) and for a refused import (the 422 body).
 *
 * Same markup as the Health-audit panel's `<details>` lists on purpose: one way
 * of reading "issues in tiers" on the page. The difference is the table — an
 * admin fixing a bundle needs the file, the field and the rule side by side, and
 * a bullet list of prose sentences was not that.
 */
import { useId, useState } from 'react';
import type { BundleValidationReport } from '@echozedlabs/knowledge-types';
import {
  REPORT_ROW_LIMIT,
  criticalSummary,
  groupReport,
  reportText,
  severityLine,
  visibleRows,
  type TierGroup,
} from './bundleReportModel.js';

interface BundleReportProps {
  report: BundleValidationReport;
  /** "Validation" or "Import refused" — first words of the summary line and the copied text. */
  title: string;
  /** What was checked (a file name, a folder), for the summary and the copied text. */
  subject: string;
  /** Test/landmark hook: `validation` or `refusal`. */
  kind: 'validation' | 'refusal';
}

export function BundleReport({ report, title, subject, kind }: BundleReportProps) {
  const groups = groupReport(report);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const s = report.summary;
  const headline = s.conformant
    ? `${s.conceptCount} concept document${s.conceptCount === 1 ? '' : 's'}, conformant`
    : criticalSummary(report);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(reportText(report, `${title}: ${subject}`));
      setCopyNote('Copied the report — one issue per line.');
    } catch {
      // No clipboard permission, an insecure context, or no clipboard API at all.
      setCopyNote('Copy failed. Check the browser clipboard permission and try again.');
    }
  }

  return (
    <section className="OkfAdmin__audit OkfAdmin__report" data-report={kind} aria-label={`${title} report`}>
      <p className="OkfAdmin__reportSummary">
        <strong>{title}</strong> — <code>{subject}</code>: {headline}.
      </p>
      <ul className="OkfAdmin__reportStats">
        {groups.map((g) => (
          <li key={g.tier} data-tier={g.tier}>
            <strong>{g.label}</strong>: {g.rows.length} — {severityLine(g)}
            <span className="OkfAdmin__muted"> ({g.meaning})</span>
          </li>
        ))}
      </ul>
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <TierIssues key={g.tier} group={g} />
        ))}
      {groups.some((g) => g.rows.length > 0) ? (
        <p className="OkfAdmin__actions OkfAdmin__reportActions">
          <button type="button" onClick={() => void copy()}>
            Copy report
          </button>
          <span role="status" className="OkfAdmin__copyNote">
            {copyNote}
          </span>
        </p>
      ) : null}
    </section>
  );
}

function TierIssues({ group }: { group: TierGroup }) {
  const [showAll, setShowAll] = useState(false);
  const rows = visibleRows(group.rows, showAll);
  const hidden = group.rows.length - rows.length;
  // Unique per report: a validation and a refusal can be on the page in turn.
  const tableId = `okf-report-${group.tier}-${useId()}`;
  return (
    // Conformance opens by default: it is the tier that decides the import.
    <details open={group.blocks} data-tier={group.tier}>
      <summary>
        {group.label} issues ({group.rows.length} across {group.fileCount} file{group.fileCount === 1 ? '' : 's'})
        {group.blocks ? ' — must fix' : ''}
      </summary>
      <table className="OkfAdmin__table OkfAdmin__issueTable" id={tableId}>
        <caption className="OkfAdmin__srOnly">
          {group.label} issues: file, field, rule, severity and message
        </caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Field</th>
            <th scope="col">Rule</th>
            <th scope="col">Severity</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={`${r.path}-${r.code}-${n}`} data-severity={r.severity}>
              <td>
                <code>{r.path}</code>
              </td>
              <td>{r.field ? <code>{r.field}</code> : <span className="OkfAdmin__muted">—</span>}</td>
              <td>{r.code ? <code>{r.code}</code> : <span className="OkfAdmin__muted">—</span>}</td>
              <td>{r.severity}</td>
              <td>{r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {group.rows.length > REPORT_ROW_LIMIT ? (
        <button type="button" aria-controls={tableId} aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show first ${REPORT_ROW_LIMIT}` : `Show all ${group.rows.length} (${hidden} more)`}
        </button>
      ) : null}
    </details>
  );
}
