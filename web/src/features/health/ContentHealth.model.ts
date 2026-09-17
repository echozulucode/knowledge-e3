/**
 * What Content health leads with and how it arranges itself
 * (the admin UX review §4.9), decided without React or the network
 * so what does and does not make the attention strip — and which queues fold
 * away — is unit-tested.
 *
 * The page used to open with inventory (six equal stat boxes) and every queue
 * as an equal disclosure, clear or not. The order is now: what needs attention,
 * the audit findings (linked to their one home on Data → Audit, review §6
 * decision 4), quieter library counts, then only the queues that hold something.
 */
import { QUEUE_LABELS, QUEUE_NAMES, QUEUE_PAGE_SIZE, type ContentHealthReport, type HealthQueueItem, type QueueName } from './queries.js';
import { mirrorAlert } from './mirrorHealth.js';
import { REFUSED_ACTION, type RefusalRow } from './refusals.js';
import { inboundDoorLabel } from './lintQueue.js';

/* ------------------------------------------------------------------ URL state */

export interface ContentHealthSearch {
  /** Topic slug; '' is All topics. */
  topic: string;
  /** The queue whose table is open; null lets the page pick the first non-empty one. */
  queue: QueueName | null;
  /** 1-based page of that queue's table. */
  page: number;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** The page's state from the query string; anything unrecognised reads as its default. */
export function readContentHealthSearch(search: Record<string, unknown> | undefined): ContentHealthSearch {
  const s = search ?? {};
  const queue = str(s['queue']);
  const page = Number(str(s['page']) ?? '1');
  return {
    topic: str(s['topic'])?.trim() ?? '',
    queue: queue && (QUEUE_NAMES as readonly string[]).includes(queue) ? (queue as QueueName) : null,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/**
 * The query string for a state, defaults dropped. `page` is a NUMBER: TanStack
 * Router JSON-quotes a string that parses as JSON (`?page=%222%22`).
 */
export function contentHealthSearchToParams(state: ContentHealthSearch): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (state.topic) out['topic'] = state.topic;
  if (state.queue) out['queue'] = state.queue;
  if (state.page > 1) out['page'] = state.page;
  return out;
}

/* ------------------------------------------------------------ attention strip */

/**
 * Queues whose members are something broken rather than something untidy: a
 * file that arrived failing the rules, and a removal the reviewer declined that
 * is still deleted here. An untyped item is worth fixing; it is not an alarm.
 */
export const HIGH_SEVERITY_QUEUES: readonly QueueName[] = ['lint_failed_inbound', 'declined_removal_still_deleted'];

/** How far back a refusal still counts as news. Older ones are history, and the audit log holds history. */
export const RECENT_REFUSAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type HealthAttentionTarget =
  /** Another admin page, optionally deep-linked. */
  | { kind: 'route'; to: string; search?: Record<string, string> }
  /** A queue on this page: opens its table. */
  | { kind: 'queue'; queue: QueueName }
  /** A section further down this page, by element id. */
  | { kind: 'anchor'; id: string };

export interface HealthAttentionItem {
  id: string;
  tone: 'warn' | 'alert';
  /** The link text: what is wrong, with its count. */
  label: string;
  target: HealthAttentionTarget;
}

/** The element id of the Git mirror section, which the mirror attention item scrolls to. */
export const MIRROR_SECTION_ID = 'content-health-mirror';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Refusals no older than the window, newest first as the log returns them. */
export function recentRefusals(rows: readonly RefusalRow[], now: number = Date.now()): RefusalRow[] {
  return rows.filter((r) => {
    const at = Date.parse(r.occurredAt);
    return Number.isFinite(at) && now - at <= RECENT_REFUSAL_WINDOW_MS;
  });
}

/**
 * The strip's items, worst first: open merge conflicts and an unconfirmed git
 * mirror (alerts), then non-empty high-severity queues and recent refusals
 * (warnings). Each points at where the thing is fixed. Absent inputs contribute
 * nothing — the page does not render the strip until the report has loaded.
 */
export function buildHealthAttention(
  report: Pick<ContentHealthReport, 'queues' | 'sync' | 'mirror'>,
  refusals: readonly RefusalRow[] = [],
  now: number = Date.now(),
): HealthAttentionItem[] {
  const items: HealthAttentionItem[] = [];

  const sync = report.sync;
  if (sync && sync.conflicts > 0) {
    const blocked = sync.sources_in_conflict;
    items.push({
      id: 'conflicts',
      tone: 'alert',
      label: `${plural(sync.conflicts, 'open merge conflict', 'open merge conflicts')} in ${blocked.length === 1 ? blocked[0] : plural(blocked.length, 'source', 'sources')}`,
      target: {
        kind: 'route',
        to: '/admin/repos',
        // One blocked source: straight to its Conflicts tab. Several: the list, filtered.
        search: blocked.length === 1 ? { source: blocked[0]!, tab: 'conflicts' } : { state: 'attention' },
      },
    });
  }

  if (report.mirror && mirrorAlert(report.mirror).tone === 'alert') {
    const pending = report.mirror.pending.count;
    const errors = report.mirror.mirror_errors.count;
    const parts = [
      pending > 0 ? plural(pending, 'change not yet in git', 'changes not yet in git') : null,
      errors > 0 ? plural(errors, 'mirror error', 'mirror errors') : null,
    ].filter(Boolean);
    items.push({ id: 'mirror', tone: 'alert', label: parts.join(' · '), target: { kind: 'anchor', id: MIRROR_SECTION_ID } });
  }

  for (const name of HIGH_SEVERITY_QUEUES) {
    const count = report.queues[name]?.count ?? 0;
    if (count > 0) {
      items.push({ id: `queue-${name}`, tone: 'warn', label: `${QUEUE_LABELS[name]}: ${plural(count, 'item', 'items')}`, target: { kind: 'queue', queue: name } });
    }
  }

  const recent = recentRefusals(refusals, now).length;
  if (recent > 0) {
    items.push({
      id: 'refusals',
      tone: 'warn',
      label: `${plural(recent, 'publish', 'publishes')} refused in the last 7 days`,
      target: { kind: 'route', to: '/admin/audit', search: { action: REFUSED_ACTION } },
    });
  }

  return items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'alert' ? -1 : 1));
}

