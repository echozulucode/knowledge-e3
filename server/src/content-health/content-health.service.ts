/**
 * Admin → Health → Content (plan §6.3): the existing OKF audit plus E3-level
 * work queues, so "keeping organized" is a list of items to fix rather than a
 * policy document. Everything is derived on request from frontmatter and the
 * page rows; nothing is stored.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import { deriveDisplayState } from '@echozedlabs/content-model';
import type { DiagnosticSeverity, ItemSummary } from '@echozedlabs/knowledge-types';
import { auditBundle, summarizeBundleSignals, type SignalSummary } from '@echozedlabs/okf';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { OkfExportService } from '../okf/okf-export.service.js';
import { displayStateFromColumns, reviewRefFrom } from '../pages/lifecycle-columns.js';
import { PagesService, type PageView, type ReadActor } from '../pages/pages.service.js';
import { mirrorHealth, type MirrorHealth } from './mirror-health.js';

const SCAN_LIMIT = 100_000;
/** Members each queue carries in the whole report, and the default page size of `queuePage`. */
export const QUEUE_CAP = 50;
/**
 * The largest page `queuePage` serves. A queue can hold the whole library; a
 * page is a screenful an admin works through, and the lint queue parses stored
 * diagnostics per member, so an unbounded `limit` would be the report's cost again.
 */
export const QUEUE_PAGE_MAX = 200;
const DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Diagnostics carried per `lint_failed_inbound` row. A file can trip every rule
 * the lint has; fifty rows of that would make the report as large as the
 * library. The first ten (errors first) name the fix, and `diagnostics_total`
 * says how many more are waiting behind them.
 */
export const LINT_DIAGNOSTICS_CAP = 10;

