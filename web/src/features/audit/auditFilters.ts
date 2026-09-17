/**
 * The Audit page's filter state and its query string
 * (the admin UX review §4.8).
 *
 * Every filter lives in the URL, so a finding is a link somebody can be sent and
 * a reload keeps it. Deep links IN use the same names: the Users page sends
 * `?actor=<username>` ("what did bob do") and `?subject=<username>` ("what was
 * done to bob"), Content health sends `?action=content.refused`, and item pages
 * may send `?item=<id>`. The older `?page_id=` spelling is still read.
 *
 * Pure: no router, no React, so read/write round-trips are unit-tested.
 */
import {
  RANGE_PRESETS,
  auditWindow,
  browserZone,
  presetSince,
  type AuditRangePreset,
  type ZoneOffset,
} from './auditModel.js';

export type AuditRange = 'all' | AuditRangePreset | 'custom';

export interface AuditFilters {
  /** Who acted: a username, or a deleted account's id. */
  actor?: string;
  action?: string;
  /** The account or thing acted on: a username or an id. */
  subject?: string;
  /** Item id (`page_id` on the server). */
  item?: string;
  range: AuditRange;
  /** Custom range only: local days, `YYYY-MM-DD`. */
  since?: string;
  until?: string;
  /** One entry by id (a shared "Copy link" to a row). */
  entry?: string;
}

export const EMPTY_FILTERS: AuditFilters = { range: 'all' };

function str(value: unknown): string | undefined {
  // TanStack Router JSON-parses search values, so `?actor=1234` arrives as a number.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const PRESETS = RANGE_PRESETS.map((p) => p.value) as readonly string[];

/** Read the state from the router's (untyped) search object. Anything malformed falls back to "not filtered". */
export function readAuditSearch(search: Record<string, unknown> | undefined): AuditFilters {
  const s = search ?? {};
  const since = str(s['since']);
  const until = str(s['until']);
  const rawRange = str(s['range']);
  // A shared `?since=` link predates the presets; it is a custom range.
  const range: AuditRange =
    rawRange && PRESETS.includes(rawRange) ? (rawRange as AuditRangePreset) : since || until || rawRange === 'custom' ? 'custom' : 'all';
  const out: AuditFilters = { range };
  const actor = str(s['actor']);
  const action = str(s['action']);
  const subject = str(s['subject']);
  const item = str(s['item']) ?? str(s['page_id']);
  const entry = str(s['entry']);
  if (actor) out.actor = actor;
  if (action) out.action = action;
  if (subject) out.subject = subject;
  if (item) out.item = item;
  if (range === 'custom') {
    if (since) out.since = since;
    if (until) out.until = until;
  }
  if (entry) out.entry = entry;
  return out;
}

/**
 * The query-string object for a state: unset filters are dropped rather than
 * carried as `?action=`, so the URL a finding is shared as says only what was
 * actually filtered on. `entry` is a NUMBER: TanStack Router's serializer
 * JSON-quotes a string that parses as JSON (`'42'` → `%2242%22`).
 */
export function auditSearchToParams(filters: AuditFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (filters.actor) out['actor'] = filters.actor;
  if (filters.action) out['action'] = filters.action;
  if (filters.subject) out['subject'] = filters.subject;
  if (filters.item) out['item'] = filters.item;
  if (filters.range === 'custom') {
    if (filters.since) out['since'] = filters.since;
    if (filters.until) out['until'] = filters.until;
    if (!filters.since && !filters.until) out['range'] = 'custom';
  } else if (filters.range !== 'all') {
    out['range'] = filters.range;
  }
  if (filters.entry) out['entry'] = /^\d+$/.test(filters.entry) ? Number(filters.entry) : filters.entry;
  return out;
}

/**
 * What the request sends. `at` pins "now" for a preset (see `presetSince`); the
 * custom days become local-midnight instants in `zone`.
 */
export function auditRequestParams(filters: AuditFilters, at: number, zone: ZoneOffset = browserZone): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.action) params.set('action', filters.action);
  if (filters.subject) params.set('subject', filters.subject);
  if (filters.item) params.set('page_id', filters.item);
  if (filters.entry) params.set('entry', filters.entry);
  if (filters.range === 'custom') {
    const window = auditWindow(filters, zone);
    if (window.since) params.set('since', window.since);
    if (window.until) params.set('until', window.until);
  } else if (filters.range !== 'all') {
    params.set('since', presetSince(filters.range, at));
  }
  return params;
}

