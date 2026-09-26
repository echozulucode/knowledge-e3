/**
 * Pure helpers behind the Sources list, its detail sheet and its editor sheet
 * (the admin UX review §4.4).
 *
 * `sourceModel.ts` describes ONE source (its chip, its secrets, its form); this
 * file is about the page around them: what needs attention, which rows a filter
 * keeps, how often to poll, and what the address bar says. No React, no network
 * — every rule here is unit-tested directly.
 */
import { RUNBOOK, type RunbookSection } from '../health/runbook.js';
import type { StatusTone } from '../../components/admin/StatusChip.js';
import {
  MODE_OPTIONS,
  ROLE_OPTIONS,
  describeDrift,
  describeSecrets,
  describeSyncState,
  needsHost,
  parseGlobLines,
  type SourceForm,
  type StateChip,
} from './sourceModel.js';
import type { SourceRole, SourceStatusView, SyncMode } from './types.js';

// ------------------------------------------------------------------ state

/**
 * The shared StatusChip vocabulary for a row's state chip. A conflict is `warn`,
 * not `error`: nothing is broken, the source is waiting on a decision (the
 * wireframe's ▲). Transient work and drift are both "waiting" — `pending`.
 */
export function stateTone(chip: StateChip): StatusTone {
  switch (chip.tone) {
    case 'ok':
      return 'ok';
    case 'conflict':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

/**
 * The chip for a whole row. `describeSyncState` reads the engine's live status;
 * the registry row also keeps the last cycle's error (`last_error`), which
 * outlives an engine restart. A row that is otherwise in sync but recorded a
 * failure says so, rather than showing a green chip over a stored error.
 */
export function sourceStateChip(source: Pick<SourceStatusView, 'status' | 'last_error'>): StateChip {
  const chip = describeSyncState(source.status);
  if (chip.tone === 'ok' && source.last_error) return { label: 'Last run failed', tone: 'error', detail: source.last_error };
  return chip;
}

const BUSY_STATES = new Set(['fetching', 'merging', 'indexing', 'committing', 'pushing']);

/** A cycle is running right now on the server. */
export function isBusy(source: Pick<SourceStatusView, 'status'>): boolean {
  return BUSY_STATES.has(source.status?.state ?? '');
}

export function isEnabled(source: Pick<SourceStatusView, 'enabled'>): boolean {
  return Number(source.enabled) === 1;
}

/** Open conflicts on one source; a `conflict` state that listed no paths still counts as one (as the nav badge does). */
export function openConflictCount(source: Pick<SourceStatusView, 'status'>): number {
  const paths = source.status?.conflicted_paths?.length ?? 0;
  if (paths > 0) return paths;
  return source.status?.state === 'conflict' ? 1 : 0;
}

/** Sort rank for the State column: what needs a person first. */
export function stateRank(source: Pick<SourceStatusView, 'status' | 'last_error'>): number {
  const tone = sourceStateChip(source).tone;
  return { conflict: 0, error: 1, busy: 2, pending: 3, ok: 4 }[tone];
}

// -------------------------------------------------------------- attention

export type SheetTabId = 'overview' | 'conflicts' | 'reviews' | 'selection';

export type AttentionReason = 'conflict' | 'host-token' | 'webhook-secret' | 'last-run-failed';

export interface AttentionItem {
  sourceId: string;
  reason: AttentionReason;
  /** Short text after the id: "Conflict (3)", "GITHUB_TOKEN ✗". Env var NAMES only, never values. */
  label: string;
  /** The detail-sheet tab that answers it. */
  tab: SheetTabId;
}

/**
 * What the attention strip lists, computed from the list response alone — no
 * extra request. One entry per source per reason, in list order:
 *
 *   - open conflicts → the Conflicts tab;
 *   - a source whose host token env var is not set on the server, when that
 *     token is one it would actually use (issue 122): any source with an https
 *     remote — which cannot clone, fetch or push without it — and any review
 *     source, which cannot open a change request without it. A local-only or
 *     ssh source that names a token it never uses is still not blocked. The
 *     webhook secret stays review-only, and a server that did not report
 *     presence (`undefined`) is not "missing";
 *   - a last run that failed (or an error state) → Overview, with the error.
 *
 * Disabled sources are skipped: nothing runs for them, so nothing is blocked.
 */
export function attentionItems(sources: readonly SourceStatusView[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const source of sources) {
    if (!isEnabled(source)) continue;
    const conflicts = openConflictCount(source);
    if (conflicts > 0) {
      items.push({ sourceId: source.id, reason: 'conflict', label: `Conflict (${conflicts})`, tab: 'conflicts' });
    }
    for (const secret of describeSecrets(source)) {
      if (secret.tone !== 'error') continue;
      const used = secret.kind === 'host-token' ? usesHostToken(source) : needsHost(source.mode);
      if (!used) continue;
      items.push({ sourceId: source.id, reason: secret.kind, label: `${secret.env} ✗`, tab: 'overview' });
    }
    const chip = sourceStateChip(source);
    if (conflicts === 0 && chip.tone === 'error') {
      items.push({ sourceId: source.id, reason: 'last-run-failed', label: 'Last run failed', tab: 'overview' });
    }
  }
  return items;
}

/**
 * Does this source authenticate git with the token it names? An `https` remote
 * does (issue 122) — clone, fetch and push all go through it — and so does a
 * review source, whose change requests go through the host API. An `ssh://`,
 * `git@host:path` or local remote uses the server's key or the filesystem, so a
 * token named beside one is unused and must not raise an alert.
 */
function usesHostToken(source: Pick<SourceStatusView, 'mode' | 'remote_url'>): boolean {
  return needsHost(source.mode) || /^https?:\/\//i.test((source.remote_url ?? '').trim());
}

/** "1 source needs attention" / "2 sources need attention". */
export function attentionHeadline(items: readonly AttentionItem[]): string {
  const n = new Set(items.map((i) => i.sourceId)).size;
  return `${n} ${n === 1 ? 'source needs' : 'sources need'} attention`;
}

// ---------------------------------------------------------------- filters

export type StateFilter = 'all' | 'attention' | 'in-sync' | 'syncing' | 'disabled';

export const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'in-sync', label: 'In sync' },
  { value: 'syncing', label: 'Syncing' },
  { value: 'disabled', label: 'Disabled' },
];

