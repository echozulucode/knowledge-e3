import { describe, expect, it } from 'vitest';
import {
  MODE_OPTIONS,
  describeDrift,
  describeHead,
  describeItemCount,
  describeSelection,
  globProblem,
  globsOf,
  parseGlobLines,
  describeHost,
  describeResolution,
  describeSecrets,
  describeSyncState,
  stateChipTitle,
  defaultLocalDir,
  emptySourceForm,
  formFromSource,
  formToUpsert,
  formatSyncedAt,
  isValidSourceId,
  needsHost,
  splitConflicts,
  validateSourceForm,
} from './sourceModel.js';
import type { ConflictRow, SourceRow, SourceStatusView, SyncStatus } from './types.js';

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

function row(patch: Partial<SourceRow> = {}): SourceRow {
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
    ...patch,
  };
}

describe('mode options', () => {
  it('offers exactly the three plan §8.2 policies with an explanation each', () => {
    expect(MODE_OPTIONS.map((m) => m.value)).toEqual(['direct', 'review', 'read-only']);
    for (const mode of MODE_OPTIONS) {
      expect(mode.explanation.length).toBeGreaterThan(40);
      expect(mode.fits.length).toBeGreaterThan(0);
    }
  });

  it('only review mode opens change requests, so only it needs a host', () => {
    expect(needsHost('review')).toBe(true);
    expect(needsHost('direct')).toBe(false);
    expect(needsHost('read-only')).toBe(false);
  });
});

describe('describeSyncState', () => {
  it('reports being in sync when idle and level with the remote', () => {
    expect(describeSyncState(status())).toEqual({ label: 'In sync', tone: 'ok' });
  });

  it('reports drift in both directions', () => {
    expect(describeSyncState(status({ ahead: 2, behind: 1 }))).toMatchObject({
      label: 'Ahead 2 · Behind 1',
      tone: 'pending',
    });
    expect(describeDrift({ ahead: 0, behind: 3 })).toBe('Behind 3');
    expect(describeDrift({ ahead: 0, behind: 0 })).toBe('');
  });

  it('lets a conflict win over drift and names the conflicted paths', () => {
    const chip = describeSyncState(status({ state: 'conflict', ahead: 4, conflicted_paths: ['a.md', 'b.md'] }));
    expect(chip).toEqual({ label: 'Conflict (2)', tone: 'conflict', detail: 'a.md, b.md' });
  });

  it('surfaces an error with its message, and a stale error after a quiet cycle', () => {
    expect(describeSyncState(status({ state: 'error', last_error: 'auth failed' }))).toEqual({
      label: 'Error',
      tone: 'error',
      detail: 'auth failed',
    });
    expect(describeSyncState(status({ last_error: 'push rejected' }))).toMatchObject({ tone: 'error' });
  });

  it('labels the transient engine states', () => {
    expect(describeSyncState(status({ state: 'pushing' }))).toEqual({ label: 'Pushing', tone: 'busy' });
    expect(describeSyncState(undefined)).toEqual({ label: 'Unknown', tone: 'pending' });
  });
});

describe('secret presence (B3 / D4a)', () => {
  const view = (patch: Partial<SourceStatusView> = {}): SourceStatusView => ({
    ...row(),
    status: status(),
    ...patch,
  });

  it('names the env var and says whether the server has it', () => {
    const chips = describeSecrets(
      view({ host_token_env: 'E3_GITHUB_TOKEN', host_token_present: true, webhook_secret_env: 'E3_HOOK', webhook_secret_present: false }),
    );
    expect(chips.map((c) => [c.kind, c.label, c.tone])).toEqual([
      ['host-token', 'E3_GITHUB_TOKEN ✓', 'ok'],
      ['webhook-secret', 'E3_HOOK ✗ not set on this server', 'error'],
    ]);
    // Presence is the whole of it: nothing derived from a value can appear.
    for (const chip of chips) expect(`${chip.label} ${chip.title}`).not.toMatch(/length|characters|\.\.\.|…/);
  });

  it('points a missing host token at the runbook section that diagnoses it', () => {
    const [chip] = describeSecrets(view({ host_token_env: 'E3_GITHUB_TOKEN', host_token_present: false }));
    expect(chip?.title).toContain('runbook §3.3');
    expect(chip?.title).toContain('docs/operations-runbook.md#33-');
  });

  it('says nothing when the row names no env var, or the server did not report presence', () => {
    expect(describeSecrets(view())).toEqual([]);
    // A server that predates the flags: absent is not "not set".
    expect(describeSecrets(view({ host_token_env: 'E3_GITHUB_TOKEN' }))).toEqual([]);
  });
});

