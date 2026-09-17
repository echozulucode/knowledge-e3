import { describe, expect, it } from 'vitest';
import { emptySourceForm } from './sourceModel.js';
import {
  NO_FILTERS,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
  attentionHeadline,
  attentionItems,
  editorSecretPresence,
  errorSummary,
  explainSyncState,
  filterSources,
  formatAge,
  groupHasError,
  groupOfField,
  hasFilters,
  isSourceFormDirty,
  openConflictCount,
  pollInterval,
  readSourcesSearch,
  resolveTab,
  sourceStateChip,
  selectionSummary,
  stateTone,
  writeSourcesSearch,
} from './sourcesAdminModel.js';
import type { SourceStatusView, SyncStatus } from './types.js';

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    source: 'main',
    state: 'idle',
    ahead: 0,
    behind: 0,
    dirty_paths: [],
    conflicted_paths: [],
    last_synced_at: null,
    last_error: null,
    ...patch,
  };
}

function src(patch: Partial<SourceStatusView> = {}): SourceStatusView {
  return {
    id: 'main',
    space_id: null,
    local_dir: 'main',
    remote_url: null,
    branch: null,
    role: 'authoritative',
    mode: 'direct',
    branch_prefix: 'e3/',
    host_kind: null,
    host_base_url: null,
    host_token_env: null,
    sync_every_seconds: null,
    webhook_secret_env: null,
    default_status: null,
    enabled: 1,
    last_synced_at: null,
    last_error: null,
    status: status(),
    ...patch,
  };
}

describe('stateTone', () => {
  it('maps the row chip onto the shared StatusChip vocabulary', () => {
    expect(stateTone({ label: 'In sync', tone: 'ok' })).toBe('ok');
    expect(stateTone({ label: 'Fetching', tone: 'busy' })).toBe('pending');
    expect(stateTone({ label: 'Ahead 1', tone: 'pending' })).toBe('pending');
    // A conflict waits on a decision; nothing is broken.
    expect(stateTone({ label: 'Conflict (2)', tone: 'conflict' })).toBe('warn');
    expect(stateTone({ label: 'Error', tone: 'error' })).toBe('error');
  });
});

describe('sourceStateChip', () => {
  it('does not show In sync over an error the registry row recorded', () => {
    expect(sourceStateChip(src()).label).toBe('In sync');
    expect(sourceStateChip(src({ last_error: 'fetch failed' }))).toEqual({ label: 'Last run failed', tone: 'error', detail: 'fetch failed' });
    // The live status still wins when it says more.
    expect(sourceStateChip(src({ last_error: 'x', status: status({ state: 'fetching' }) })).label).toBe('Fetching');
  });
});

describe('openConflictCount', () => {
  it('counts conflicted paths, and a conflict state without paths as one', () => {
    expect(openConflictCount(src({ status: status({ conflicted_paths: ['a.md', 'b.md'] }) }))).toBe(2);
    expect(openConflictCount(src({ status: status({ state: 'conflict' }) }))).toBe(1);
    expect(openConflictCount(src())).toBe(0);
  });
});

describe('attentionItems', () => {
  it('is empty when nothing is blocked', () => {
    expect(attentionItems([src(), src({ id: 'topic:a' })])).toEqual([]);
  });

  it('sends open conflicts to the Conflicts tab', () => {
    const items = attentionItems([src({ id: 'topic:ops', status: status({ state: 'conflict', conflicted_paths: ['a', 'b', 'c'] }) })]);
    expect(items).toEqual([{ sourceId: 'topic:ops', reason: 'conflict', label: 'Conflict (3)', tab: 'conflicts' }]);
  });

  it('flags a missing host token or webhook secret only for review mode, by name', () => {
    const review = src({
      id: 'topic:hr',
      mode: 'review',
      host_token_env: 'HR_TOKEN',
      host_token_present: false,
      webhook_secret_env: 'HR_HOOK',
      webhook_secret_present: false,
    });
    const direct = src({ id: 'topic:direct', host_token_env: 'X', host_token_present: false });
    const items = attentionItems([review, direct]);
    expect(items).toEqual([
      { sourceId: 'topic:hr', reason: 'host-token', label: 'HR_TOKEN ✗', tab: 'overview' },
      { sourceId: 'topic:hr', reason: 'webhook-secret', label: 'HR_HOOK ✗', tab: 'overview' },
    ]);
  });

  it('does not read an unreported presence flag as missing', () => {
    expect(attentionItems([src({ mode: 'review', host_token_env: 'T' })])).toEqual([]);
  });

  it('flags a failed last run, but not while a conflict already explains it', () => {
    expect(attentionItems([src({ last_error: 'boom' })])).toEqual([
      { sourceId: 'main', reason: 'last-run-failed', label: 'Last run failed', tab: 'overview' },
    ]);
    expect(attentionItems([src({ status: status({ state: 'error', last_error: 'x' }) })])[0]?.reason).toBe('last-run-failed');
    expect(attentionItems([src({ last_error: 'x', status: status({ state: 'conflict', conflicted_paths: ['a'] }) })]).map((i) => i.reason)).toEqual([
      'conflict',
    ]);
  });

  it('skips disabled sources: nothing runs for them', () => {
    expect(attentionItems([src({ enabled: 0, status: status({ state: 'conflict' }) })])).toEqual([]);
  });

  it('headlines the number of sources, not of reasons', () => {
    const items = attentionItems([
      src({ id: 'topic:a', mode: 'review', host_token_env: 'T', host_token_present: false, last_error: 'x' }),
      src({ id: 'topic:b', status: status({ state: 'conflict' }) }),
    ]);
    expect(items).toHaveLength(3);
    expect(attentionHeadline(items)).toBe('2 sources need attention');
    expect(attentionHeadline(items.slice(0, 1))).toBe('1 source needs attention');
  });
});

