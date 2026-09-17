/**
 * Pure helpers for the "Recent refusals" panel on Admin → Health → Content
 * (plan B2). Free of React and of the network, like `mirrorHealth.ts`, so what
 * an administrator reads about a refused publish can be unit-tested directly.
 *
 * A refusal is an interactive publish the content-model gate turned away
 * (422 `lint_failed`, or a non-admin reaching for `allow_lint_errors`). The
 * server records each one in the audit log as `content.refused`; this panel is
 * a read of that log, through the same admin-only endpoint `/admin/audit` uses.
 */
import type { AuditRecord } from '../audit/queries.js';

/** The audit action the server writes for a refused publish. */
export const REFUSED_ACTION = 'content.refused';

/** How many refusals the panel shows; the full history is one link away. */
export const RECENT_REFUSALS_LIMIT = 10;

export type RefusalSource = 'ui' | 'rest' | 'mcp';

export interface RefusalRule {
  code: string;
  /** The frontmatter key the rule points at, when it names one. */
  path: string | null;
}

/** One audit row, read as a refusal. Every field is defensive: the payload is stored JSON. */
export interface RefusalRow {
  id: number;
  occurredAt: string;
  actor: string;
  source: string;
  sourceLabel: string;
  operation: 'create' | 'publish' | null;
  reason: string;
  /** Linkable only when the item exists — a refused create never produced one. */
  slug: string | null;
  title: string;
  topic: string | null;
  rules: RefusalRule[];
}

/**
 * The door, in the words an administrator uses. `ui` is Compose; the others are
 * the API and an agent. An unknown value is shown verbatim rather than hidden.
 */
export const REFUSAL_SOURCE_LABELS: Record<RefusalSource, string> = {
  ui: 'Compose',
  rest: 'REST API',
  mcp: 'MCP agent',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function rulesOf(value: unknown): RefusalRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const rule = record(entry);
    const code = text(rule['code']);
    return code ? [{ code, path: text(rule['path']) }] : [];
  });
}

export function toRefusalRow(entry: AuditRecord): RefusalRow {
  const payload = record(entry.payload);
  const source = text(payload['source']) ?? 'unknown';
  const operation = payload['operation'];
  return {
    id: entry.id,
    occurredAt: entry.occurred_at,
    // A deleted account keeps its id in the log; system rows have neither.
    actor: entry.actor_username ?? entry.actor_id ?? 'system',
    source,
    sourceLabel: REFUSAL_SOURCE_LABELS[source as RefusalSource] ?? source,
    operation: operation === 'create' || operation === 'publish' ? operation : null,
    reason: text(payload['reason']) ?? 'lint_failed',
    // The join's live slug first: the item may have been renamed since.
    slug: entry.page_slug ?? text(payload['slug']),
    title: entry.page_title ?? text(payload['title']) ?? entry.page_id ?? 'Untitled',
    topic: text(payload['topic']),
    rules: rulesOf(payload['rules']),
  };
}

/**
 * `description.missing, category.missing (categories)` — the rule id is the
 * product's own vocabulary; the field is added only when the id does not
 * already say it.
 */
export function rulesText(rules: RefusalRule[]): string {
  if (rules.length === 0) return '—';
  return rules.map((r) => (r.path && !r.code.startsWith(`${r.path}.`) ? `${r.code} (${r.path})` : r.code)).join(', ');
}

/** What was attempted, for the Item column's secondary line. */
export function refusalAttempt(row: RefusalRow): string {
  const verb = row.operation === 'create' ? 'Create as published' : 'Publish';
  return row.reason === 'lint_override_forbidden' ? `${verb}, override refused (admin only)` : verb;
}