export type AuditFilterKey = 'actor' | 'action' | 'subject' | 'item' | 'range' | 'entry';

export interface ActiveFilterChip {
  key: AuditFilterKey;
  label: string;
  value: string;
}

function rangeText(filters: AuditFilters): string {
  if (filters.range === 'custom') {
    if (filters.since && filters.until) return filters.since === filters.until ? filters.since : `${filters.since} – ${filters.until}`;
    if (filters.since) return `from ${filters.since}`;
    if (filters.until) return `through ${filters.until}`;
    return 'custom';
  }
  return RANGE_PRESETS.find((p) => p.value === filters.range)?.label.toLowerCase() ?? filters.range;
}

/** The "Active:" chip row, in the order the controls appear. An empty custom range is not a filter yet. */
export function activeFilterChips(filters: AuditFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (filters.actor) chips.push({ key: 'actor', label: 'actor', value: filters.actor });
  if (filters.action) chips.push({ key: 'action', label: 'action', value: filters.action });
  if (filters.subject) chips.push({ key: 'subject', label: 'subject', value: filters.subject });
  if (filters.item) chips.push({ key: 'item', label: 'item', value: filters.item });
  if (filters.range !== 'all' && !(filters.range === 'custom' && !filters.since && !filters.until)) {
    chips.push({ key: 'range', label: 'when', value: rangeText(filters) });
  }
  if (filters.entry) chips.push({ key: 'entry', label: 'entry', value: `#${filters.entry}` });
  return chips;
}

/** The state with one filter removed. */
export function withoutFilter(filters: AuditFilters, key: AuditFilterKey): AuditFilters {
  const next: AuditFilters = { ...filters };
  if (key === 'range') {
    next.range = 'all';
    delete next.since;
    delete next.until;
  } else {
    delete next[key];
  }
  return next;
}

/**
 * A change to any filter leaves the single-entry view: "Filter by actor" from an
 * entry link means "this person's other rows", which `entry` would hide.
 */
export function withFilter(filters: AuditFilters, patch: Partial<AuditFilters>): AuditFilters {
  const next: AuditFilters = { ...filters, ...patch };
  if (!('entry' in patch)) delete next.entry;
  for (const key of ['actor', 'action', 'subject', 'item', 'since', 'until', 'entry'] as const) {
    if (!next[key]) delete next[key];
  }
  if (next.range !== 'custom') {
    delete next.since;
    delete next.until;
  }
  return next;
}

/**
 * Action codes grouped by their prefix (`auth`, `user`, `token`…) for the
 * Action select's option groups, codes verbatim and sorted. `selected` is kept
 * even when the log has no such row yet: Content health links to
 * `?action=content.refused` before anything was refused, and a select that
 * could not show the active value would claim "All actions" over a filtered table.
 */
export function groupActionCodes(actions: readonly string[], selected?: string): { prefix: string; codes: string[] }[] {
  const all = [...new Set(selected ? [...actions, selected] : actions)].sort();
  const groups = new Map<string, string[]>();
  for (const code of all) {
    const dot = code.indexOf('.');
    const prefix = dot > 0 ? code.slice(0, dot) : code;
    groups.set(prefix, [...(groups.get(prefix) ?? []), code]);
  }
  return [...groups].map(([prefix, codes]) => ({ prefix, codes }));
}

/** Stable identity of a filter set, for query keys. */
export function filtersKey(filters: AuditFilters): string {
  return new URLSearchParams(Object.entries(auditSearchToParams(filters)).map(([k, v]) => [k, String(v)])).toString();
}