describe('filterSources', () => {
  const rows = [
    src({ id: 'main', remote_url: 'git@host:org/main.git' }),
    src({ id: 'topic:ops', mode: 'review', role: 'reference', local_dir: 'topics/ops', status: status({ state: 'conflict' }) }),
    src({ id: 'topic:busy', status: status({ state: 'fetching' }) }),
    src({ id: 'topic:off', enabled: 0 }),
  ];
  const ids = (filters: Partial<typeof NO_FILTERS>) => filterSources(rows, { ...NO_FILTERS, ...filters }).map((s) => s.id);

  it('keeps everything with no filters', () => {
    expect(ids({})).toEqual(['main', 'topic:ops', 'topic:busy', 'topic:off']);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, q: 'x' })).toBe(true);
  });

  it('searches the id, the remote and the working tree, case-insensitively', () => {
    expect(ids({ q: 'ORG/MAIN' })).toEqual(['main']);
    expect(ids({ q: 'topics/ops' })).toEqual(['topic:ops']);
    expect(ids({ q: 'busy' })).toEqual(['topic:busy']);
  });

  it('filters by state', () => {
    expect(ids({ state: 'attention' })).toEqual(['topic:ops']);
    expect(ids({ state: 'syncing' })).toEqual(['topic:busy']);
    expect(ids({ state: 'disabled' })).toEqual(['topic:off']);
    expect(ids({ state: 'in-sync' })).toEqual(['main']);
  });

  it('filters by policy and role', () => {
    expect(ids({ policy: 'review' })).toEqual(['topic:ops']);
    expect(ids({ role: 'reference' })).toEqual(['topic:ops']);
    expect(ids({ policy: 'direct', role: 'reference' })).toEqual([]);
  });
});

describe('pollInterval', () => {
  it('polls fast while a source is mid-cycle or a local sync is running, slow otherwise', () => {
    expect(pollInterval([src()])).toBe(POLL_IDLE_MS);
    expect(pollInterval(undefined)).toBe(POLL_IDLE_MS);
    expect(pollInterval([src(), src({ status: status({ state: 'pushing' }) })])).toBe(POLL_BUSY_MS);
    expect(pollInterval([src()], true)).toBe(POLL_BUSY_MS);
    // A conflict is not busy: it waits on a person, not on the engine.
    expect(pollInterval([src({ status: status({ state: 'conflict' }) })])).toBe(POLL_IDLE_MS);
  });
});

describe('URL params', () => {
  it('reads filters and sheet state, dropping unknown values', () => {
    expect(readSourcesSearch({ q: 'ops', state: 'attention', policy: 'review', role: 'reference', source: 'topic:ops', tab: 'conflicts' })).toEqual({
      q: 'ops',
      state: 'attention',
      policy: 'review',
      role: 'reference',
      source: 'topic:ops',
      tab: 'conflicts',
      edit: null,
      isNew: false,
    });
    expect(readSourcesSearch({ state: 'bogus', policy: 'yolo', tab: 'nope' })).toMatchObject({ state: 'all', policy: '', tab: null });
    expect(readSourcesSearch(undefined)).toMatchObject({ q: '', source: null, isNew: false });
  });

  it('accepts the JSON-parsed values the router hands back', () => {
    expect(readSourcesSearch({ new: 1 }).isNew).toBe(true);
    expect(readSourcesSearch({ new: '1' }).isNew).toBe(true);
    expect(readSourcesSearch({ q: 123 }).q).toBe('123');
  });

  it('writes only what is set, and a tab only beside a source', () => {
    const base = readSourcesSearch({});
    expect(writeSourcesSearch(base)).toEqual({});
    expect(writeSourcesSearch({ ...base, source: 'main', tab: 'conflicts' })).toEqual({ source: 'main', tab: 'conflicts' });
    expect(writeSourcesSearch({ ...base, source: 'main', tab: 'overview' })).toEqual({ source: 'main' });
    expect(writeSourcesSearch({ ...base, tab: 'conflicts' })).toEqual({});
    expect(writeSourcesSearch({ ...base, isNew: true, q: 'x', state: 'disabled' })).toEqual({ new: 1, q: 'x', state: 'disabled' });
    expect(writeSourcesSearch({ ...base, edit: 'topic:a', source: 'topic:a' })).toEqual({ edit: 'topic:a', source: 'topic:a' });
  });

  it('round-trips', () => {
    const search = { q: 'ops', state: 'syncing', policy: 'direct', role: 'authoritative', source: 'topic:x', tab: 'selection' };
    expect(writeSourcesSearch(readSourcesSearch(search))).toEqual(search);
  });

  it('resolves a tab the source does not have to Overview', () => {
    expect(resolveTab(null, src())).toBe('overview');
    expect(resolveTab('conflicts', src())).toBe('conflicts');
    expect(resolveTab('reviews', src({ mode: 'direct' }))).toBe('overview');
    expect(resolveTab('reviews', src({ mode: 'review' }))).toBe('reviews');
  });
});

