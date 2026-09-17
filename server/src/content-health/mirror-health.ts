/**
 * Mirror health (issue 88): make a lost git-mirror event self-diagnosing.
 *
 * The write-first path (plan §7.3) writes the canonical file, indexes it, and
 * enqueues a `content_outbox` row in the same transaction; the git mirror
 * drains that outbox and marks the rows processed once the commit is confirmed.
 * A row that stays `processed_at IS NULL` therefore means "indexed, but not yet
 * durable in git". `OutboxReplayService` re-emits those rows at the next boot,
 * which is precisely why the intermittent drop reported in issue 88 was never
 * noticed: the evidence healed itself on restart. This module surfaces the
 * evidence *before* the restart, so the next occurrence leaves a trail.
 *
 * Two halves of one symptom are reported:
 *   - `pending`  — outbox rows stuck past the threshold, each carrying the
 *                  mirror state it does (or does NOT) have. A row whose page
 *                  has no `revision_mirror_state` entry at all is the exact
 *                  failure issue 88 describes, so the join is a LEFT join and
 *                  such a row reports `mirror_state: 'missing'`.
 *   - `mirror_errors` — pages whose `revision_mirror_state` carries an `error`,
 *                  or has been `dirty` past the same threshold, even when their
 *                  outbox row was already marked processed.
 *
 * Everything is derived on request; nothing is stored.
 */
import type { Kysely } from 'kysely';
import type { ContentOutboxTable, Database } from '../db/schema.js';

/**
 * How long a row may stay pending before it counts as stuck.
 *
 * The committer coalesces writes with a 2 s quiet period and a 15 s hard cap
 * (`git-revision-mirror.adapter.ts` DEFAULT_QUIET_MS / DEFAULT_MAX_MS), so a
 * healthy row is processed within seconds. Five minutes is twenty times that
 * hard cap — long enough that a slow push, a retry, or a busy host never trips
 * it, short enough that an operator sees the alert in the session where the
 * write happened rather than only after a restart has replayed it away.
 */
export const MIRROR_STUCK_MS = 5 * 60 * 1000;

/** Same cap as the content queues: report the first `MIRROR_LIST_CAP`, count them all. */
export const MIRROR_LIST_CAP = 50;

/** What the mirror knows about a stuck row's page. `missing` is the issue-88 shape. */
export type MirrorStateKind = 'missing' | 'error' | 'dirty' | 'clean';

/** A `content_outbox` row that has been pending longer than {@link MIRROR_STUCK_MS}. */
export interface StuckOutboxItem {
  outbox_id: string;
  page_id: string;
  /** Null when the page row is gone (deleted since the write). */
  slug: string | null;
  title: string | null;
  kind: ContentOutboxTable['kind'];
  /** From the outbox row, falling back to the page's indexed columns. */
  source_id: string | null;
  file_path: string | null;
  created_at: string;
  /** Whole seconds pending, as of the request. */
  age_seconds: number;
  /** The outbox row's own `error`, if the drain recorded one. */
  error: string | null;
  /** `missing` = no `revision_mirror_state` row at all — the reported failure. */
  mirror_state: MirrorStateKind;
  mirror_error: string | null;
  last_commit: string | null;
}

/** A `revision_mirror_state` row that is erroring, or dirty past the threshold. */
export interface MirrorErrorItem {
  page_id: string;
  slug: string | null;
  title: string | null;
  /** Backend-local path of the mirrored artifact. */
  path: string | null;
  dirty: boolean;
  error: string | null;
  updated_at: string;
  /** Whole seconds since the mirror state was last touched. */
  age_seconds: number;
  last_commit: string | null;
}

export interface MirrorHealth {
  /** The bound, in ms, that both halves use — so a client can word the alert. */
  stuck_after_ms: number;
  /** Outbox rows indexed but not yet durable in git. */
  pending: { count: number; items: StuckOutboxItem[] };
  /** Mirror states carrying an error, or dirty past the bound. */
  mirror_errors: { count: number; items: MirrorErrorItem[] };
}

function ageSeconds(from: string, now: Date): number {
  const started = Date.parse(from);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((now.getTime() - started) / 1000));
}