describe('state chip titles point at the runbook (B5)', () => {
  it('adds §3.2 to a conflict or an error, and leaves the healthy states alone', () => {
    const conflict = describeSyncState(status({ state: 'conflict', conflicted_paths: ['a.md'] }));
    expect(stateChipTitle(conflict)).toContain('a.md');
    expect(stateChipTitle(conflict)).toContain('runbook §3.2');
    expect(stateChipTitle(describeSyncState(status({ state: 'error', last_error: 'auth failed' })))).toContain('runbook §3.2');
    expect(stateChipTitle(describeSyncState(status()))).toBeUndefined();
  });
});

describe('row presentation', () => {
  it('says Never until a source has synced', () => {
    expect(formatSyncedAt(null)).toBe('Never');
    expect(formatSyncedAt('not a date')).toBe('not a date');
    expect(formatSyncedAt('2026-09-07T10:00:00.000Z')).not.toBe('Never');
  });

  it('names the change-request host and its base URL', () => {
    expect(describeHost(row())).toBe('—');
    expect(describeHost(row({ host_kind: 'github' }))).toBe('GitHub');
    expect(describeHost(row({ host_kind: 'bitbucket-dc', host_base_url: 'https://bb.example.com' }))).toBe(
      'Bitbucket Data Center · https://bb.example.com',
    );
  });
});

describe('source ids and local dirs', () => {
  it('accepts main and topic:<slug> only', () => {
    expect(isValidSourceId('main')).toBe(true);
    expect(isValidSourceId('topic:game-dev')).toBe(true);
    expect(isValidSourceId('topic:Game Dev')).toBe(false);
    expect(isValidSourceId('anything-else')).toBe(false);
  });

  it('mirrors the server default working-tree dir', () => {
    expect(defaultLocalDir('main')).toBe('main');
    expect(defaultLocalDir('topic:game-dev')).toBe('topics/game-dev');
    expect(defaultLocalDir('')).toBe('main');
  });
});

describe('validateSourceForm', () => {
  it('passes a plain local direct source with no remote', () => {
    const form = { ...emptySourceForm(), id: 'topic:notes' };
    expect(validateSourceForm(form)).toEqual({});
  });

  it('rejects an unusable id', () => {
    expect(validateSourceForm({ ...emptySourceForm(), id: '' }).id).toMatch(/required/i);
    expect(validateSourceForm({ ...emptySourceForm(), id: 'Nope' }).id).toMatch(/main/);
  });

  it('requires a host for review mode', () => {
    const form = { ...emptySourceForm(), id: 'main', mode: 'review' as const };
    expect(validateSourceForm(form).host_kind).toMatch(/host/i);
    expect(validateSourceForm({ ...form, host_kind: 'github' as const })).toEqual({});
  });

  it('holds the sync interval to whole seconds of at least five', () => {
    const form = { ...emptySourceForm(), id: 'main' };
    expect(validateSourceForm({ ...form, sync_every_seconds: '4' }).sync_every_seconds).toMatch(/5/);
    expect(validateSourceForm({ ...form, sync_every_seconds: '2.5' }).sync_every_seconds).toMatch(/whole/i);
    expect(validateSourceForm({ ...form, sync_every_seconds: '60' }).sync_every_seconds).toBeUndefined();
  });

  it('rejects an option-injection remote', () => {
    expect(validateSourceForm({ ...emptySourceForm(), id: 'main', remote_url: '--upload-pack=x' }).remote_url).toBeTruthy();
  });
});