describe('explainSyncState', () => {
  it('points a conflict and a failure at runbook §3.2', () => {
    const conflict = explainSyncState(src({ status: status({ state: 'conflict', conflicted_paths: ['a', 'b'] }) }));
    expect(conflict.text).toMatch(/2 files conflicted/);
    expect(conflict.runbook?.number).toBe('3.2');
    expect(explainSyncState(src({ last_error: 'boom' })).runbook?.number).toBe('3.2');
  });

  it('explains drift, busy, disabled, and a clean local source', () => {
    expect(explainSyncState(src({ status: status({ ahead: 2 }) })).text).toMatch(/^Ahead 2: local commits have not been pushed/);
    expect(explainSyncState(src({ status: status({ state: 'merging' }) })).text).toMatch(/merging/);
    expect(explainSyncState(src({ enabled: 0 })).text).toMatch(/^Disabled/);
    expect(explainSyncState(src()).text).toMatch(/Local only/);
    expect(explainSyncState(src({ remote_url: 'x' })).text).toMatch(/matches the remote/);
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  it('reads as a relative age', () => {
    expect(formatAge(null, now)).toBe('Never');
    expect(formatAge('2026-09-14T11:59:40.000Z', now)).toBe('just now');
    expect(formatAge('2026-09-14T11:58:00.000Z', now)).toBe('2 min ago');
    expect(formatAge('2026-09-14T09:00:00.000Z', now)).toBe('3 h ago');
    expect(formatAge('2026-09-12T12:00:00.000Z', now)).toBe('2 d ago');
    expect(formatAge('not a date', now)).toBe('not a date');
  });
});

describe('editor helpers', () => {
  it('lists field errors in form order with their labels', () => {
    expect(errorSummary({ include_globs: 'bad glob', id: 'An id is required.' })).toEqual([
      { field: 'id', label: 'Source id', message: 'An id is required.' },
      { field: 'include_globs', label: 'Include globs', message: 'bad glob' },
    ]);
  });

  it('knows which group a field renders in, so a collapsed group with an error opens', () => {
    expect(groupOfField('include_globs', 'direct')).toBe('selection');
    expect(groupOfField('sync_every_seconds', 'direct')).toBe('advanced');
    expect(groupOfField('webhook_secret_env', 'review')).toBe('host');
    expect(groupOfField('webhook_secret_env', 'direct')).toBe('advanced');
    expect(groupHasError({ sync_every_seconds: 'x' }, 'advanced', 'direct')).toBe(true);
    expect(groupHasError({ id: 'x' }, 'selection', 'direct')).toBe(false);
  });

  it('is dirty only for a real change; glob whitespace is not one', () => {
    const initial = { ...emptySourceForm(), id: 'main', include_globs: 'docs/*.md' };
    expect(isSourceFormDirty(initial, { ...initial })).toBe(false);
    expect(isSourceFormDirty(initial, { ...initial, include_globs: '  docs/*.md\n\n' })).toBe(false);
    expect(isSourceFormDirty(initial, { ...initial, branch: 'dev' })).toBe(true);
    expect(isSourceFormDirty(initial, { ...initial, enabled: false })).toBe(true);
  });

  it('summarises the selection for the collapsed group', () => {
    expect(selectionSummary({ include_globs: '', exclude_globs: '' })).toBe('OKF layout (default)');
    expect(selectionSummary({ include_globs: 'docs/**/*.md\nhb/*.md', exclude_globs: '' })).toBe('docs/**/*.md, hb/*.md');
    expect(selectionSummary({ include_globs: '', exclude_globs: 'drafts/**' })).toBe('OKF layout minus drafts/**');
  });

  it('shows secret presence only for the env var name the server checked', () => {
    const source = src({ host_token_env: 'GH_TOKEN', host_token_present: true, webhook_secret_env: 'HOOK', webhook_secret_present: false });
    expect(editorSecretPresence(source, 'host-token', 'GH_TOKEN')).toBe(true);
    expect(editorSecretPresence(source, 'webhook-secret', ' HOOK ')).toBe(false);
    expect(editorSecretPresence(source, 'host-token', 'RENAMED')).toBeUndefined();
    expect(editorSecretPresence(null, 'host-token', 'GH_TOKEN')).toBeUndefined();
    expect(editorSecretPresence(src({ host_token_env: 'T' }), 'host-token', 'T')).toBeUndefined();
  });
});
