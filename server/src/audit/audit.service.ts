import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { nowIso } from '../common/ids.js';
import { redact } from './redact.js';

export interface AuditEntry {
  actor_id: string | null;
  action: string;
  page_id?: string | null;
  version_id?: string | null;
  payload?: unknown;
}

/**
 * One row as an administrator reads it: the actor and the item resolved to the
 * names they are known by, so the page can say "alice renamed Onboarding"
 * without a second round trip and can link the row back to the item.
 */
export interface AuditRecordView {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  /** Null when the actor no longer exists, or for system-authored rows. */
  actor_username: string | null;
  action: string;
  page_id: string | null;
  /** Null when the target was hard-deleted; `page_id` still identifies it. */
  page_slug: string | null;
  page_title: string | null;
  version_id: string | null;
  payload: unknown;
}

/**
 * The three questions §6 says an administrator arrives with — *who changed this
 * item*, *what did this user do*, *what happened in this window* — one field
 * each. All optional; none given is "everything, newest first".
 */
export interface AuditQuery {
  /** A user id, or a username (resolved against `users` before the scan). */
  actor?: string;
  action?: string;
  page_id?: string;
  /**
   * The account or thing a row acted ON — not who acted (that is `actor`). A
   * user id, a username or another id; matched against the names the payloads
   * carry (see {@link SUBJECT_ID_KEYS} / {@link SUBJECT_NAME_KEYS}).
   */
  subject?: string;
  /** One row by its id: the target of an entry's "Copy link". */
  id?: number;
  /** ISO instants, inclusive of `since`, exclusive of `until`. */
  since?: string;
  until?: string;
  limit?: number;
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
}

export interface AuditListResult {
  entries: AuditRecordView[];
  /** Null when this is the last page. */
  next_cursor: string | null;
}

export const AUDIT_LIST_DEFAULT_LIMIT = 50;

/**
 * Payload keys that hold the id of the thing a row acted on: an account
 * (`user_id` on user.create / role_change / disable / password_reset), a token
 * or a source (`id` on token.* and source.upsert / remove), a source again on a
 * conflict resolution, a topic on a visibility change. Compared exactly — ids
 * are generated and never differ by case.
 */
export const SUBJECT_ID_KEYS = ['user_id', 'id', 'source_id', 'space_id'] as const;

/**
 * Payload keys that hold an account's NAME: the target of a user.* change, the
 * name typed at a failed or throttled sign-in (stored lowercased), and a
 * revoked token's owner. Compared case-insensitively, like sign-in itself.
 */
export const SUBJECT_NAME_KEYS = ['username', 'username_attempted', 'owner_username'] as const;

interface SubjectNeedles {
  ids: string[];
  names: string[];
}

/**
 * "Does this row's payload name the subject?" as one SQL predicate.
 *
 * Wrapped in `CASE WHEN json_valid(...)` because `json_extract` RAISES on
 * malformed JSON rather than returning null, and the log keeps rows whose
 * payload is not JSON (see `parsePayload`) — one such row would otherwise turn
 * every subject search into a 500. `CASE` is the construct SQLite evaluates in
 * order; `json_valid(...) AND json_extract(...)` carries no such promise.
 * Key names are code constants, never request input.
 */
function subjectPredicate(needles: SubjectNeedles) {
  const payload = sql.ref('audit_log.payload_json');
  const ids = sql.join(needles.ids.map((v) => sql.val(v)));
  const names = sql.join(needles.names.map((v) => sql.val(v)));
  const matches = [
    ...SUBJECT_ID_KEYS.map((key) => sql`json_extract(${payload}, ${sql.lit(`$.${key}`)}) IN (${ids})`),
    ...SUBJECT_NAME_KEYS.map((key) => sql`lower(json_extract(${payload}, ${sql.lit(`$.${key}`)})) IN (${names})`),
  ];
  return sql<boolean>`CASE WHEN json_valid(${payload}) THEN (${sql.join(matches, sql` OR `)}) ELSE 0 END`;
}
export const AUDIT_LIST_MAX_LIMIT = 200;