/** "Nothing needs attention", "1 thing needs attention", "3 things need attention". */
export function attentionHeadline(count: number): string {
  if (count === 0) return 'Nothing needs attention';
  return count === 1 ? '1 thing needs attention' : `${count.toLocaleString('en-US')} things need attention`;
}

/* ------------------------------------------------------------------- findings */

export type FindingTone = 'ok' | 'info' | 'warn' | 'error';

export interface FindingTile {
  id: 'conformance' | 'policy' | 'advisories';
  label: string;
  count: number;
  tone: FindingTone;
  /** The status in words, so the tile never relies on its colour (§3.3). */
  status: string;
  /** Where the findings themselves are listed: Data → Audit, for the same topic. */
  search: Record<string, string>;
}

/** The query string of Data's Audit tab for a topic ('' = the whole library). */
export function dataAuditSearch(topic: string): Record<string, string> {
  return topic ? { tab: 'audit', topic } : { tab: 'audit' };
}

/**
 * The three audit tiers as tiles. Conformance is the only tier that makes a
 * bundle non-conformant, so only it can be an error; policy findings are this
 * instance's standard (warn); advisories never block (info).
 */
export function findingTiles(audit: ContentHealthReport['audit'], topic: string): FindingTile[] {
  const search = dataAuditSearch(topic);
  return [
    {
      id: 'conformance',
      label: 'Conformance findings',
      count: audit.conformance,
      tone: audit.conformance > 0 || !audit.conformant ? 'error' : 'ok',
      status: audit.conformance > 0 || !audit.conformant ? 'Must fix' : 'Conformant',
      search,
    },
    { id: 'policy', label: 'Policy findings', count: audit.policy, tone: audit.policy > 0 ? 'warn' : 'ok', status: audit.policy > 0 ? 'Below standard' : 'Meets policy', search },
    { id: 'advisories', label: 'Advisories', count: audit.advisories, tone: audit.advisories > 0 ? 'info' : 'ok', status: audit.advisories > 0 ? 'Never blocks' : 'None', search },
  ];
}

/* --------------------------------------------------------------------- queues */

export interface QueueOverview {
  /** Queues holding at least one member, in the declared order. */
  open: { name: QueueName; count: number }[];
  /** Queues with nothing in them (or that the server did not report). */
  clear: QueueName[];
}

export function queueOverview(queues: Partial<Record<QueueName, { count: number } | undefined>>): QueueOverview {
  const open: QueueOverview['open'] = [];
  const clear: QueueName[] = [];
  for (const name of QUEUE_NAMES) {
    const count = queues[name]?.count ?? 0;
    if (count > 0) open.push({ name, count });
    else clear.push(name);
  }
  return { open, clear };
}

/** "6 queues clear", "1 queue clear", "All 8 queues clear". */
export function clearQueuesText(clear: number, total: number = QUEUE_NAMES.length): string {
  if (clear === total) return `All ${total} queues clear`;
  return clear === 1 ? '1 queue clear' : `${clear} queues clear`;
}

/**
 * The queue whose table is open: the one in the URL when it names one (an empty
 * queue named by a link still opens, to say it is clear), else the first queue
 * holding something, else none.
 */
export function selectedQueue(requested: QueueName | null, overview: QueueOverview): QueueName | null {
  if (requested) return requested;
  return overview.open[0]?.name ?? null;
}

/**
 * The Source column: the door a lint-queue member came through (its
 * `sync_diagnostics` row), else the registry source its file lives in, else
 * nothing (an item written before the registry existed).
 */
export function queueItemSource(item: Pick<HealthQueueItem, 'lint' | 'source'>): string | null {
  if (item.lint && typeof item.lint.source_id === 'string') return inboundDoorLabel(item.lint.source_id).replace(/^Sync from /, '');
  return item.source?.id ?? null;
}

/** Pages in a queue of `total` members; at least one, so "page 1 of 1" is never "of 0". */
export function queuePageCount(total: number, pageSize: number = QUEUE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** "51–100 of 180" for the queue pager; "0 of 180" for a page past the end. */
export function queuePageRange(offset: number, count: number, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (total === 0 || count === 0) return `0 of ${fmt(total)}`;
  return `${fmt(offset + 1)}–${fmt(offset + count)} of ${fmt(total)}`;
}
