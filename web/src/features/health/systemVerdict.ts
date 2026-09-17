/**
 * System health presentation (plan §5) — the wording and tone decisions for
 * Admin → Health → System, kept React-free and network-free so they can be unit
 * tested. `SystemHealth.tsx` renders; this module decides what it says.
 *
 * The page's whole claim is that an administrator can answer "is this instance
 * healthy?" WITHOUT reading rows and forming their own opinion. That claim lives
 * here: the verdict headline, the one-line reason under it, and the ordering
 * that puts the rows that caused the verdict first.
 */

export type CheckState = 'ok' | 'warn' | 'fail';
export type SystemVerdict = 'healthy' | 'degraded' | 'at_risk';

export interface CheckLink {
  label: string;
  href: string;
}

export interface SystemCheck {
  id: string;
  title: string;
  state: CheckState;
  summary: string;
  action: string | null;
  link: CheckLink | null;
  /** Supporting lines. A server that predates a field may omit it entirely. */
  evidence?: string[];
}

export interface SystemHealthReport {
  verdict: SystemVerdict;
  checked_at: string;
  checks: SystemCheck[];
}

export const VERDICT_LABELS: Record<SystemVerdict, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  at_risk: 'At risk',
};

export const STATE_LABELS: Record<CheckState, string> = {
  ok: 'OK',
  warn: 'Needs attention',
  fail: 'At risk',
};

/** Tone token the CSS keys off. Three values, matching the three states. */
export const STATE_TONE: Record<CheckState, 'ok' | 'warn' | 'alert'> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'alert',
};

export const VERDICT_TONE: Record<SystemVerdict, 'ok' | 'warn' | 'alert'> = {
  healthy: 'ok',
  degraded: 'warn',
  at_risk: 'alert',
};

/**
 * The sentence under the verdict. It names the checks responsible rather than
 * restating the verdict, because "At risk" on its own is the thing that sends an
 * operator back to reading rows.
 */
export function verdictReason(report: Pick<SystemHealthReport, 'verdict' | 'checks'>): string {
  const checks = report.checks ?? [];
  const failed = checks.filter((c) => c.state === 'fail');
  const warned = checks.filter((c) => c.state === 'warn');
  if (failed.length > 0) {
    return `${namesOf(failed)} ${failed.length === 1 ? 'needs' : 'need'} attention now.`;
  }
  if (warned.length > 0) {
    return `${namesOf(warned)} ${warned.length === 1 ? 'is' : 'are'} working but not fully.`;
  }
  return `All ${checks.length} checks passed.`;
}

/** "Database", "Database and Sources", "Database, Sources and 2 more". */
function namesOf(checks: readonly SystemCheck[]): string {
  const titles = checks.map((c) => c.title);
  if (titles.length === 1) return titles[0]!;
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

/**
 * Rows in the order an operator should read them: everything that is not ok
 * first (worst first), each group keeping the server's own order so the report
 * does not reshuffle itself between refreshes.
 */
export function orderChecks(checks: readonly SystemCheck[]): SystemCheck[] {
  const rank: Record<CheckState, number> = { fail: 0, warn: 1, ok: 2 };
  return [...checks].sort((a, b) => rank[a.state] - rank[b.state]);
}

export interface VerdictCounts {
  ok: number;
  warn: number;
  fail: number;
}

export function countStates(checks: readonly SystemCheck[]): VerdictCounts {
  return {
    ok: checks.filter((c) => c.state === 'ok').length,
    warn: checks.filter((c) => c.state === 'warn').length,
    fail: checks.filter((c) => c.state === 'fail').length,
  };
}

/** "12 Sep 2026, 07:58" — or the raw string if the server sent something unparseable. */
export function formatCheckedAt(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * What the verdict's live region should announce after a report lands (review
 * §4.9: verdict `aria-live`). Only a CHANGE is news: the first load is read with
 * the page, and a 30 s auto-refresh that confirms "At risk" again must not
 * interrupt a screen-reader user every half minute.
 */
export function verdictAnnouncement(previous: SystemVerdict | null | undefined, next: SystemVerdict | null | undefined): string | null {
  if (!previous || !next || previous === next) return null;
  return `System health changed from ${VERDICT_LABELS[previous]} to ${VERDICT_LABELS[next]}.`;
}