describe('formToUpsert', () => {
  it('sends blanks as null and falls back to the default local dir', () => {
    const payload = formToUpsert({ ...emptySourceForm(), id: 'topic:notes' });
    expect(payload).toMatchObject({
      local_dir: 'topics/notes',
      remote_url: null,
      branch: null,
      mode: 'direct',
      role: 'authoritative',
      host_kind: null,
      sync_every_seconds: null,
      default_status: null,
      enabled: true,
    });
  });

  it('drops the host fields for the modes that never open a change request', () => {
    const payload = formToUpsert({
      ...emptySourceForm(),
      id: 'main',
      mode: 'direct',
      host_kind: 'github',
      host_base_url: 'https://api.github.com',
      host_token_env: 'GITHUB_TOKEN',
    });
    expect(payload.host_kind).toBeNull();
    expect(payload.host_base_url).toBeNull();
    expect(payload.host_token_env).toBeNull();
  });

  it('keeps the host fields for review mode and round-trips an existing row', () => {
    const existing = row({
      id: 'topic:matlab',
      mode: 'review',
      host_kind: 'github',
      host_token_env: 'GITHUB_TOKEN',
      remote_url: 'git@github.com:org/matlab.git',
      sync_every_seconds: 120,
      enabled: 0,
    });
    const payload = formToUpsert(formFromSource(existing));
    expect(payload).toMatchObject({
      mode: 'review',
      host_kind: 'github',
      host_token_env: 'GITHUB_TOKEN',
      remote_url: 'git@github.com:org/matlab.git',
      sync_every_seconds: 120,
      enabled: false,
    });
  });
});

describe('conflicts', () => {
  const conflict = (patch: Partial<ConflictRow>): ConflictRow => ({
    id: 'c1',
    source_id: 'main',
    path: 'a.md',
    page_id: null,
    ours: 'mine',
    theirs: 'theirs',
    base: null,
    detected_at: '2026-09-01T00:00:00.000Z',
    resolved_at: null,
    resolution: null,
    resolved_by: null,
    ...patch,
  });

  it('splits open from resolved, oldest open first and newest resolved first', () => {
    const rows = [
      conflict({ id: 'b', detected_at: '2026-09-02T00:00:00.000Z' }),
      conflict({ id: 'a', detected_at: '2026-09-01T00:00:00.000Z' }),
      conflict({ id: 'r1', resolved_at: '2026-09-03T00:00:00.000Z', resolution: 'ours' }),
      conflict({ id: 'r2', resolved_at: '2026-09-04T00:00:00.000Z', resolution: 'theirs' }),
    ];
    const { open, resolved } = splitConflicts(rows);
    expect(open.map((c) => c.id)).toEqual(['a', 'b']);
    expect(resolved.map((c) => c.id)).toEqual(['r2', 'r1']);
  });

  it('names each resolution the way the panel does', () => {
    expect(describeResolution(conflict({}))).toBe('Open');
    expect(describeResolution(conflict({ resolved_at: 'x', resolution: 'ours' }))).toBe('Kept mine');
    expect(describeResolution(conflict({ resolved_at: 'x', resolution: 'theirs' }))).toBe('Kept theirs');
    expect(describeResolution(conflict({ resolved_at: 'x', resolution: 'manual' }))).toBe('Merged by hand');
  });
});

