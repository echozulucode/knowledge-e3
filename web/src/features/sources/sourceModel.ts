/**
 * Pure helpers behind Admin → Sources (plan §7.4 / §8.1 / §8.2).
 *
 * Everything here is free of React and of the network so the table chips, the
 * form's validation, and the mode explanations can be unit-tested directly.
 */
import { RUNBOOK, runbookHint } from '../health/runbook.js';
import type {
  ConflictRow,
  DefaultStatus,
  HostKind,
  SourceHead,
  SourceRole,
  SourceRow,
  SourceStatusView,
  SourceUpsertInput,
  SyncMode,
  SyncStatus,
} from './types.js';

/** The three sync policies, worded from plan §8.2. */
export interface ModeOption {
  value: SyncMode;
  label: string;
  /** Local commits · Push · Inbound · Who publishes, from the §8.2 table. */
  explanation: string;
  /** The "Fits" column. */
  fits: string;
}

export const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'direct',
    label: 'Direct',
    explanation:
      'Local commits are debounced, per author, to the branch, and pushed after each commit batch. ' +
      'Inbound arrives by fetch + merge on schedule or webhook. Anyone with edit rights publishes, including permitted agents.',
    fits: 'Solo, small team, backup remote',
  },
  {
    value: 'review',
    label: 'Review',
    explanation:
      'The first change to an item commits to a per-item branch e3/<item-slug>-<shortid> and the item shows "In review". ' +
      'The branch is pushed and a PR/MR is opened with the item title, diff summary, and lint report; the PR link is stored on the item. ' +
      'Merges to the branch arrive by fetch, the item flips to Published, and its branch is deleted. ' +
      "The upstream reviewers publish; approval in-app is a convenience that calls the host's merge API.",
    fits: 'Teams whose repository requires PRs',
  },
  {
    value: 'read-only',
    label: 'Read-only',
    explanation: 'No local commits and no push. Inbound is a fetch on schedule. Nobody publishes here.',
    fits: "Reference bundles, other teams' docs",
  },
];

export interface RoleOption {
  value: SourceRole;
  label: string;
  explanation: string;
}

export const ROLE_OPTIONS: RoleOption[] = [
  { value: 'authoritative', label: 'Authoritative', explanation: 'This instance owns the content — edit it here.' },
  { value: 'reference', label: 'Reference', explanation: "Someone else's bundle; indexed here, edited upstream." },
];

export const HOST_OPTIONS: { value: HostKind; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'bitbucket-dc', label: 'Bitbucket Data Center' },
];

/**
 * Does this mode *require* a change-request host? Only `review` — the one mode
 * that opens PRs, and the one the server refuses to save without `host_kind`.
 *
 * It no longer decides whether the host FIELDS are shown or sent: since issue
 * 122 the same `host_token_env` is the credential git transport authenticates
 * with, so a `direct` or `read-only` source on a private repository needs it
 * too.
 */
export function needsHost(mode: SyncMode): boolean {
  return mode === 'review';
}

// ---------------------------------------------------------------- state chip

export type StateTone = 'ok' | 'busy' | 'pending' | 'conflict' | 'error';

export interface StateChip {
  label: string;
  tone: StateTone;
  /** Longer text for the chip's `title` — the error, or the conflicted paths. */
  detail?: string;
}

const BUSY_LABELS: Record<string, string> = {
  fetching: 'Fetching',
  merging: 'Merging',
  indexing: 'Indexing',
  committing: 'Committing',
  pushing: 'Pushing',
};

/** The live state chip for one row: conflict and error win, then drift, then transient work. */
export function describeSyncState(status: SyncStatus | undefined | null): StateChip {
  if (!status) return { label: 'Unknown', tone: 'pending' };
  const conflicted = status.conflicted_paths ?? [];
  if (status.state === 'conflict' || conflicted.length > 0) {
    return {
      label: conflicted.length ? `Conflict (${conflicted.length})` : 'Conflict',
      tone: 'conflict',
      ...(conflicted.length ? { detail: conflicted.join(', ') } : {}),
    };
  }
  if (status.state === 'error') {
    return { label: 'Error', tone: 'error', ...(status.last_error ? { detail: status.last_error } : {}) };
  }
  const busy = BUSY_LABELS[status.state];
  if (busy) return { label: busy, tone: 'busy' };
  const drift = describeDrift(status);
  if (drift) return { label: drift, tone: 'pending' };
  if (status.last_error) return { label: 'Last run failed', tone: 'error', detail: status.last_error };
  return { label: 'In sync', tone: 'ok' };
}

