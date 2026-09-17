import { describe, expect, it } from 'vitest';
import { OVERVIEW_SHORTCUT_IDS, buildAttention, buildShortcutGroups, queuedTotal } from './adminOverviewModel.js';
import { ADMIN_NAV } from '../components/admin/AdminNav.model.js';
import type { SourceStatusView } from '../features/sources/types.js';
import type { ContentHealthReport } from '../features/health/queries.js';

function source(id: string, over: Partial<SourceStatusView> = {}, conflicted: string[] = []): SourceStatusView {
  return {
    id,
    host_token_env: null,
    webhook_secret_env: null,
    status: { source: id, state: conflicted.length ? 'conflict' : 'idle', ahead: 0, behind: 0, dirty_paths: [], conflicted_paths: conflicted, last_synced_at: null, last_error: null },
    ...over,
  } as SourceStatusView;
}

function queues(counts: Partial<Record<keyof ContentHealthReport['queues'], number>>): Pick<ContentHealthReport, 'queues'> {
  const all = {} as ContentHealthReport['queues'];
  for (const [name, count] of Object.entries(counts)) all[name as keyof ContentHealthReport['queues']] = { count: count ?? 0, items: [] };
  return { queues: all };
}

describe('buildAttention', () => {
  it('is empty when every input is clear or absent', () => {
    expect(buildAttention({})).toEqual([]);
    expect(
      buildAttention({
        system: { verdict: 'healthy', checks: [] },
        sources: [source('main')],
        contentHealth: queues({ stale: 0, lint_failed_inbound: 0, declined_removal_still_deleted: 0, untyped: 4 }),
      }),
    ).toEqual([]);
  });

  it('reports a non-healthy verdict with its reason, linked to System health', () => {
    const [item] = buildAttention({
      system: { verdict: 'degraded', checks: [{ id: 'disk', title: 'Disk', state: 'warn', summary: 's', action: null, link: null }] },
    });
    expect(item).toMatchObject({ id: 'system', tone: 'warn', label: 'System health: Degraded', to: '/admin/health/system' });
    expect(item?.detail).toBeTruthy();
  });

  it('counts open conflicts and names the sources they block', () => {
    const [item] = buildAttention({ sources: [source('main', {}, ['a.md', 'b.md']), source('handbook')] });
    expect(item).toMatchObject({ id: 'conflicts', tone: 'alert', label: '2 open sync conflicts', to: '/admin/repos', search: { source: 'main', tab: 'conflicts' } });
    expect(item?.detail).toContain('main');
    expect(item?.detail).not.toContain('handbook');
  });

  it('counts sources missing a secret only when the server reported presence', () => {
    const items = buildAttention({
      sources: [
        source('a', { host_token_env: 'GH', host_token_present: false }),
        source('b', { host_token_env: 'GH' }),
      ],
    });
    expect(items.map((i) => i.label)).toEqual(['1 source is missing a host token or webhook secret']);
  });

  it('uses only the three content-health queues that mean something went wrong', () => {
    const items = buildAttention({ contentHealth: queues({ lint_failed_inbound: 3, declined_removal_still_deleted: 1, stale: 12, untyped: 40 }) });
    expect(items.map((i) => i.id)).toEqual(['lint', 'declined', 'stale']);
    expect(items.every((i) => i.to === '/admin/health')).toBe(true);
    // Each opens its own queue, not the top of the page.
    expect(items.map((i) => i.search?.queue)).toEqual(['lint_failed_inbound', 'declined_removal_still_deleted', 'stale']);
  });

  it('puts alerts before warnings', () => {
    const items = buildAttention({
      system: { verdict: 'degraded', checks: [] },
      sources: [source('main', {}, ['x.md'])],
      contentHealth: queues({ stale: 1 }),
    });
    expect(items.map((i) => i.id)).toEqual(['conflicts', 'system', 'stale']);
  });
});

