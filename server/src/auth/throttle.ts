import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { loginThrottleSettings } from '../config/server-config.js';

/**
 * Sign-in throttle: a sliding-window count of failed attempts in two buckets,
 * persisted in `login_attempts` (issue 41).
 *
 * What it replaced, and why each property matters:
 *
 * - **Persistent.** The old counter was a process-local `Map`, so a restart —
 *   or simply a second process — handed an attacker a fresh budget. Rows in the
 *   database survive both.
 * - **Two buckets.** Per normalized username (default 5 per 15 min) stops
 *   guessing one account's password; per client IP (default 20 per 15 min)
 *   stops one client spraying a common password across many usernames, which a
 *   username-only bucket never sees because no single name ever reaches its limit.
 * - **Checked BEFORE verification.** The old code verified the password first
 *   and only then decided between 401 and 429 — so a throttled caller who
 *   guessed right still got a 200. The lockout was a label on wrong answers,
 *   not a lock: an attacker could keep guessing at full speed and simply watch
 *   for the one response that was not 429. Now a caller over either limit is
 *   refused without the password being looked at.
 * - **Reserve, then settle.** The attempt is written first and counted against
 *   the rows before it, so a burst of concurrent requests cannot all pass the
 *   check before any of them records a failure. A success releases the
 *   reservation (see `succeeded`); a failure simply leaves it in place.
 *
 * The trade-off to know about: a per-username lockout is also a way to lock a
 * legitimate user out, by failing on purpose against their name. That is the
 * standard price of the control and it is bounded by the window; the per-IP
 * bucket limits how many accounts one client can do it to.
 */

/** Cap on the normalized username stored as a bucket key and in audit rows. */
const MAX_ATTEMPTED_USERNAME = 64;

/**
 * The submitted username as the throttle keys it and the audit log records it:
 * trimmed, lowercased, length-capped. Lowercasing means `Admin` and `admin`
 * share a bucket, so case variants are not extra guesses. It is the caller's
 * own input echoed back, so storing it confirms nothing about which accounts exist.
 */
export function normalizeLoginUsername(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value.slice(0, MAX_ATTEMPTED_USERNAME);
}

export type ThrottleBucket = 'username' | 'ip';

/** An attempt allowed through to password verification. Settle it with `succeeded` or `released`. */
export interface LoginAttemptReservation {
  allowed: true;
  username: string;
  /** Row ids written for this attempt, one per enabled bucket. */
  rowIds: Partial<Record<ThrottleBucket, number>>;
  /**
   * True when a failure of THIS attempt fills a bucket — the next attempt in
   * that bucket will be refused. Recorded on `auth.login_failed` so the audit
   * log shows the failure that started a lockout.
   */
  locksOnFailure: boolean;
}

export interface LoginAttemptRefusal {
  allowed: false;
  username: string;
  /** Every bucket that is over its limit. */
  buckets: ThrottleBucket[];
  /** Seconds until an attempt would be allowed again (the longest across `buckets`). */
  retryAfterSeconds: number;
}

export type LoginAttemptDecision = LoginAttemptReservation | LoginAttemptRefusal;