/** `Ahead 2 · Behind 1`, or an empty string when the working tree matches the remote. */
export function describeDrift(status: Pick<SyncStatus, 'ahead' | 'behind'>): string {
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`Ahead ${status.ahead}`);
  if (status.behind > 0) parts.push(`Behind ${status.behind}`);
  return parts.join(' · ');
}

/** "Never", or a locale timestamp for the row's last successful cycle. */
export function formatSyncedAt(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** The host column: `GitHub` / `Bitbucket Data Center` (with its base URL), or an em dash. */
export function describeHost(row: Pick<SourceRow, 'host_kind' | 'host_base_url'>): string {
  if (!row.host_kind) return '—';
  const label = HOST_OPTIONS.find((h) => h.value === row.host_kind)?.label ?? row.host_kind;
  return row.host_base_url ? `${label} · ${row.host_base_url}` : label;
}

/**
 * The `title` for a state chip: what it is, and where the runbook answers it
 * (plan B5). Conflict and error are the two states §3.2 is written for.
 */
export function stateChipTitle(chip: StateChip): string | undefined {
  if (chip.tone !== 'conflict' && chip.tone !== 'error') return chip.detail;
  return runbookHint(RUNBOOK.sourceConflict, chip.detail);
}

// ------------------------------------------------------------- secret chips

/**
 * One env-named secret a source depends on, and whether the server has it
 * (plan B3 / D4a). The NAME is the useful half and the only half that exists
 * here: presence arrives as a boolean and there is nothing else to render.
 */
export interface SecretChip {
  kind: 'host-token' | 'webhook-secret';
  /** The environment variable's name, as the registry stores it. */
  env: string;
  label: string;
  tone: 'ok' | 'error';
  title: string;
}

/**
 * The secret chips for one row, in the order the Host column shows them.
 *
 * A row is described only when the server actually reported presence: a server
 * that predates the flags omits them, and reading "absent" as "not set" would
 * put a red chip on a perfectly configured source.
 */
export function describeSecrets(row: SourceStatusView): SecretChip[] {
  const chips: SecretChip[] = [];
  const add = (kind: SecretChip['kind'], env: string | null, present: boolean | undefined, missing: string) => {
    if (!env || present === undefined) return;
    chips.push(
      present
        ? {
            kind,
            env,
            label: `${env} ✓`,
            tone: 'ok',
            title: `${env} is set in this server's environment. Presence only — the value never leaves the server.`,
          }
        : { kind, env, label: `${env} ✗ not set on this server`, tone: 'error', title: missing },
    );
  };
  add(
    'host-token',
    row.host_token_env,
    row.host_token_present,
    runbookHint(
      RUNBOOK.reviewHostUnconfigured,
      `${row.host_token_env} is not set in this server's environment, so this source cannot authenticate to its repository ` +
        '(clone, fetch, push) and no change request can be opened for it.',
    ),
  );
  // No runbook section covers a missing webhook secret, and pointing at the
  // nearest one would be worse than pointing at nothing (plan B5).
  add(
    'webhook-secret',
    row.webhook_secret_env,
    row.webhook_secret_present,
    `${row.webhook_secret_env} is not set in this server's environment, so this source's webhook is refused (404). ` +
      'Set it where the process gets its environment, then restart.',
  );
  return chips;
}

// --------------------------------------------------------------- selection

/**
 * A stored glob column as a list (plan A1). The row ships the column as it is
 * stored — JSON text — and a future server may ship the list itself, so both
 * are accepted. Tolerant like the server's `globList`: text that is not a JSON
 * array of strings reads as "no globs", which is what the server does with it.
 */
export function globsOf(value: string | readonly string[] | null | undefined): string[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim());
}

/** What the server indexes from a source with no include globs (inbound-index.service.ts). */
export const DEFAULT_SELECTION_LABEL = 'The OKF layout: concepts/*.md at any depth';