describe('queuedTotal', () => {
  it('sums every queue', () => {
    expect(queuedTotal(queues({ stale: 2, untyped: 3 }))).toBe(5);
  });
});

describe('buildShortcutGroups', () => {
  const navHeading = (id: string) => ADMIN_NAV.find((g) => g.id === id)?.heading;

  it('mirrors the nav: its three groups, their headings, and the exact nav labels in nav order', () => {
    const groups = buildShortcutGroups({});
    expect(groups.map((g) => [g.id, g.heading])).toEqual([
      ['people', navHeading('people')],
      ['content', navHeading('content')],
      ['operations', navHeading('operations')],
    ]);
    expect(groups.map((g) => g.shortcuts.map((s) => s.label))).toEqual([
      ['Users', 'Authentication', 'API tokens', 'Audit'],
      ['Topics', 'Categories', 'Tags & groups', 'Sections', 'Files'],
      ['Data', 'Sources', 'Health'],
    ]);
  });

  it('links each shortcut where the nav does, and gives every one a description', () => {
    const shortcuts = buildShortcutGroups({}).flatMap((g) => g.shortcuts);
    expect(Object.fromEntries(shortcuts.map((s) => [s.label, s.to]))).toEqual({
      Users: '/admin/users',
      Authentication: '/admin/auth',
      'API tokens': '/admin/auth/tokens',
      Audit: '/admin/audit',
      Topics: '/admin/topics',
      Categories: '/admin/primary-categories',
      'Tags & groups': '/admin/tags-groups',
      Sections: '/admin/sections',
      Files: '/admin/images',
      Data: '/admin/data',
      Sources: '/admin/repos',
      Health: '/admin/health/system',
    });
    for (const s of shortcuts) expect(s.description, s.id).toMatch(/\S/);
    // Every configured id resolves to a nav entry (none silently dropped).
    expect(shortcuts).toHaveLength(Object.values(OVERVIEW_SHORTCUT_IDS).flat().length);
  });

  it('omits a count that is not known rather than showing a zero', () => {
    const shortcuts = buildShortcutGroups({ tags: 12 }).flatMap((g) => g.shortcuts);
    expect(shortcuts.every((s) => s.status === undefined)).toBe(true);
  });

  it('shows the counts the pages already load, pluralised', () => {
    const status = Object.fromEntries(
      buildShortcutGroups({
        accounts: 1,
        readMode: 'authenticated',
        activeTokens: 3,
        topics: 7,
        categories: 1,
        tags: 12,
        groups: 1,
        sections: 4,
        files: 20,
        orphanedFiles: 2,
        sources: 2,
        openConflicts: 1,
        verdict: 'at_risk',
        queued: 9,
      })
        .flatMap((g) => g.shortcuts)
        .map((s) => [s.id, s.status]),
    );
    expect(status).toEqual({
      users: '1 account',
      'auth-settings': 'Login required to read',
      tokens: '3 active tokens',
      audit: undefined,
      topics: '7 topics',
      categories: '1 category',
      'tags-groups': '12 tags · 1 group',
      sections: '4 sections',
      files: '20 files · 2 orphaned',
      data: undefined,
      sources: '2 sources · 1 open conflict',
      health: 'System: At risk · 9 in fix-it queues',
    });
  });

  it('keeps quiet parts quiet: no orphan or conflict suffix at zero, and Health from the verdict alone', () => {
    const status = Object.fromEntries(
      buildShortcutGroups({ files: 3, orphanedFiles: 0, sources: 1, openConflicts: 0, verdict: 'healthy', readMode: 'public' })
        .flatMap((g) => g.shortcuts)
        .map((s) => [s.id, s.status]),
    );
    expect(status.files).toBe('3 files');
    expect(status.sources).toBe('1 source');
    expect(status.health).toBe('System: Healthy');
    expect(status['auth-settings']).toBe('Content is public');
  });
});
