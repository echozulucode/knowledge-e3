import { describe, expect, it } from 'vitest';
import {
  attentionHeadline,
  buildHealthAttention,
  clearQueuesText,
  contentHealthSearchToParams,
  dataAuditSearch,
  findingTiles,
  queueItemSource,
  queueOverview,
  queuePageCount,
  queuePageRange,
  readContentHealthSearch,
  recentRefusals,
  selectedQueue,
  MIRROR_SECTION_ID,
} from './ContentHealth.model.js';
import type { ContentHealthReport, QueueName } from './queries.js';
import type { MirrorHealth } from './mirrorHealth.js';
import type { RefusalRow } from './refusals.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function queues(counts: Partial<Record<QueueName, number>> = {}): ContentHealthReport['queues'] {
  const names: QueueName[] = [
    'untyped',
    'uncategorized',
    'stale',
    'superseded_without_successor',
    'machine_unverified',
    'drafts_older_than_30d',
    'lint_failed_inbound',
    'declined_removal_still_deleted',
  ];
  return Object.fromEntries(names.map((n) => [n, { count: counts[n] ?? 0, items: [] }])) as unknown as ContentHealthReport['queues'];
}

const CLEAN_MIRROR: MirrorHealth = { stuck_after_ms: 300_000, pending: { count: 0, items: [] }, mirror_errors: { count: 0, items: [] } };

function refusal(id: number, daysAgo: number): RefusalRow {
  return {
    id,
    occurredAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    actor: 'bob',
    source: 'rest',
    sourceLabel: 'REST API',
    operation: 'publish',
    reason: 'lint_failed',
    slug: null,
    title: 'X',
    topic: null,
    rules: [],
  };
}

describe('readContentHealthSearch / contentHealthSearchToParams', () => {
  it('reads topic, queue and page, defaulting anything unrecognised', () => {
    expect(readContentHealthSearch({ topic: 'ops', queue: 'stale', page: 3 })).toEqual({ topic: 'ops', queue: 'stale', page: 3 });
    expect(readContentHealthSearch({ queue: 'nope', page: '0' })).toEqual({ topic: '', queue: null, page: 1 });
    expect(readContentHealthSearch(undefined)).toEqual({ topic: '', queue: null, page: 1 });
    expect(readContentHealthSearch({ page: '2.5' }).page).toBe(1);
  });

  it('writes only what differs from the defaults, page as a number', () => {
    expect(contentHealthSearchToParams({ topic: '', queue: null, page: 1 })).toEqual({});
    expect(contentHealthSearchToParams({ topic: 'ops', queue: 'untyped', page: 2 })).toEqual({ topic: 'ops', queue: 'untyped', page: 2 });
  });

  it('round-trips', () => {
    const state = { topic: 'handbook', queue: 'lint_failed_inbound' as const, page: 4 };
    expect(readContentHealthSearch(contentHealthSearchToParams(state))).toEqual(state);
  });
});

describe('buildHealthAttention', () => {
  it('is empty when nothing is wrong', () => {
    const items = buildHealthAttention({ queues: queues({ untyped: 5, stale: 2 }), sync: { conflicts: 0, sources_in_conflict: [] }, mirror: CLEAN_MIRROR }, [], NOW);
    // Untidy is not urgent: untyped and stale items do not make the strip.
    expect(items).toEqual([]);
  });

  it('lists conflicts and mirror trouble as alerts ahead of queue and refusal warnings', () => {
    const items = buildHealthAttention(
      {
        queues: queues({ lint_failed_inbound: 3, declined_removal_still_deleted: 1 }),
        sync: { conflicts: 2, sources_in_conflict: ['topic:handbook'] },
        mirror: { ...CLEAN_MIRROR, pending: { count: 1, items: [] } },
      },
      [refusal(1, 1), refusal(2, 3), refusal(3, 30)],
      NOW,
    );
    expect(items.map((i) => [i.id, i.tone])).toEqual([
      ['conflicts', 'alert'],
      ['mirror', 'alert'],
      ['queue-lint_failed_inbound', 'warn'],
      ['queue-declined_removal_still_deleted', 'warn'],
      ['refusals', 'warn'],
    ]);
    expect(items[0]).toMatchObject({
      label: '2 open merge conflicts in topic:handbook',
      target: { kind: 'route', to: '/admin/repos', search: { source: 'topic:handbook', tab: 'conflicts' } },
    });
    expect(items[1]).toMatchObject({ label: '1 change not yet in git', target: { kind: 'anchor', id: MIRROR_SECTION_ID } });
    expect(items[2]).toMatchObject({ label: 'Arrived with lint errors (sync or import): 3 items', target: { kind: 'queue', queue: 'lint_failed_inbound' } });
    // Only the two refusals inside the window count; the link is the audit log, filtered.
    expect(items[4]).toMatchObject({ label: '2 publishes refused in the last 7 days', target: { kind: 'route', to: '/admin/audit', search: { action: 'content.refused' } } });
  });

  it('sends several conflicted sources to the filtered list', () => {
    const [item] = buildHealthAttention({ queues: queues(), sync: { conflicts: 3, sources_in_conflict: ['a', 'b'] } }, [], NOW);
    expect(item).toMatchObject({ label: '3 open merge conflicts in 2 sources', target: { search: { state: 'attention' } } });
  });

  it('names both halves of a mirror alert', () => {
    const [item] = buildHealthAttention({ queues: queues(), mirror: { ...CLEAN_MIRROR, pending: { count: 2, items: [] }, mirror_errors: { count: 1, items: [] } } }, [], NOW);
    expect(item!.label).toBe('2 changes not yet in git · 1 mirror error');
  });
});

