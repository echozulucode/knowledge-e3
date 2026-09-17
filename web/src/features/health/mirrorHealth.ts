/**
 * Pure helpers for the Git mirror section of Admin → Health → Content
 * (issue 88). Free of React and of the network so the wording an operator
 * reads — "indexed but not yet durable in git" — can be unit-tested directly.
 *
 * The server reports two halves of one symptom: outbox rows still pending past
 * its threshold, and mirror states carrying an error or stuck dirty. A restart
 * replays the pending rows, which is why the failure was never noticed; the
 * page has to say so, or a non-zero count reads as an emergency.
 */

/** What the mirror knows about a stuck row's page. `missing` = no state row at all. */
export type MirrorStateKind = 'missing' | 'error' | 'dirty' | 'clean';

export interface StuckOutboxItem {
  outbox_id: string;
  page_id: string;
  slug: string | null;
  title: string | null;
  kind: 'upsert' | 'delete' | 'move';
  source_id: string | null;
  file_path: string | null;
  created_at: string;
  age_seconds: number;
  error: string | null;
  mirror_state: MirrorStateKind;
  mirror_error: string | null;
  last_commit: string | null;
}

export interface MirrorErrorItem {
  page_id: string;
  slug: string | null;
  title: string | null;
  path: string | null;
  dirty: boolean;
  error: string | null;
  updated_at: string;
  age_seconds: number;
  last_commit: string | null;
}

export interface MirrorHealth {
  stuck_after_ms: number;
  pending: { count: number; items: StuckOutboxItem[] };
  mirror_errors: { count: number; items: MirrorErrorItem[] };
}

export const MIRROR_STATE_LABELS: Record<MirrorStateKind, string> = {
  missing: 'No mirror state',
  error: 'Mirror error',
  dirty: 'Dirty',
  clean: 'Clean',
};

/** Why each mirror state matters, as a title/tooltip on the badge. */
export const MIRROR_STATE_HINTS: Record<MirrorStateKind, string> = {
  missing: 'The mirror never recorded this item at all — the shape reported in issue 88.',
  error: 'The mirror recorded an error for this item.',
  dirty: 'The mirror knows the item changed but has not confirmed the commit.',
  clean: 'The mirror believes this item is committed, yet its outbox row is still pending.',
};

/** Compact age for a table cell: `45s`, `12m`, `3h 5m`, `2d 4h`. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/** The threshold, worded for the page: `5 minutes`, `90 seconds`, `2 hours`. */
export function formatThreshold(ms: number): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** A row's best display name: its title, then its slug, then its page id. */
export function itemLabel(item: { title?: string | null; slug?: string | null; page_id: string }): string {
  return item.title?.trim() || item.slug?.trim() || item.page_id;
}

export interface MirrorAlert {
  tone: 'ok' | 'alert';
  /** One-line status; the alert form names both halves so neither is missed. */
  headline: string;
  /** What it means and what happens next — durability, not data loss. */
  detail: string;
}

/**
 * The operator-facing reading of the report. Non-zero is an operational alert,
 * not a content queue: the content is indexed and readable, it simply is not in
 * git yet, and the next restart replays it.
 */
export function mirrorAlert(mirror: MirrorHealth | undefined): MirrorAlert {
  const bound = formatThreshold(mirror?.stuck_after_ms ?? 0);
  if (!mirror) {
    return { tone: 'ok', headline: 'This server does not report mirror health.', detail: '' };
  }
  const pending = mirror.pending.count;
  const errors = mirror.mirror_errors.count;
  if (pending === 0 && errors === 0) {
    return {
      tone: 'ok',
      headline: 'Every indexed change has reached git.',
      detail: `No outbox row has been waiting longer than ${bound}, and no mirror is reporting an error.`,
    };
  }
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} change${pending === 1 ? '' : 's'} pending for more than ${bound}`);
  if (errors > 0) parts.push(`${errors} mirror${errors === 1 ? '' : 's'} in error or stuck dirty`);
  return {
    tone: 'alert',
    headline: `${parts.join(' · ')}.`,
    detail:
      'This content is indexed and readable, but its commit has not been confirmed — it is not yet durable in git. ' +
      'Restarting the server replays the pending rows, so this usually clears itself; capture the rows below first, ' +
      'because a replay is also what hides the failure.',
  };
}

/* ----------------------------------------------------------------- copying */

/** A cell for a markdown table: never empty, never able to break the row. */
function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers: string[], rows: (string | number | null | undefined)[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

/**
 * The Git mirror section as text to paste into an issue (plan B6).
 *
 * Runbook §3.1 step 1 is "capture the evidence before you fix it", and the
 * instruction it gives is a SQL query against the SQLite file — because the
 * restart that fixes the symptom is also what erases it. Every column that
 * query returns is already on this page, so the button is the query.
 *
 * Markdown tables rather than a log dump: the destination is an issue, and a
 * paste that renders is a paste someone reads.
 */
export function mirrorDiagnosticsText(mirror: MirrorHealth | undefined, now: Date = new Date()): string {
  const alert = mirrorAlert(mirror);
  const lines = [`### Git mirror — ${alert.headline}`, '', `Captured ${now.toISOString()} from Admin → Health → Content.`];
  if (!mirror) return lines.join('\n');
  lines.push(`Stuck threshold: ${formatThreshold(mirror.stuck_after_ms)}.`, '');

  lines.push(`**Indexed, not yet in git — ${mirror.pending.count}** (showing ${mirror.pending.items.length})`, '');
  lines.push(
    ...table(
      ['Item', 'Page', 'Outbox', 'Kind', 'Source', 'File', 'Created', 'Waiting', 'Mirror', 'Last commit', 'Error'],
      mirror.pending.items.map((i) => [
        itemLabel(i),
        i.page_id,
        i.outbox_id,
        i.kind,
        i.source_id,
        i.file_path,
        i.created_at,
        formatAge(i.age_seconds),
        MIRROR_STATE_LABELS[i.mirror_state],
        i.last_commit,
        i.error ?? i.mirror_error,
      ]),
    ),
    '',
  );

  lines.push(`**Mirror errors and mirrors dirty past the threshold — ${mirror.mirror_errors.count}** (showing ${mirror.mirror_errors.items.length})`, '');
  lines.push(
    ...table(
      ['Item', 'Page', 'Path', 'Dirty', 'Since', 'Age', 'Last commit', 'Error'],
      mirror.mirror_errors.items.map((i) => [
        itemLabel(i),
        i.page_id,
        i.path,
        i.dirty ? 'yes' : 'no',
        i.updated_at,
        formatAge(i.age_seconds),
        i.last_commit,
        i.error,
      ]),
    ),
  );
  return lines.join('\n');
}