export const QUEUE_NAMES = [
  'untyped',
  'uncategorized',
  'stale',
  'superseded_without_successor',
  'machine_unverified',
  'drafts_older_than_30d',
  'lint_failed_inbound',
  'declined_removal_still_deleted',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * One diagnostic as the lint queue carries it: the stored `Diagnostic` minus
 * its machine-applicable `fix`. `path` is the frontmatter KEY the rule points
 * at (the lint's own name for it), not the file — the file is on the parent.
 */
export interface LintQueueDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
}

/**
 * Where a `lint_failed_inbound` member came from and what the lint said (plan
 * B4), read from its uncleared `sync_diagnostics` row. `source_id` is a
 * registry id for a file that arrived through sync, or the OKF import door's
 * constant for a bundle an admin imported.
 */
export interface InboundLint {
  source_id: string;
  /** Repository-relative path of the file, as the row recorded it. */
  path: string;
  detected_at: string;
  /** At most `LINT_DIAGNOSTICS_CAP`, error-severity first. */
  diagnostics: LintQueueDiagnostic[];
  /** How many the row holds in all; more than `diagnostics.length` means some were left off. */
  diagnostics_total: number;
}

/** A queue member. Only `lint_failed_inbound` members carry `lint`. */
export type HealthQueueItem = ItemSummary & { lint?: InboundLint };

export interface HealthQueue {
  count: number;
  /** The first `QUEUE_CAP` members; `count` is the full size. */
  items: HealthQueueItem[];
}

/**
 * One page of one queue (`GET /admin/health/content/queues/:queue`). `count` is
 * the queue's full size, as in the report; `total` repeats it under the name
 * every other paged admin list uses, so a pager reads the same field everywhere.
 */
export interface HealthQueuePage {
  queue: QueueName;
  count: number;
  total: number;
  offset: number;
  limit: number;
  items: HealthQueueItem[];
}

/** Every queue's FULL member list, before any cap or page is taken. */
type QueueMembers = Record<QueueName, ItemSummary[]>;

export interface ContentHealthReport {
  totals: { items: number; published: number; drafts: number };
  audit: { conformant: boolean; conformance: number; policy: number; advisories: number };
  signals: SignalSummary;
  queues: Record<QueueName, HealthQueue>;
  /** Sync engine trouble (plan §8.1): open merge conflicts and the sources they block. */
  sync: { conflicts: number; sources_in_conflict: string[] };
  /**
   * Git-mirror durability (issue 88): content that is indexed but whose commit
   * has not been confirmed. Instance-wide, like `sync` — see mirror-health.ts.
   */
  mirror: MirrorHealth;
}

@Injectable()
export class ContentHealthService {
  constructor(
    private readonly pages: PagesService,
    private readonly exporter: OkfExportService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  /** `actor` is the admin making the request (so drafts are included). */
  async report(actor: ReadActor, topic?: string): Promise<ContentHealthReport> {
    const now = new Date();
    const [pages, exported] = await Promise.all([
      this.pages.list({ space: topic, limit: SCAN_LIMIT }, actor),
      this.exporter.export(actor, { space: topic }),
    ]);
    const audit = auditBundle(exported.bundle);
    const signals = summarizeBundleSignals(exported.bundle);

    const summaries = pages.map(toSummary);
    const { members, lint } = await this.queueMembers(summaries, topic, now);
    const conflicts = await this.openConflicts();
    const mirror = await mirrorHealth(this.db, now);
    const queues = Object.fromEntries(
      QUEUE_NAMES.map((name) => [name, slice(members[name], 0, QUEUE_CAP, lintFor(name, lint))]),
    ) as Record<QueueName, HealthQueue>;

    const published = summaries.filter((s) => s.status === 'published').length;
    return {
      totals: { items: summaries.length, published, drafts: summaries.length - published },
      audit: {
        conformant: audit.conformant,
        conformance: audit.conformance.length,
        policy: audit.policy.length,
        advisories: audit.advisories.length,
      },
      signals,
      queues,
      sync: conflicts,
      mirror,
    };
  }

  /**
   * One page of one queue, past the report's first `QUEUE_CAP` (review §4.9:
   * the queue table pages instead of stopping at 50). The same membership rules
   * as the report — both read `queueMembers` — without the OKF export and audit
   * the report pays for, which a page of a queue never needs.
   */
  async queuePage(
    actor: ReadActor,
    name: QueueName,
    opts: { topic?: string; offset?: number; limit?: number } = {},
  ): Promise<HealthQueuePage> {
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? QUEUE_CAP, QUEUE_PAGE_MAX);
    const pages = await this.pages.list({ space: opts.topic, limit: SCAN_LIMIT }, actor);
    const { members, lint } = await this.queueMembers(pages.map(toSummary), opts.topic, new Date());
    const page = slice(members[name], offset, limit, lintFor(name, lint));
    return { queue: name, count: page.count, total: page.count, offset, limit, items: page.items };
  }

  /**
   * Every queue's members in full, and the lint rows the lint queue's members
   * carry. Visibility and the topic filter come in through `summaries` (the
   * listed pages); the declined-removal queue, whose rows `list` cannot see,
   * applies the topic itself.
   */
  private async queueMembers(
    summaries: ItemSummary[],
    topic: string | undefined,
    now: Date,
  ): Promise<{ members: QueueMembers; lint: Map<string, InboundLint> }> {
    const flagged = await this.flaggedByIndex(now);
    const lint = await this.lintFailedInbound();
    const declinedRemovals = await this.declinedRemovalsStillDeleted(topic);
    const draftCutoff = now.getTime() - DRAFT_AGE_MS;
    const members: QueueMembers = {
      untyped: summaries.filter((s) => s.type === null),
      uncategorized: summaries.filter((s) => (s.categories ?? []).length === 0),
      stale: summaries.filter((s) => flagged.stale.has(s.id)),
      superseded_without_successor: summaries.filter((s) => flagged.supersededWithoutSuccessor.has(s.id)),
      machine_unverified: summaries.filter((s) => flagged.machineUnverified.has(s.id)),
      drafts_older_than_30d: summaries.filter((s) => s.status === 'draft' && Date.parse(s.updated_at) < draftCutoff),
      lint_failed_inbound: summaries.filter((s) => lint.has(s.id)),
      declined_removal_still_deleted: declinedRemovals,
    };
    return { members, lint };
  }

  /**
   * Issue 96 backstop: a soft delete in a `review` source proposes the file's
   * removal upstream, and a reviewer who DECLINES it is saying the item should
   * come back — `ReviewService.reconcile` restores it from the base-branch file.
   * That restore is best-effort by design (it must never break a sync cycle), so
   * this queue is what keeps a failure from being silent: a row still carrying
   * `deleted_at` once its change request settled as `closed` is an item this
   * instance deleted that its own git history still holds. Causes are all
   * admin-shaped — the file is gone from the base branch too, the working tree
   * could not be read, the source lost its host configuration — so the row is
   * surfaced rather than retried.
   *
   * Built straight from `pages` because the rows are deleted and therefore
   * invisible to `pages.list`, which is where every other queue's members come
   * from. The topic filter is applied the same way `list` applies it (id or
   * slug), so a scoped Content health report stays scoped.
   */
  private async declinedRemovalsStillDeleted(topic?: string): Promise<ItemSummary[]> {
    let q = this.db
      .selectFrom('pages')
      .selectAll()
      .where('review_state', '=', 'closed')
      .where('deleted_at', 'is not', null);
    if (topic) {
      const space = await this.db
        .selectFrom('spaces')
        .select('id')
        .where((eb) => eb.or([eb('id', '=', topic), eb('slug', '=', topic)]))
        .executeTakeFirst();
      q = q.where('space_id', '=', space?.id ?? '__no_such_space__');
    }
    const rows = await q.orderBy('review_closed_at', 'desc').execute();
    return rows.map(deletedRowSummary);
  }

  /**
   * Pages whose last inbound file failed the lint (`sync_diagnostics`, not yet
   * cleared by a clean version), each with the row that put it there. Both
   * doors write this table — git sync and the OKF import — so the row, not the
   * door, is what the queue reports.
   *
   * One page normally has one uncleared row (a new one clears its path's old
   * one). A page that moved paths between two failing versions can briefly
   * hold two; the newest is the one describing the file as it is now.
   */
  private async lintFailedInbound(): Promise<Map<string, InboundLint>> {
    const rows = await this.db
      .selectFrom('sync_diagnostics')
      .select(['page_id', 'source_id', 'path', 'diagnostics_json', 'detected_at'])
      .where('cleared_at', 'is', null)
      .where('page_id', 'is not', null)
      .orderBy('detected_at', 'asc')
      .execute();
    const byPage = new Map<string, InboundLint>();
    for (const r of rows) byPage.set(r.page_id!, inboundLintFrom(r));
    return byPage;
  }

  private async openConflicts(): Promise<{ conflicts: number; sources_in_conflict: string[] }> {
    const rows = await this.db
      .selectFrom('sync_conflicts')
      .select('source_id')
      .where('resolved_at', 'is', null)
      .execute();
    return { conflicts: rows.length, sources_in_conflict: [...new Set(rows.map((r) => r.source_id))].sort() };
  }

  /**
   * The lifecycle/trust queues come from the indexed `pages` columns (plan
   * §7.4), not from re-deriving every item's frontmatter. Visibility and the
   * topic filter are still applied by intersecting with the listed pages.
   */
  private async flaggedByIndex(now: Date): Promise<{
    stale: Set<string>;
    supersededWithoutSuccessor: Set<string>;
    machineUnverified: Set<string>;
  }> {
    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'status', 'lifecycle_status', 'stale_after', 'trust_tier', 'generated_by', 'superseded_by'])
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('stale_after', 'is not', null),
          eb('lifecycle_status', '=', 'deprecated'),
          eb.and([eb('trust_tier', '=', 'unverified'), eb('generated_by', 'is not', null)]),
        ]),
      )
      .execute();
    return {
      stale: new Set(rows.filter((r) => displayStateFromColumns(r, now) === 'needs-review').map((r) => r.id)),
      supersededWithoutSuccessor: new Set(rows.filter((r) => r.lifecycle_status === 'deprecated' && !r.superseded_by).map((r) => r.id)),
      machineUnverified: new Set(
        rows.filter((r) => /^(process|agent):/.test(r.generated_by ?? '') && r.trust_tier === 'unverified').map((r) => r.id),
      ),
    };
  }
}