/**
 * `occurred_at` is not unique (a burst of writes shares a millisecond), so the
 * keyset is the pair (occurred_at, id) — `id` is the autoincrement tiebreak.
 * Encoded rather than exposed so the shape can change without breaking links.
 */
function encodeCursor(occurredAt: string, id: number): string {
  return Buffer.from(`${occurredAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { occurred_at: string; id: number } | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep <= 0) return null;
  const id = Number.parseInt(decoded.slice(sep + 1), 10);
  if (!Number.isFinite(id)) return null;
  return { occurred_at: decoded.slice(0, sep), id };
}

function parsePayload(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A row written before a payload-shape change, or a truncated write. The
    // administrator is better served by the raw text than by a dropped row.
    return raw;
  }
}

@Injectable()
export class AuditService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async record(entry: AuditEntry): Promise<void> {
    // Redact sensitive data before serializing.
    const redactedPayload = entry.payload === undefined ? undefined : redact(entry.payload);
    await this.db
      .insertInto('audit_log')
      .values({
        occurred_at: nowIso(),
        actor_id: entry.actor_id,
        action: entry.action,
        page_id: entry.page_id ?? null,
        version_id: entry.version_id ?? null,
        payload_json: redactedPayload === undefined ? null : JSON.stringify(redactedPayload),
      })
      .execute();
  }

  /**
   * Read the log, newest first.
   *
   * WARNING: this is the whole audit log. Its only HTTP caller is
   * {@link AuditController}, which is `@AdminOnly()` at the class level; an
   * authorization mistake here is itself the vulnerability, because the log
   * names every account on the instance and every change each one made.
   *
   * Served over `idx_audit_log_occurred` (the unfiltered and windowed reads) and
   * `idx_audit_log_actor_occurred` (the per-actor read). `action` and `page_id`
   * have no index of their own: retention (see {@link trim}) is what keeps the
   * scan they fall back to bounded. `subject` is the same trade one step
   * further: it reads JSON out of every candidate row's payload, so no index can
   * serve it. At this product's scale (a small team's log, trimmed by retention)
   * that scan is cheap; if it ever is not, the fix is a `subject` column written
   * by `record()`, not a looser match.
   */
  async list(query: AuditQuery = {}): Promise<AuditListResult> {
    const limit = Math.min(Math.max(query.limit ?? AUDIT_LIST_DEFAULT_LIMIT, 1), AUDIT_LIST_MAX_LIMIT);
    const actorId = await this.resolveActor(query.actor);
    // A named actor nobody matches is an empty result, not "everyone" — the
    // alternative silently answers a different question than the one asked.
    if (actorId === null) return { entries: [], next_cursor: null };
    const subject = await this.resolveSubject(query.subject);

    let q = this.db
      .selectFrom('audit_log')
      .leftJoin('users', 'users.id', 'audit_log.actor_id')
      .leftJoin('pages', 'pages.id', 'audit_log.page_id')
      .select([
        'audit_log.id as id',
        'audit_log.occurred_at as occurred_at',
        'audit_log.actor_id as actor_id',
        'audit_log.action as action',
        'audit_log.page_id as page_id',
        'audit_log.version_id as version_id',
        'audit_log.payload_json as payload_json',
        'users.username as actor_username',
        'pages.slug as page_slug',
        'pages.title as page_title',
      ]);

    if (actorId !== undefined) q = q.where('audit_log.actor_id', '=', actorId);
    if (query.action) q = q.where('audit_log.action', '=', query.action);
    if (query.page_id) q = q.where('audit_log.page_id', '=', query.page_id);
    if (query.id !== undefined) q = q.where('audit_log.id', '=', query.id);
    if (subject) q = q.where(subjectPredicate(subject));
    if (query.since) q = q.where('audit_log.occurred_at', '>=', query.since);
    if (query.until) q = q.where('audit_log.occurred_at', '<', query.until);

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      q = q.where((eb) =>
        eb.or([
          eb('audit_log.occurred_at', '<', cursor.occurred_at),
          eb.and([
            eb('audit_log.occurred_at', '=', cursor.occurred_at),
            eb('audit_log.id', '<', cursor.id),
          ]),
        ]),
      );
    }

    // One extra row decides `next_cursor` without a second count query.
    const rows = await q
      .orderBy('audit_log.occurred_at', 'desc')
      .orderBy('audit_log.id', 'desc')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at,
        actor_id: r.actor_id,
        actor_username: r.actor_username ?? null,
        action: r.action,
        page_id: r.page_id,
        page_slug: r.page_slug ?? null,
        page_title: r.page_title ?? null,
        version_id: r.version_id,
        payload: parsePayload(r.payload_json),
      })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.occurred_at, last.id) : null,
    };
  }

  /** Every action string present in the log, so the filter offers what exists. */
  async actions(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('audit_log')
      .select('action')
      .distinct()
      .orderBy('action', 'asc')
      .execute();
    return rows.map((r) => r.action);
  }

  /**
   * Retention (plan §6 D3). The ONLY delete against `audit_log` in the product:
   * the table is append-only by nature, so nothing else — no controller, no
   * service, no admin action — may remove or amend a row. Deliberately not
   * reachable over HTTP; {@link AuditRetentionService} is its only caller.
   *
   * Returns the number of rows removed so the caller can make the deletion
   * observable rather than silent.
   */
  async trim(cutoffIso: string): Promise<number> {
    const result = await this.db
      .deleteFrom('audit_log')
      .where('occurred_at', '<', cutoffIso)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /**
   * The values a subject filter matches. An administrator arrives with either a
   * username (from the Users page) or an id (from a row's "Filter by subject"),
   * and older rows name an account only by `user_id` (user.password_reset before
   * it carried `username`), so a value that resolves to an account matches BOTH
   * its id and its name. The raw value is always kept as well: a deleted
   * account's id, a name only ever typed at the login form, a source id.
   */
  private async resolveSubject(subject: string | undefined): Promise<SubjectNeedles | undefined> {
    const needle = subject?.trim();
    if (!needle) return undefined;
    const ids = new Set([needle]);
    const names = new Set([needle.toLowerCase()]);
    const account = await this.db
      .selectFrom('users')
      .select(['id', 'username'])
      .where((eb) =>
        eb.or([eb('id', '=', needle), eb(sql<string>`lower(username)`, '=', needle.toLowerCase())]),
      )
      .executeTakeFirst();
    if (account) {
      ids.add(account.id);
      names.add(account.username.toLowerCase());
    }
    return { ids: [...ids], names: [...names] };
  }

  /**
   * `undefined` = no actor filter, `null` = a filter nobody matches.
   *
   * An administrator following "what did this user do" has a username in hand,
   * not a generated id, so both are accepted. The id branch is checked first and
   * kept even when no user row matches, because the log outlives the account:
   * a deleted user's rows must still be findable by the id they carry.
   */
  private async resolveActor(actor: string | undefined): Promise<string | null | undefined> {
    const needle = actor?.trim();
    if (!needle) return undefined;
    const row = await this.db
      .selectFrom('users')
      .select(['id'])
      .where((eb) =>
        eb.or([eb('id', '=', needle), eb(sql<string>`lower(username)`, '=', needle.toLowerCase())]),
      )
      .executeTakeFirst();
    if (row) return row.id;
    // No such user; treat the value as a raw actor id only if the log has one.
    const orphan = await this.db
      .selectFrom('audit_log')
      .select('id')
      .where('actor_id', '=', needle)
      .limit(1)
      .executeTakeFirst();
    return orphan ? needle : null;
  }
}