export interface SelectionSummary {
  include: string[];
  exclude: string[];
  /** True when either list narrows or replaces the default layout — the table chip's condition. */
  selective: boolean;
  /** The chip's `title`: every glob, so the row answers "which files" without opening Details. */
  title: string;
}

export function describeSelection(row: Pick<SourceRow, 'include_globs' | 'exclude_globs'>): SelectionSummary {
  const include = globsOf(row.include_globs);
  const exclude = globsOf(row.exclude_globs);
  const lines = [`Indexes: ${include.length ? include.join(', ') : DEFAULT_SELECTION_LABEL}`];
  if (exclude.length) lines.push(`Excludes: ${exclude.join(', ')}`);
  return { include, exclude, selective: include.length > 0 || exclude.length > 0, title: lines.join('\n') };
}

/** `a1b2c3d` — the length `git log --oneline` prints. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * The Details panel's HEAD line. `undefined` is a server that does not report
 * HEAD at all; `null` is one that looked and found nothing to report — which is
 * worth saying differently, because only the second is a fact about the source.
 */
export function describeHead(head: SourceHead | null | undefined): string {
  if (head === undefined) return 'Not reported by this server';
  if (head === null) return 'No commit to report — no clone yet, nothing committed, or git did not answer in time';
  return head.committed_at ? `${shortSha(head.sha)} · ${formatSyncedAt(head.committed_at)}` : shortSha(head.sha);
}