export interface SourceFilters {
  q: string;
  state: StateFilter;
  policy: '' | SyncMode;
  role: '' | SourceRole;
}

export const NO_FILTERS: SourceFilters = { q: '', state: 'all', policy: '', role: '' };

export function hasFilters(filters: SourceFilters): boolean {
  return filters.q.trim() !== '' || filters.state !== 'all' || filters.policy !== '' || filters.role !== '';
}

function matchesState(source: SourceStatusView, state: StateFilter, attention: ReadonlySet<string>): boolean {
  switch (state) {
    case 'all':
      return true;
    case 'attention':
      return attention.has(source.id);
    case 'syncing':
      return isBusy(source);
    case 'disabled':
      return !isEnabled(source);
    case 'in-sync':
      return isEnabled(source) && sourceStateChip(source).tone === 'ok';
  }
}

/** The rows a filter keeps. Search is a case-insensitive substring of the id, the remote, or the working tree. */
export function filterSources(sources: readonly SourceStatusView[], filters: SourceFilters): SourceStatusView[] {
  const q = filters.q.trim().toLowerCase();
  const attention = new Set(attentionItems(sources).map((i) => i.sourceId));
  return sources.filter((source) => {
    if (q && ![source.id, source.remote_url ?? '', source.local_dir ?? ''].some((v) => v.toLowerCase().includes(q))) return false;
    if (filters.policy && source.mode !== filters.policy) return false;
    if (filters.role && source.role !== filters.role) return false;
    return matchesState(source, filters.state, attention);
  });
}

// ---------------------------------------------------------------- polling

export const POLL_BUSY_MS = 10_000;
export const POLL_IDLE_MS = 60_000;

/**
 * How often the list refetches. Fast while anything is mid-cycle — on the
 * server, or a Sync this browser just started — so the chip settles within
 * seconds; slow otherwise, because an idle registry changes only on schedule.
 * (Hidden tabs do not poll at all: TanStack Query's `refetchIntervalInBackground`
 * is left false.)
 */
export function pollInterval(sources: readonly Pick<SourceStatusView, 'status'>[] | undefined, localBusy = false): number {
  if (localBusy) return POLL_BUSY_MS;
  return (sources ?? []).some(isBusy) ? POLL_BUSY_MS : POLL_IDLE_MS;
}

// ------------------------------------------------------------------- URL

/**
 * Everything the page keeps in the address bar. Filters so a view can be
 * shared; the open sheet so System health, the Overview or the attention strip
 * can link straight to `?source=topic:ops&tab=conflicts`.
 *
 * `edit` wins over `source`: an editor opened from the detail sheet keeps
 * `source` underneath it, so closing the editor lands back on the detail.
 */