@Injectable()
export class LoginThrottleService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Decide whether a sign-in attempt may reach password verification, and if
   * so reserve its place in each bucket.
   *
   * Refusals are NOT recorded as attempts. A refused request never touched a
   * password, so it is not a guess; counting it would let a client that keeps
   * knocking extend its own lockout forever, and `Retry-After` would then be a
   * lie to the legitimate user who waits exactly that long.
   */
  async begin(rawUsername: unknown, ip: string | undefined): Promise<LoginAttemptDecision> {
    const settings = loginThrottleSettings();
    const now = Date.now();
    const since = now - settings.windowMs;
    const username = normalizeLoginUsername(rawUsername);

    // Prune on write: one indexed range delete keeps the table to one window of
    // traffic without a timer or a boot pass.
    await this.db.deleteFrom('login_attempts').where('attempted_at', '<=', since).execute();

    const buckets: Array<{ bucket: ThrottleBucket; key: string; limit: number }> = [];
    if (settings.perUsername !== null) buckets.push({ bucket: 'username', key: username, limit: settings.perUsername });
    // No IP (a request with no socket address) means no IP bucket, rather than
    // every such request sharing one bucket called "unknown".
    if (settings.perIp !== null && ip) buckets.push({ bucket: 'ip', key: ip, limit: settings.perIp });

    const rowIds: Partial<Record<ThrottleBucket, number>> = {};
    const refused: ThrottleBucket[] = [];
    let retryAfterMs = 0;
    let locksOnFailure = false;

    for (const { bucket, key, limit } of buckets) {
      // `insertId`, not RETURNING: the node:sqlite adapter classifies statements
      // as readers by their leading keyword, so an INSERT … RETURNING would run
      // as a write and its row would never come back.
      const { insertId } = await this.db
        .insertInto('login_attempts')
        .values({ bucket, key, attempted_at: now })
        .executeTakeFirstOrThrow();
      const rowId = Number(insertId);
      rowIds[bucket] = rowId;

      // Count only rows written BEFORE this one. Ids are assigned under
      // SQLite's write lock, so of two racing attempts exactly one sees the
      // other — the second, which is the one that should be refused.
      const prior = this.db
        .selectFrom('login_attempts')
        .where('bucket', '=', bucket)
        .where('key', '=', key)
        .where('attempted_at', '>', since)
        .where('id', '<', rowId);
      const { count } = await prior
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      const priorCount = Number(count);

      if (priorCount >= limit) {
        refused.push(bucket);
        // Allowed again once the bucket drops back below `limit`, i.e. when the
        // (priorCount - limit + 1) oldest rows have left the window.
        const pivot = await prior
          .select('attempted_at')
          .orderBy('attempted_at', 'asc')
          .orderBy('id', 'asc')
          .offset(priorCount - limit)
          .limit(1)
          .executeTakeFirst();
        const reopensAt = (pivot?.attempted_at ?? now) + settings.windowMs;
        retryAfterMs = Math.max(retryAfterMs, reopensAt - now);
      } else if (priorCount + 1 >= limit) {
        locksOnFailure = true;
      }
    }

    if (refused.length > 0) {
      await this.deleteRows(Object.values(rowIds));
      return {
        allowed: false,
        username,
        buckets: refused,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
    return { allowed: true, username, rowIds, locksOnFailure };
  }

  /**
   * A reserved attempt signed in.
   *
   * WHY the two buckets settle differently:
   *
   * - **IP: only this attempt's reservation is released.** Earlier failures from
   *   the address stay counted. Otherwise a sprayer holding one valid account
   *   (their own) could sign into it every few guesses and keep their address's
   *   count at zero indefinitely — the success-clears bypass issue 41 describes,
   *   moved from one account to all of them. Releasing the reservation itself is
   *   still right: a successful sign-in is not a guess, and an office behind one
   *   NAT address must not lock itself out by signing in 20 times a morning.
   * - **Username: the whole bucket for THIS username is cleared, and nothing
   *   else.** Only someone who just proved they hold that account's password can
   *   do it, and for them the bucket has nothing left to protect. Not clearing it
   *   would leave a user who typo'd four times one more typo away from a lockout
   *   for the rest of the window after signing in fine. Signing into your own
   *   account never touches anyone else's username bucket, and the attempt only
   *   got here because neither bucket was over its limit — there is no
   *   "N wrong guesses then the right one" left to reset, since a caller at the
   *   limit is refused before the password is checked.
   */
  async succeeded(attempt: LoginAttemptReservation): Promise<void> {
    if (attempt.rowIds.username !== undefined) {
      await this.db
        .deleteFrom('login_attempts')
        .where('bucket', '=', 'username')
        .where('key', '=', attempt.username)
        .execute();
    }
    if (attempt.rowIds.ip !== undefined) await this.deleteRows([attempt.rowIds.ip]);
  }

  /**
   * Drop a reservation without counting it — for an attempt that failed for a
   * reason that says nothing about the password (the server fell over). An
   * outage must not lock users out on top of itself.
   */
  async released(attempt: LoginAttemptReservation): Promise<void> {
    await this.deleteRows(Object.values(attempt.rowIds));
  }

  private async deleteRows(ids: Array<number | undefined>): Promise<void> {
    const present = ids.filter((id): id is number => id !== undefined);
    if (present.length === 0) return;
    await this.db.deleteFrom('login_attempts').where('id', 'in', present).execute();
  }
}