function mirrorStateKind(row: { mirror_page_id: string | null; mirror_error: string | null; dirty: number | null }): MirrorStateKind {
  if (row.mirror_page_id === null) return 'missing';
  if (row.mirror_error) return 'error';
  return row.dirty ? 'dirty' : 'clean';
}

/**
 * Mirror health for the whole instance. Like the `sync` summary it is NOT
 * narrowed by the topic filter: durability is an instance-level property, and
 * narrowing would hide exactly the orphaned rows this is meant to expose.
 */
export async function mirrorHealth(db: Kysely<Database>, now: Date, stuckAfterMs = MIRROR_STUCK_MS): Promise<MirrorHealth> {
  const cutoff = new Date(now.getTime() - stuckAfterMs).toISOString();
  const [pending, mirrorErrors] = await Promise.all([
    stuckPending(db, now, cutoff),
    erroringMirrors(db, now, cutoff),
  ]);
  return { stuck_after_ms: stuckAfterMs, pending, mirror_errors: mirrorErrors };
}

async function stuckPending(
  db: Kysely<Database>,
  now: Date,
  cutoff: string,
): Promise<{ count: number; items: StuckOutboxItem[] }> {
  const base = db
    .selectFrom('content_outbox as o')
    .where('o.processed_at', 'is', null)
    .where('o.created_at', '<', cutoff);

  const counted = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();

  const rows = await base
    // LEFT joins on purpose: a page deleted since the write, and — the issue-88
    // failure — a page with no mirror state at all, must both still be listed.
    .leftJoin('pages as p', 'p.id', 'o.page_id')
    .leftJoin('revision_mirror_state as m', 'm.page_id', 'o.page_id')
    .select([
      'o.id as outbox_id',
      'o.page_id as page_id',
      'o.kind as kind',
      'o.source_id as outbox_source_id',
      'o.file_path as outbox_file_path',
      'o.created_at as created_at',
      'o.error as error',
      'p.slug as slug',
      'p.title as title',
      'p.source_id as page_source_id',
      'p.file_path as page_file_path',
      'm.page_id as mirror_page_id',
      'm.dirty as dirty',
      'm.error as mirror_error',
      'm.last_commit as last_commit',
    ])
    .orderBy('o.created_at', 'asc')
    .limit(MIRROR_LIST_CAP)
    .execute();

  return {
    count: Number(counted?.n ?? rows.length),
    items: rows.map((r) => ({
      outbox_id: r.outbox_id,
      page_id: r.page_id,
      slug: r.slug ?? null,
      title: r.title ?? null,
      kind: r.kind,
      source_id: r.outbox_source_id ?? r.page_source_id ?? null,
      file_path: r.outbox_file_path ?? r.page_file_path ?? null,
      created_at: r.created_at,
      age_seconds: ageSeconds(r.created_at, now),
      error: r.error ?? null,
      mirror_state: mirrorStateKind(r),
      mirror_error: r.mirror_error ?? null,
      last_commit: r.last_commit ?? null,
    })),
  };
}

async function erroringMirrors(
  db: Kysely<Database>,
  now: Date,
  cutoff: string,
): Promise<{ count: number; items: MirrorErrorItem[] }> {
  const base = db
    .selectFrom('revision_mirror_state as m')
    .where((eb) =>
      eb.or([
        eb('m.error', 'is not', null),
        eb.and([eb('m.dirty', '!=', 0), eb('m.updated_at', '<', cutoff)]),
      ]),
    );

  const counted = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();

  const rows = await base
    .leftJoin('pages as p', 'p.id', 'm.page_id')
    .select([
      'm.page_id as page_id',
      'm.path as path',
      'm.dirty as dirty',
      'm.error as error',
      'm.updated_at as updated_at',
      'm.last_commit as last_commit',
      'p.slug as slug',
      'p.title as title',
    ])
    .orderBy('m.updated_at', 'asc')
    .limit(MIRROR_LIST_CAP)
    .execute();

  return {
    count: Number(counted?.n ?? rows.length),
    items: rows.map((r) => ({
      page_id: r.page_id,
      slug: r.slug ?? null,
      title: r.title ?? null,
      path: r.path ?? null,
      dirty: Boolean(r.dirty),
      error: r.error ?? null,
      updated_at: r.updated_at,
      age_seconds: ageSeconds(r.updated_at, now),
      last_commit: r.last_commit ?? null,
    })),
  };
}