export interface SourcesSearch extends SourceFilters {
  source: string | null;
  tab: SheetTabId | null;
  edit: string | null;
  isNew: boolean;
}

const TAB_IDS: readonly SheetTabId[] = ['overview', 'conflicts', 'reviews', 'selection'];

/** The router hands search values back JSON-parsed (`?new=1` is the number 1), so read everything as text. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function readSourcesSearch(search: Record<string, unknown> | undefined): SourcesSearch {
  const state = text(search?.['state']) as StateFilter;
  const policy = text(search?.['policy']);
  const role = text(search?.['role']);
  const tab = text(search?.['tab']) as SheetTabId;
  const isNewText = text(search?.['new']);
  return {
    q: text(search?.['q']),
    state: STATE_FILTERS.some((f) => f.value === state) ? state : 'all',
    policy: MODE_OPTIONS.some((m) => m.value === policy) ? (policy as SyncMode) : '',
    role: ROLE_OPTIONS.some((r) => r.value === role) ? (role as SourceRole) : '',
    source: text(search?.['source']) || null,
    tab: TAB_IDS.includes(tab) ? tab : null,
    edit: text(search?.['edit']) || null,
    isNew: isNewText === '1' || isNewText === 'true',
  };
}

/**
 * The search object to navigate to. Blank and default values are dropped so the
 * URL says only what is actually set; `new` is written as the number 1 so it
 * reads `?new=1` rather than a JSON-quoted string.
 */
export function writeSourcesSearch(next: SourcesSearch): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (next.q.trim()) out['q'] = next.q;
  if (next.state !== 'all') out['state'] = next.state;
  if (next.policy) out['policy'] = next.policy;
  if (next.role) out['role'] = next.role;
  if (next.source) out['source'] = next.source;
  if (next.source && next.tab && next.tab !== 'overview') out['tab'] = next.tab;
  if (next.edit) out['edit'] = next.edit;
  if (next.isNew) out['new'] = 1;
  return out;
}

/** The tab a detail sheet shows: the asked-for one when this source has it, else Overview. */
export function resolveTab(tab: SheetTabId | null, source: Pick<SourceStatusView, 'mode'>): SheetTabId {
  if (!tab) return 'overview';
  if (tab === 'reviews' && source.mode !== 'review') return 'overview';
  return tab;
}

// ------------------------------------------------------------ explanation

export interface StateExplanation {
  text: string;
  /** The runbook section that answers it, where one exists (plan B5). */
  runbook?: RunbookSection;
}

/** The Overview tab's sentence under the state chip. */
export function explainSyncState(source: SourceStatusView): StateExplanation {
  const chip = sourceStateChip(source);
  if (!isEnabled(source)) return { text: 'Disabled — no sync runs for this source until it is enabled again.' };
  switch (chip.tone) {
    case 'conflict': {
      const n = openConflictCount(source);
      return {
        text: `A merge left ${n === 1 ? 'a file' : `${n} files`} conflicted. Nothing else syncs for this source until each one is resolved.`,
        runbook: RUNBOOK.sourceConflict,
      };
    }
    case 'error':
      return {
        text: chip.label === 'Error' ? 'The sync engine stopped on an error.' : 'The last sync cycle failed; the next one will try again.',
        runbook: RUNBOOK.sourceConflict,
      };
    case 'busy':
      return { text: `A sync cycle is running (${chip.label.toLowerCase()}).` };
    case 'pending': {
      if (!source.status) return { text: 'This server did not report a live state for this source.' };
      const parts: string[] = [];
      if (source.status.ahead > 0) parts.push('local commits have not been pushed yet');
      if (source.status.behind > 0) parts.push('remote commits have not been merged yet');
      return {
        text: `${describeDrift(source.status)}: ${parts.join(', and ')}.`,
        runbook: RUNBOOK.sourceConflict,
      };
    }
    default:
      return {
        text: source.remote_url
          ? 'The working tree matches the remote.'
          : 'Local only — there is no remote to sync with.',
      };
  }
}

// -------------------------------------------------------------------- age

/** "just now", "4 min ago", "3 h ago", "2 d ago"; "Never" with no timestamp. */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}

/** The row's last successful cycle: the registry column, else the live status. */
export function lastSyncedAt(source: Pick<SourceStatusView, 'last_synced_at' | 'status'>): string | null {
  return source.last_synced_at ?? source.status?.last_synced_at ?? null;
}

