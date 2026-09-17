/**
 * "Copy diagnostics" for System health (review §4.9): the whole report as
 * readable plain text, for pasting into an issue, a chat with whoever is on
 * call, or a support thread — places that do not render the page.
 *
 * **No secrets, twice over.** The server already reports secrets as presence
 * only (an env var's NAME and "set" / "NOT SET", never its value — checks.ts
 * `checkSecrets`). But evidence also carries free text the server did not write
 * itself: a source's `last_error` from git, an exception message. Those can
 * quote a remote URL with credentials in it (`https://user:ghp_…@host/repo`),
 * and text on a clipboard travels further than text on an admin-only page. So
 * every line passes through `redactSecrets` on the way out; the page is not
 * changed, the copy is.
 */
import { runbookAddress, type RunbookSection } from './runbook.js';
import {
  STATE_LABELS,
  VERDICT_LABELS,
  countStates,
  orderChecks,
  verdictReason,
  type SystemHealthReport,
} from './systemVerdict.js';

export const REDACTED = '[redacted]';

/**
 * Credential shapes that can ride along in an error message. Deliberately
 * shape-based, not a list of known values: the client never has the values.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // userinfo in a URL: scheme://user:secret@host → scheme://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization header schemes. Not a bare "token <word>": the checks' own
  // prose says "host token", and redacting the word after it would garble it.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // key=value / key: value where the key names a secret
  [/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(\s*[=:]\s*)(?!set\b|NOT SET\b)[^\s,;'"]+/gi, `$1$2${REDACTED}`],
  // Well-known token prefixes: this instance's own PATs, GitHub, GitLab, Slack, AWS.
  [/\be3_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
];

/** `text` with anything credential-shaped replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export interface DiagnosticsOptions {
  /** When the admin copied it — distinct from when the server ran the checks. */
  copiedAt: Date;
  /** Runbook section per check id; omitted checks get no Runbook line. */
  runbookFor?: (checkId: string) => RunbookSection | null;
  /** Where the page was, so a pasted report says which instance it is about. */
  origin?: string;
}

/**
 * The report as text, verdict first and worst first — the page's order, so
 * whoever reads the paste reads it the way the operator did.
 */
export function buildDiagnosticsText(report: SystemHealthReport, options: DiagnosticsOptions): string {
  const checks = orderChecks(report.checks ?? []);
  const counts = countStates(checks);
  const lines: string[] = [
    'System health diagnostics',
    ...(options.origin ? [`Instance: ${options.origin}`] : []),
    `Verdict: ${VERDICT_LABELS[report.verdict] ?? report.verdict}`,
    `Reason: ${verdictReason(report)}`,
    `Checks: ${counts.fail} at risk, ${counts.warn} need attention, ${counts.ok} OK`,
    `Generated: ${report.checked_at}`,
    `Copied: ${options.copiedAt.toISOString()}`,
  ];

  for (const check of checks) {
    lines.push('', `[${STATE_LABELS[check.state] ?? check.state}] ${check.title} (${check.id})`, `  ${check.summary}`);
    if (check.action) lines.push(`  What to do: ${check.action}`);
    if (check.link) lines.push(`  Open: ${check.link.label} (${check.link.href})`);
    const section = options.runbookFor?.(check.id);
    if (section) lines.push(`  Runbook: §${section.number} ${section.title} — ${runbookAddress(section)}`);
    const evidence = check.evidence ?? [];
    if (evidence.length > 0) {
      lines.push('  Evidence:');
      for (const line of evidence) lines.push(`    - ${line}`);
    }
  }

  return redactSecrets(lines.join('\n')) + '\n';
}
