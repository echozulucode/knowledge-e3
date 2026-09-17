/**
 * Admin → Health → System (plan §5): "is this instance healthy right now?"
 *
 * The deliberate contrast with Content health. `ContentHealthService` answers
 * "what in the library needs fixing" and answers it by rendering the whole
 * library to OKF and auditing it. This answers "can this instance serve, sync
 * and be recovered", from cheap process- and database-level probes, and the two
 * must not share a code path: they have different costs, different refresh
 * rates, and different readers-in-a-hurry.
 *
 * Everything here is derived on request; nothing is stored.
 */

/**
 * One check's own verdict.
 *
 *  - `ok`   — the check passed; nothing to do.
 *  - `warn` — working, but not fully or not for long. Rolls up to `degraded`.
 *  - `fail` — broken, or unverified in a way that puts data or service at risk.
 *             Rolls up to `at_risk`.
 *
 * There is no `unknown`/`info` state on purpose. A row with no verdict is a row
 * an operator learns to skim, and §5's whole complaint about the six numbers at
 * the top of Content health is that none of them has a threshold attached.
 */
export type CheckState = 'ok' | 'warn' | 'fail';

/** Stable ids; the web page keys its copy and its ordering off these. */
export const SYSTEM_CHECK_IDS = [
  'database',
  'schema',
  'content_root',
  'disk',
  'sources',
  'secrets',
  'git_outbox',
  'mirror_state',
  'conflicts',
  'restore_drill',
] as const;
export type SystemCheckId = (typeof SYSTEM_CHECK_IDS)[number];

/** Where to go next, inside the app. Shell commands belong in `action`. */
export interface CheckLink {
  label: string;
  href: string;
}

export interface SystemCheck {
  id: SystemCheckId;
  /** Short human name for the row. */
  title: string;
  state: CheckState;
  /** One line saying what is true right now. Never a secret VALUE. */
  summary: string;
  /** What to do about it, or null when there is nothing to do. */
  action: string | null;
  link: CheckLink | null;
  /** Supporting lines — counts, names, paths. Admin-only; may be empty. */
  evidence: string[];
}

/**
 * The single verdict at the top of the page. `at_risk` deliberately outranks
 * `degraded`: an instance that has never rehearsed a restore is serving
 * perfectly and is still the one you want to hear about first.
 */
export type SystemVerdict = 'healthy' | 'degraded' | 'at_risk';

export interface SystemHealthReport {
  verdict: SystemVerdict;
  /** ISO timestamp the report was computed. */
  checked_at: string;
  checks: SystemCheck[];
}

/** Worst-wins: any `fail` ⇒ at risk, else any `warn` ⇒ degraded, else healthy. */
export function verdictOf(checks: readonly SystemCheck[]): SystemVerdict {
  if (checks.some((c) => c.state === 'fail')) return 'at_risk';
  if (checks.some((c) => c.state === 'warn')) return 'degraded';
  return 'healthy';
}

/** The worse of two states, for rolling a per-item loop into one row. */
export function worse(a: CheckState, b: CheckState): CheckState {
  const rank = { ok: 0, warn: 1, fail: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}