/**
 * A window of a queue's members, with the lint queue's diagnostics attached
 * AFTER the window is taken — so the parse runs for the rows the response
 * ships and not for every flagged item in the library.
 */
/**
 * Only the lint queue's members carry `lint`. An untyped item can hold an
 * uncleared diagnostics row too, and it is still not the lint queue's to show.
 */
function lintFor(name: QueueName, lint: Map<string, InboundLint>): Map<string, InboundLint> {
  return name === 'lint_failed_inbound' ? lint : new Map();
}

function slice(members: ItemSummary[], offset: number, limit: number, lint: Map<string, InboundLint>): HealthQueue {
  return {
    count: members.length,
    items: members
      .slice(offset, offset + limit)
      .map((item) => (lint.has(item.id) ? { ...item, lint: lint.get(item.id)! } : item)),
  };
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/**
 * A `sync_diagnostics` row → the queue's view of it. `diagnostics_json` is
 * stored text written by whichever server version recorded it, so reading it
 * never throws: malformed JSON, a non-array, or an entry without a code simply
 * contributes nothing, and the row still names its source and file.
 */
export function inboundLintFrom(row: { source_id: string; path: string; diagnostics_json: string; detected_at: string }): InboundLint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.diagnostics_json);
  } catch {
    parsed = [];
  }
  const all: LintQueueDiagnostic[] = [];
  for (const d of Array.isArray(parsed) ? parsed : []) {
    if (!d || typeof d !== 'object') continue;
    const { code, severity, message, path } = d as Record<string, unknown>;
    if (typeof code !== 'string' || !code) continue;
    all.push({
      code,
      severity: severity === 'warning' || severity === 'info' ? severity : 'error',
      message: typeof message === 'string' ? message : '',
      ...(typeof path === 'string' && path ? { path } : {}),
    });
  }
  // Stable sort: within a severity the lint's own order is kept.
  const ordered = all
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (SEVERITY_RANK[a.d.severity] ?? 3) - (SEVERITY_RANK[b.d.severity] ?? 3) || a.i - b.i)
    .map(({ d }) => d);
  return {
    source_id: row.source_id,
    path: row.path,
    detected_at: row.detected_at,
    diagnostics: ordered.slice(0, LINT_DIAGNOSTICS_CAP),
    diagnostics_total: ordered.length,
  };
}