describe('selection (plan A1)', () => {
  it('reads a glob column whether the server sends the stored JSON text or a list, and tolerates junk', () => {
    expect(globsOf('["docs/**/*.md"," handbook/*.md "]')).toEqual(['docs/**/*.md', 'handbook/*.md']);
    expect(globsOf(['docs/**/*.md', ''])).toEqual(['docs/**/*.md']);
    expect(globsOf(null)).toEqual([]);
    expect(globsOf(undefined)).toEqual([]);
    expect(globsOf('')).toEqual([]);
    expect(globsOf('not json')).toEqual([]);
    expect(globsOf('{"a":1}')).toEqual([]);
  });

  it('marks a row selective when either list is set, and titles it with every glob', () => {
    const plain = describeSelection(row());
    expect(plain.selective).toBe(false);
    expect(plain.title).toMatch(/concepts\/\*\.md/);

    const globbed = describeSelection(row({ include_globs: '["docs/**/*.md"]', exclude_globs: '["docs/archive/**"]' }));
    expect(globbed).toMatchObject({ include: ['docs/**/*.md'], exclude: ['docs/archive/**'], selective: true });
    expect(globbed.title).toBe('Indexes: docs/**/*.md\nExcludes: docs/archive/**');

    // Exclude-only still changes what is indexed.
    expect(describeSelection(row({ exclude_globs: '["drafts/**"]' })).selective).toBe(true);
  });

  it('reads one glob per line, trimmed, blank lines dropped', () => {
    expect(parseGlobLines('  docs/**/*.md\r\n\n\thandbook/*.md  \n')).toEqual(['docs/**/*.md', 'handbook/*.md']);
    expect(parseGlobLines('')).toEqual([]);
  });

  it('refuses the globs the server refuses: absolute, drive-lettered, or climbing out with ..', () => {
    expect(globProblem('docs/**/*.md')).toBeNull();
    expect(globProblem('./docs/*.md')).toBeNull();
    expect(globProblem('docs/..foo/*.md')).toBeNull();
    expect(globProblem('   ')).toMatch(/blank/);
    expect(globProblem('/etc/*.md')).toMatch(/absolute path/);
    expect(globProblem('C:/docs/*.md')).toMatch(/absolute path/);
    expect(globProblem('\\\\share\\docs')).toMatch(/absolute path/);
    expect(globProblem('docs/../secrets/*.md')).toMatch(/climbs out/);
    expect(globProblem('docs\\..\\secrets')).toMatch(/climbs out/);
  });

  it('puts a glob problem on the field it came from', () => {
    const errors = validateSourceForm({
      ...emptySourceForm(),
      id: 'topic:handbook',
      include_globs: 'docs/**/*.md\n/etc/passwd',
      exclude_globs: '../outside/**',
    });
    expect(errors.include_globs).toMatch(/\/etc\/passwd.*absolute path/);
    expect(errors.exclude_globs).toMatch(/climbs out/);
    expect(validateSourceForm({ ...emptySourceForm(), id: 'main', include_globs: 'docs/**/*.md\n\n' })).toEqual({});
  });

  it('round-trips globs and the default type through the form, and sends [] to clear them', () => {
    const existing = row({
      id: 'topic:handbook',
      include_globs: '["docs/**/*.md","handbook/*.md"]',
      exclude_globs: '["docs/archive/**"]',
      default_type: 'How-To',
    });
    const form = formFromSource(existing);
    expect(form).toMatchObject({ include_globs: 'docs/**/*.md\nhandbook/*.md', exclude_globs: 'docs/archive/**', default_type: 'How-To' });
    expect(formToUpsert(form)).toMatchObject({
      include_globs: ['docs/**/*.md', 'handbook/*.md'],
      exclude_globs: ['docs/archive/**'],
      default_type: 'How-To',
    });

    const cleared = formToUpsert({ ...form, include_globs: '  \n', exclude_globs: '', default_type: '' });
    expect(cleared).toMatchObject({ include_globs: [], exclude_globs: [], default_type: null });
    // A row from a server that predates the columns opens as the default layout.
    expect(formFromSource(row())).toMatchObject({ include_globs: '', exclude_globs: '', default_type: '' });
  });

  it('says HEAD differently for "not reported" and "nothing to report"', () => {
    expect(describeHead(undefined)).toBe('Not reported by this server');
    expect(describeHead(null)).toMatch(/^No commit to report/);
    expect(describeHead({ sha: '0123456789abcdef0123456789abcdef01234567', committed_at: null })).toBe('0123456');
    const withDate = describeHead({ sha: '0123456789abcdef0123456789abcdef01234567', committed_at: '2026-09-13T10:00:00.000Z' });
    expect(withDate.startsWith('0123456 · ')).toBe(true);
  });

  it('counts items, and never turns "not counted" into zero', () => {
    expect(describeItemCount(undefined)).toBe('—');
    expect(describeItemCount(0)).toBe('0 items');
    expect(describeItemCount(1)).toBe('1 item');
    expect(describeItemCount(12)).toBe('12 items');
  });
});