/** `12 items`, `1 item`, or a dash when the server did not count. */
export function describeItemCount(count: number | undefined): string {
  if (count === undefined) return '—';
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** One glob per line, trimmed, blanks dropped — the textarea's reading. */
export function parseGlobLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Why a glob would be refused, or null. Mirrors the server's rule
 * (`encodeGlobs`): a glob is repository-relative, so no leading `/` or `\`,
 * no drive letter, and no `..` segment. Checked here so the admin reads it
 * beside the field, not as a toast after the round trip.
 */
export function globProblem(glob: string): string | null {
  const g = glob.trim();
  if (!g) return 'A glob cannot be blank.';
  if (/^[\\/]/.test(g) || /^[a-zA-Z]:/.test(g)) return `"${g}" is an absolute path; globs are relative to the repository root.`;
  if (g.split(/[\\/]/).includes('..')) return `"${g}" climbs out of the repository with "..".`;
  return null;
}

/** The first problem in a textarea's globs, or undefined. */
function globListProblem(text: string): string | undefined {
  for (const glob of parseGlobLines(text)) {
    const problem = globProblem(glob);
    if (problem) return problem;
  }
  return undefined;
}

// -------------------------------------------------------------------- form

/** Every registry column, as strings the form binds to. */
export interface SourceForm {
  id: string;
  local_dir: string;
  remote_url: string;
  branch: string;
  role: SourceRole;
  mode: SyncMode;
  branch_prefix: string;
  host_kind: '' | HostKind;
  host_base_url: string;
  host_token_env: string;
  sync_every_seconds: string;
  webhook_secret_env: string;
  default_status: '' | DefaultStatus;
  /** One glob per line (plan A1); blank = the default layout. */
  include_globs: string;
  exclude_globs: string;
  /** A content-type label from the registry; '' = no default. */
  default_type: string;
  enabled: boolean;
}

export function emptySourceForm(): SourceForm {
  return {
    id: '',
    local_dir: '',
    remote_url: '',
    branch: '',
    role: 'authoritative',
    mode: 'direct',
    branch_prefix: 'e3/',
    host_kind: '',
    host_base_url: '',
    host_token_env: '',
    sync_every_seconds: '',
    webhook_secret_env: '',
    default_status: '',
    include_globs: '',
    exclude_globs: '',
    default_type: '',
    enabled: true,
  };
}

export function formFromSource(row: SourceRow): SourceForm {
  return {
    id: row.id,
    local_dir: row.local_dir ?? '',
    remote_url: row.remote_url ?? '',
    branch: row.branch ?? '',
    role: row.role,
    mode: row.mode,
    branch_prefix: row.branch_prefix ?? '',
    host_kind: row.host_kind ?? '',
    host_base_url: row.host_base_url ?? '',
    host_token_env: row.host_token_env ?? '',
    sync_every_seconds: row.sync_every_seconds == null ? '' : String(row.sync_every_seconds),
    webhook_secret_env: row.webhook_secret_env ?? '',
    default_status: row.default_status ?? '',
    include_globs: globsOf(row.include_globs).join('\n'),
    exclude_globs: globsOf(row.exclude_globs).join('\n'),
    default_type: row.default_type ?? '',
    enabled: Number(row.enabled) === 1,
  };
}

/** `main`, or `topic:<slug>` — the ids the server accepts. */
export function isValidSourceId(id: string): boolean {
  return id === 'main' || /^topic:[a-z0-9][a-z0-9-]*$/.test(id);
}

/** The default working-tree dir the server would pick for an id; shown as the placeholder. */
export function defaultLocalDir(id: string): string {
  if (!id) return 'main';
  return id === 'main' ? 'main' : `topics/${id.slice('topic:'.length)}`;
}

/** Field-keyed validation messages; an empty object means the form may be submitted. */
export function validateSourceForm(form: SourceForm): Partial<Record<keyof SourceForm, string>> {
  const errors: Partial<Record<keyof SourceForm, string>> = {};
  const id = form.id.trim();
  if (!id) errors.id = 'An id is required.';
  else if (!isValidSourceId(id)) errors.id = 'Use `main` or `topic:<slug>` (lowercase, hyphens).';
  const remote = form.remote_url.trim();
  if (remote && remote.startsWith('-')) errors.remote_url = 'That is not a valid remote URL.';
  if (needsHost(form.mode) && !form.host_kind) errors.host_kind = 'Review mode needs a change-request host.';
  const every = form.sync_every_seconds.trim();
  if (every) {
    const seconds = Number(every);
    if (!Number.isInteger(seconds)) errors.sync_every_seconds = 'Whole seconds, please.';
    else if (seconds < 5) errors.sync_every_seconds = 'At least 5 seconds.';
  }
  const include = globListProblem(form.include_globs);
  if (include) errors.include_globs = include;
  const exclude = globListProblem(form.exclude_globs);
  if (exclude) errors.exclude_globs = exclude;
  return errors;
}

/**
 * The `PUT /admin/sources/:id` body. Every column is sent so clearing a field
 * clears it upstream, and blanks become `null`.
 *
 * The host fields are sent for **every** mode (issue 122). They used to be
 * dropped for anything but `review`, which silently discarded the credential a
 * `direct` source on a private repository had just been given — the row saved,
 * the field came back empty, and the sync kept failing to authenticate.
 */
export function formToUpsert(form: SourceForm): SourceUpsertInput {
  const every = form.sync_every_seconds.trim();
  return {
    local_dir: form.local_dir.trim() || defaultLocalDir(form.id.trim()),
    remote_url: form.remote_url.trim() || null,
    branch: form.branch.trim() || null,
    role: form.role,
    mode: form.mode,
    branch_prefix: form.branch_prefix.trim() || null,
    host_kind: form.host_kind || null,
    host_base_url: form.host_base_url.trim() || null,
    host_token_env: form.host_token_env.trim() || null,
    sync_every_seconds: every ? Number(every) : null,
    webhook_secret_env: form.webhook_secret_env.trim() || null,
    default_status: form.default_status || null,
    // Sent as lists even when empty: `[]` is how a cleared textarea clears the
    // column (and restores the default layout) — omitting it would keep the old globs.
    include_globs: parseGlobLines(form.include_globs),
    exclude_globs: parseGlobLines(form.exclude_globs),
    default_type: form.default_type.trim() || null,
    enabled: form.enabled,
  };
}

// --------------------------------------------------------------- conflicts

/** Open conflicts first (oldest first), resolved ones behind them (newest first). */
export function splitConflicts(rows: ConflictRow[]): { open: ConflictRow[]; resolved: ConflictRow[] } {
  const open = rows.filter((c) => !c.resolved_at).sort((a, b) => a.detected_at.localeCompare(b.detected_at));
  const resolved = rows
    .filter((c) => c.resolved_at)
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)));
  return { open, resolved };
}

/** How a resolved conflict reads in the history list. */
export function describeResolution(row: ConflictRow): string {
  if (!row.resolved_at) return 'Open';
  if (row.resolution === 'ours') return 'Kept mine';
  if (row.resolution === 'theirs') return 'Kept theirs';
  if (row.resolution === 'manual') return 'Merged by hand';
  return 'Resolved';
}