/**
 * A summary for a row that is soft-deleted, and so has no `PageView` to derive
 * from — no current version, no frontmatter, no taxonomy. Only the indexed
 * columns are available, which is enough to identify the item and, through
 * `review`, to link an admin straight to the change request that was declined.
 */
function deletedRowSummary(row: Selectable<Database['pages']>): ItemSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    type: row.type,
    space_id: row.space_id,
    updated_at: row.updated_at,
    published_at: row.published_at,
    lifecycle_status: (row.lifecycle_status as ItemSummary['lifecycle_status']) ?? undefined,
    trust_tier: (row.trust_tier as ItemSummary['trust_tier']) ?? undefined,
    stale_after: row.stale_after,
    last_verified_at: row.last_verified_at,
    generated_by: row.generated_by,
    superseded_by: row.superseded_by,
    review: reviewRefFrom(row),
  };
}

function toSummary(page: PageView): ItemSummary {
  const description = page.frontmatter['description'];
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    type: page.type,
    space_id: page.space_id,
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    updated_at: page.updated_at,
    published_at: page.published_at,
    tags: page.tags,
    categories: page.categories,
    groups: page.groups,
    // Where the item's file lives: the queue table's Source column (review §4.9).
    source: page.source,
    ...deriveDisplayState(page.frontmatter, page.status),
  };
}