describe('attentionHeadline', () => {
  it('counts in words', () => {
    expect(attentionHeadline(0)).toBe('Nothing needs attention');
    expect(attentionHeadline(1)).toBe('1 thing needs attention');
    expect(attentionHeadline(3)).toBe('3 things need attention');
  });
});

describe('recentRefusals', () => {
  it('keeps only the last 7 days and ignores unparseable dates', () => {
    const rows = [refusal(1, 0.5), refusal(2, 6.9), refusal(3, 7.1), { ...refusal(4, 0), occurredAt: 'garbage' }];
    expect(recentRefusals(rows, NOW).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('findingTiles', () => {
  it('colours by tier and says the status in words, linking to Data → Audit for the topic', () => {
    const tiles = findingTiles({ conformant: true, conformance: 0, policy: 4, advisories: 12 }, 'ops');
    expect(tiles.map((t) => [t.id, t.count, t.tone, t.status])).toEqual([
      ['conformance', 0, 'ok', 'Conformant'],
      ['policy', 4, 'warn', 'Below standard'],
      ['advisories', 12, 'info', 'Never blocks'],
    ]);
    expect(tiles.every((t) => t.search.tab === 'audit' && t.search.topic === 'ops')).toBe(true);
  });

  it('marks conformance an error whenever the library is not conformant', () => {
    const [conformance] = findingTiles({ conformant: false, conformance: 2, policy: 0, advisories: 0 }, '');
    expect(conformance).toMatchObject({ tone: 'error', status: 'Must fix', search: { tab: 'audit' } });
    expect(dataAuditSearch('')).toEqual({ tab: 'audit' });
  });
});

describe('queueOverview / clearQueuesText / selectedQueue', () => {
  it('splits open queues from clear ones in declared order', () => {
    const overview = queueOverview(queues({ stale: 2, untyped: 1 }));
    expect(overview.open).toEqual([
      { name: 'untyped', count: 1 },
      { name: 'stale', count: 2 },
    ]);
    expect(overview.clear).toHaveLength(6);
    // A server that predates a queue omits it: clear, not a crash.
    expect(queueOverview({ untyped: { count: 1 } }).clear).toHaveLength(7);
  });

  it('words the collapsed line', () => {
    expect(clearQueuesText(6)).toBe('6 queues clear');
    expect(clearQueuesText(1)).toBe('1 queue clear');
    expect(clearQueuesText(8)).toBe('All 8 queues clear');
  });

  it('opens the URL queue, else the first open queue, else none', () => {
    const overview = queueOverview(queues({ stale: 2, lint_failed_inbound: 1 }));
    expect(selectedQueue('untyped', overview)).toBe('untyped');
    expect(selectedQueue(null, overview)).toBe('stale');
    expect(selectedQueue(null, queueOverview(queues()))).toBeNull();
  });
});

describe('queueItemSource', () => {
  it('prefers the lint row door, then the item source', () => {
    expect(queueItemSource({ lint: { source_id: 'topic:handbook', path: 'a.md', detected_at: '', diagnostics: [], diagnostics_total: 0 } })).toBe('topic:handbook');
    expect(queueItemSource({ lint: { source_id: 'okf-import', path: 'a.md', detected_at: '', diagnostics: [], diagnostics_total: 0 } })).toBe('OKF import');
    expect(queueItemSource({ source: { id: 'main', role: 'authoritative', mode: 'direct' } })).toBe('main');
    expect(queueItemSource({})).toBeNull();
  });
});

describe('queuePageCount / queuePageRange', () => {
  it('pages a queue of 50 at a time', () => {
    expect(queuePageCount(0)).toBe(1);
    expect(queuePageCount(50)).toBe(1);
    expect(queuePageCount(51)).toBe(2);
    expect(queuePageRange(0, 50, 120)).toBe('1–50 of 120');
    expect(queuePageRange(100, 20, 120)).toBe('101–120 of 120');
    expect(queuePageRange(150, 0, 120)).toBe('0 of 120');
  });
});