// ------------------------------------------------------------------ editor

/** Each form field's visible label — the error summary names fields the way the form does. */
export const FIELD_LABELS: Record<keyof SourceForm, string> = {
  id: 'Source id',
  enabled: 'Enabled',
  remote_url: 'Remote URL',
  branch: 'Branch',
  local_dir: 'Local working tree',
  mode: 'Sync policy',
  role: 'Role',
  host_kind: 'Host',
  host_base_url: 'Host base URL',
  host_token_env: 'Host token env var',
  webhook_secret_env: 'Webhook secret env var',
  include_globs: 'Include globs',
  exclude_globs: 'Exclude globs',
  default_type: 'Default type for imported files',
  branch_prefix: 'Branch prefix',
  sync_every_seconds: 'Sync every (seconds)',
  default_status: 'Default status for inbound items',
};

/** Form order, so the summary lists errors top to bottom. */
const FIELD_ORDER = Object.keys(FIELD_LABELS) as (keyof SourceForm)[];

export type EditorGroup = 'repository' | 'policy' | 'host' | 'selection' | 'advanced';

/**
 * Which group a field renders in. The webhook secret sits with the host under
 * review mode (where the attention strip checks it) and under Advanced for the
 * other modes — a direct source can still take a webhook, so hiding the field
 * there would drop a column the form has always edited.
 */
export function groupOfField(field: keyof SourceForm, mode: SyncMode): EditorGroup {
  switch (field) {
    case 'id':
    case 'enabled':
    case 'remote_url':
    case 'branch':
    case 'local_dir':
      return 'repository';
    case 'mode':
    case 'role':
      return 'policy';
    case 'host_kind':
    case 'host_base_url':
    case 'host_token_env':
      return 'host';
    case 'webhook_secret_env':
      return needsHost(mode) ? 'host' : 'advanced';
    case 'include_globs':
    case 'exclude_globs':
    case 'default_type':
      return 'selection';
    default:
      return 'advanced';
  }
}

export interface FieldErrorEntry {
  field: keyof SourceForm;
  label: string;
  message: string;
}

/** The error summary's lines, in form order. */
export function errorSummary(errors: Partial<Record<keyof SourceForm, string>>): FieldErrorEntry[] {
  return FIELD_ORDER.filter((f) => errors[f]).map((field) => ({ field, label: FIELD_LABELS[field], message: errors[field]! }));
}

/** Whether a collapsed group holds an error, so it can open itself instead of hiding the message. */
export function groupHasError(errors: Partial<Record<keyof SourceForm, string>>, group: EditorGroup, mode: SyncMode): boolean {
  return FIELD_ORDER.some((f) => errors[f] && groupOfField(f, mode) === group);
}

/**
 * Whether the form differs from what it opened with. Globs compare as parsed
 * lists, so a trailing newline or stray indentation is not an unsaved change.
 */
export function isSourceFormDirty(initial: SourceForm, form: SourceForm): boolean {
  return FIELD_ORDER.some((key) => {
    if (key === 'include_globs' || key === 'exclude_globs') {
      return parseGlobLines(initial[key]).join('\n') !== parseGlobLines(form[key]).join('\n');
    }
    const a = initial[key];
    const b = form[key];
    return typeof a === 'string' && typeof b === 'string' ? a.trim() !== b.trim() : a !== b;
  });
}

/** The collapsed selection group's summary: the default layout, or the globs in effect. */
export function selectionSummary(form: Pick<SourceForm, 'include_globs' | 'exclude_globs'>): string {
  const include = parseGlobLines(form.include_globs);
  const exclude = parseGlobLines(form.exclude_globs);
  if (include.length === 0 && exclude.length === 0) return 'OKF layout (default)';
  const parts = [include.length ? include.join(', ') : 'OKF layout'];
  if (exclude.length) parts.push(`minus ${exclude.join(', ')}`);
  return parts.join(' ');
}

/**
 * Presence of a secret for the editor: only when the env var NAME being edited
 * is the one the server checked. A renamed variable has not been checked yet,
 * and showing the old verdict beside the new name would vouch for the wrong one.
 */
export function editorSecretPresence(
  source: SourceStatusView | null | undefined,
  kind: 'host-token' | 'webhook-secret',
  envName: string,
): boolean | undefined {
  if (!source) return undefined;
  const chip = describeSecrets(source).find((s) => s.kind === kind);
  if (!chip || chip.env !== envName.trim()) return undefined;
  return chip.tone === 'ok';
}

