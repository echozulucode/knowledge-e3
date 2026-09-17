import {
  Inject,
  Injectable,
  type OnModuleInit,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { newId, nowIso } from '../common/ids.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
import { LOCAL_SYSTEM_ACTOR, assertAuthenticationEnabled } from './auth-mode.js';
import { ConfigService, validatePassword } from '../config/config.service.js';
import { AuditService } from '../audit/audit.service.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding (per spec)

export type TokenScope = 'read' | 'write';

export interface AuthedUser {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  /** Present when the request authenticated with a personal access token
   * rather than a session cookie. `scope: 'read'` callers may only read. */
  token?: { id: string; scope: TokenScope };
}

export interface CreateUserInput {
  email: string;
  username: string;
  password: string;
  role?: 'user' | 'admin';
}

/** A user as presented to the admin Users console. `status` is derived from the
 * `deleted_at` column — a disabled account is soft-deleted (which already blocks
 * login and invalidates sessions). */
export interface UserListItem {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  created_at: string;
  last_seen_at: string | null;
}

/** Columns the Users console may sort by. `status` ascending puts active before disabled. */
export const USER_SORT_KEYS = ['username', 'role', 'status', 'last_seen', 'created'] as const;
export type UserSortKey = (typeof USER_SORT_KEYS)[number];

export const USERS_LIST_DEFAULT_LIMIT = 50;
export const USERS_LIST_MAX_LIMIT = 200;

export interface ListUsersQuery {
  /** Case-insensitive substring of username OR email. */
  q?: string;
  role?: 'user' | 'admin';
  status?: 'active' | 'disabled';
  /** Default {@link USERS_LIST_DEFAULT_LIMIT}; clamped to {@link USERS_LIST_MAX_LIMIT}. */
  limit?: number;
  offset?: number;
  /** Default `created` ascending: the order the list always had. */
  sort?: UserSortKey;
  direction?: 'asc' | 'desc';
}

export interface ListUsersResult {
  users: UserListItem[];
  /** Every account matching the filters, not just this page. */
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Refuse to start with authentication turned off. Here as well as in
   * `createApp` so the e2e harness and every script that builds a Nest context
   * refuse the same way (auth-mode.ts).
   */
  onModuleInit(): void {
    assertAuthenticationEnabled();
  }

  /** Throw a 400 if the password violates the current admin policy. */
  private async enforcePasswordPolicy(password: string): Promise<void> {
    const policy = await this.config.getPasswordPolicy();
    const failures = validatePassword(policy, password);
    if (failures.length > 0) {
      throw new BadRequestException(`Password must ${failures.join(', ')}.`);
    }
  }

  /**
   * The system actor's row (see `LOCAL_SYSTEM_ACTOR`): system writes still need a
   * stable user because pages and audit rows keep user foreign keys. Idempotent.
   * Never the identity of an HTTP request, and it cannot sign in: `login`
   * refuses the id, and the stored hash is of a random secret nobody holds.
   */
  async ensureLocalSystemActor(): Promise<AuthedUser> {
    const existing = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'username', 'role', 'deleted_at'])
      .where('id', '=', LOCAL_SYSTEM_ACTOR.id)
      .executeTakeFirst();

    const alreadyCanonical =
      existing &&
      !existing.deleted_at &&
      existing.email === LOCAL_SYSTEM_ACTOR.email &&
      existing.username === LOCAL_SYSTEM_ACTOR.username &&
      existing.role === LOCAL_SYSTEM_ACTOR.role;
    if (alreadyCanonical) return LOCAL_SYSTEM_ACTOR;

    const now = nowIso();
    // A random secret, thrown away. The old hash was of a fixed, guessable
    // string; `login` refusing the id is what closes that for rows written then.
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));

    if (existing) {
      await this.db
        .updateTable('users')
        .set({
          email: LOCAL_SYSTEM_ACTOR.email,
          username: LOCAL_SYSTEM_ACTOR.username,
          password_hash: passwordHash,
          role: LOCAL_SYSTEM_ACTOR.role,
          deleted_at: null,
        })
        .where('id', '=', LOCAL_SYSTEM_ACTOR.id)
        .execute();
    } else {
      await this.db
        .insertInto('users')
        .values({
          ...LOCAL_SYSTEM_ACTOR,
          password_hash: passwordHash,
          created_at: now,
          deleted_at: null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            email: LOCAL_SYSTEM_ACTOR.email,
            username: LOCAL_SYSTEM_ACTOR.username,
            password_hash: passwordHash,
            role: LOCAL_SYSTEM_ACTOR.role,
            deleted_at: null,
          }),
        )
        .execute();
    }

    return LOCAL_SYSTEM_ACTOR;
  }

  /** Admin-only path. Creates a new user and returns it. */
  async createUser(input: CreateUserInput): Promise<AuthedUser> {
    const existing = await this.db
      .selectFrom('users')
      .select(['id'])
      .where((eb) =>
        eb.or([eb('email', '=', input.email), eb('username', '=', input.username)]),
      )
      .executeTakeFirst();
    if (existing) {
      // Say WHICH field clashed, with a machine-readable `reason`, so the create
      // form can put the message under that field instead of guessing.
      const taken = await this.db
        .selectFrom('users')
        .select(['id'])
        .where('username', '=', input.username)
        .executeTakeFirst();
      throw new ConflictException(
        taken
          ? { statusCode: 409, reason: 'username_taken', message: 'A user with that username already exists.' }
          : { statusCode: 409, reason: 'email_taken', message: 'A user with that email already exists.' },
      );
    }

    await this.enforcePasswordPolicy(input.password);
    const hash = await hashPassword(input.password);
    const id = newId();
    const now = nowIso();
    await this.db
      .insertInto('users')
      .values({
        id,
        email: input.email,
        username: input.username,
        password_hash: hash,
        role: input.role ?? 'user',
        created_at: now,
        deleted_at: null,
      })
      .execute();

    return { id, email: input.email, username: input.username, role: input.role ?? 'user' };
  }

  /**
   * Admin Users console: one page of accounts with derived status + last-seen,
   * and the total matching the filters. The internal local-system actor is never
   * shown or counted.
   *
   * Filtering, sorting and paging all happen in SQL. The first version loaded
   * every account and filtered in memory, which suited a trial cohort and not an
   * instance with thousands of accounts. `last_seen_at` is a correlated MAX over
   * sessions rather than a join + GROUP BY, so the count query can share the
   * same WHERE without the grouping.
   */
  async listUsers(opts: ListUsersQuery = {}): Promise<ListUsersResult> {
    const limit = Math.max(1, Math.min(USERS_LIST_MAX_LIMIT, Math.floor(opts.limit ?? USERS_LIST_DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const needle = opts.q?.trim().toLowerCase();

    let base = this.db.selectFrom('users').where('users.id', '!=', LOCAL_SYSTEM_ACTOR.id);
    if (needle) {
      // instr() rather than LIKE: a search for "a_b" or "50%" means those
      // characters, not wildcards, and there is nothing to escape.
      base = base.where((eb) =>
        eb.or([
          eb(sql<number>`instr(lower(users.username), ${needle})`, '>', 0),
          eb(sql<number>`instr(lower(users.email), ${needle})`, '>', 0),
        ]),
      );
    }
    if (opts.role) base = base.where('users.role', '=', opts.role);
    if (opts.status === 'active') base = base.where('users.deleted_at', 'is', null);
    if (opts.status === 'disabled') base = base.where('users.deleted_at', 'is not', null);

    const direction = opts.direction === 'desc' ? 'desc' : 'asc';
    const lastSeen = sql<string | null>`(select max(sessions.last_seen_at) from sessions where sessions.user_id = users.id)`;
    const sortExpr = {
      username: sql`lower(users.username)`,
      role: sql`users.role`,
      status: sql`(users.deleted_at is not null)`,
      last_seen: sql`last_seen_at`,
      created: sql`users.created_at`,
    }[opts.sort ?? 'created'];

    const [rows, count] = await Promise.all([
      base
        .select([
          'users.id as id',
          'users.username as username',
          'users.email as email',
          'users.role as role',
          'users.created_at as created_at',
          'users.deleted_at as deleted_at',
        ])
        .select(lastSeen.as('last_seen_at'))
        .orderBy(sortExpr, direction)
        // A stable tiebreak, or rows with equal sort values could land on two
        // pages (or on none) as the admin pages through.
        .orderBy('users.created_at', 'asc')
        .orderBy('users.id', 'asc')
        .limit(limit)
        .offset(offset)
        .execute(),
      base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst(),
    ]);

    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        role: r.role,
        status: r.deleted_at ? 'disabled' : 'active',
        created_at: r.created_at,
        last_seen_at: r.last_seen_at ?? null,
      })),
      total: Number(count?.n ?? 0),
      limit,
      offset,
    };
  }

  /**
   * One account as the Users console lists it. The user sheet is addressable
   * (`/admin/users?user=<id>`), and a shared link must open even when that
   * account is not on the page of the list the viewer happens to be looking at.
   */
  async getUser(id: string): Promise<UserListItem> {
    if (id === LOCAL_SYSTEM_ACTOR.id) throw new NotFoundException('User not found');
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'email', 'role', 'created_at', 'deleted_at'])
      .select(sql<string | null>`(select max(sessions.last_seen_at) from sessions where sessions.user_id = users.id)`.as('last_seen_at'))
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('User not found');
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      status: row.deleted_at ? 'disabled' : 'active',
      created_at: row.created_at,
      last_seen_at: row.last_seen_at ?? null,
    };
  }

  /** Change a user's role and/or enable/disable them. Guardrails prevent an
   * admin from locking everyone out: you cannot disable or demote yourself, and
   * the last remaining active admin cannot be removed. Disabling soft-deletes
   * the account and drops its sessions immediately. */
  async updateUser(
    actingUserId: string,
    id: string,
    patch: { role?: 'user' | 'admin'; disabled?: boolean },
  ): Promise<UserListItem> {
    const target = await this.getUserRow(id);
    if (!target || target.id === LOCAL_SYSTEM_ACTOR.id) throw new NotFoundException('User not found');

    const willDisable = patch.disabled === true;
    const willDemote = patch.role === 'user' && target.role === 'admin';

    if (id === actingUserId && willDisable) {
      throw new BadRequestException('You cannot disable your own account.');
    }
    if (id === actingUserId && patch.role === 'user') {
      throw new BadRequestException('You cannot remove your own admin role.');
    }

    const targetIsActiveAdmin = target.role === 'admin' && !target.deleted_at;
    if (targetIsActiveAdmin && (willDisable || willDemote)) {
      const activeAdmins = await this.countActiveAdmins();
      if (activeAdmins <= 1) throw new BadRequestException('Cannot remove the last admin.');
    }

    const updates: { role?: 'user' | 'admin'; deleted_at?: string | null } = {};
    if (patch.role) updates.role = patch.role;
    if (patch.disabled !== undefined) updates.deleted_at = patch.disabled ? nowIso() : null;
    if (Object.keys(updates).length > 0) {
      await this.db.updateTable('users').set(updates).where('id', '=', id).execute();
    }
    if (willDisable) {
      await this.db.deleteFrom('sessions').where('user_id', '=', id).execute();
    }

    // Audited HERE rather than in the controller because only this method holds
    // both sides of the change: "promoted to admin" is a different fact from
    // "was already an admin", and the before-value is gone a line later.
    if (patch.role && patch.role !== target.role) {
      await this.audit.record({
        actor_id: actingUserId,
        action: 'user.role_change',
        payload: { user_id: id, username: target.username, from: target.role, to: patch.role },
      });
    }
    const wasDisabled = target.deleted_at != null;
    if (patch.disabled !== undefined && patch.disabled !== wasDisabled) {
      await this.audit.record({
        actor_id: actingUserId,
        action: 'user.disable',
        payload: { user_id: id, username: target.username, disabled: patch.disabled },
      });
    }

    const updated = (await this.getUserRow(id))!;
    return {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      role: updated.role,
      status: updated.deleted_at ? 'disabled' : 'active',
      created_at: updated.created_at,
      last_seen_at: null,
    };
  }

  /** Admin password reset: set a fresh random temporary password, invalidate all
   * of the user's sessions, and return the plaintext once so the admin can hand
   * it over. (Forced rotation on next login arrives with the Wave 3 mailer.) */
  async adminResetPassword(id: string): Promise<{ temporary_password: string }> {
    const target = await this.getUserRow(id);
    if (!target || target.id === LOCAL_SYSTEM_ACTOR.id) throw new NotFoundException('User not found');
    // Generate a temporary password that satisfies the current policy: a
    // url-safe random body (>= min_length) plus one char from each class.
    const policy = await this.config.getPasswordPolicy();
    const temporary = randomBytes(Math.max(16, policy.min_length)).toString('base64url') + 'Aa1!';
    const hash = await hashPassword(temporary);
    await this.db.updateTable('users').set({ password_hash: hash }).where('id', '=', id).execute();
    await this.db.deleteFrom('sessions').where('user_id', '=', id).execute();
    return { temporary_password: temporary };
  }

  private async getUserRow(id: string) {
    return this.db
      .selectFrom('users')
      .select(['id', 'username', 'email', 'role', 'created_at', 'deleted_at'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async countActiveAdmins(): Promise<number> {
    const row = await this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('role', '=', 'admin')
      .where('deleted_at', 'is', null)
      .where('id', '!=', LOCAL_SYSTEM_ACTOR.id)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async login(
    username: string,
    password: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ session: { id: string; expires_at: string }; user: AuthedUser }> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'username', 'role', 'password_hash', 'deleted_at'])
      .where('username', '=', username)
      .executeTakeFirst();
    // One scrypt round on EVERY path, and one message. Rejecting an unknown or
    // disabled account before hashing answered in microseconds instead of tens
    // of milliseconds, which told a caller which usernames exist without ever
    // reading the body (issue 41).
    // The system actor is never a sign-in identity, whatever its row holds (a row
    // written before its hash was randomized carries a guessable one).
    const usable = row && !row.deleted_at && row.id !== LOCAL_SYSTEM_ACTOR.id ? row : null;
    const ok = await verifyPassword(password, usable?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!usable || !ok) throw new UnauthorizedException('Invalid credentials');
    const user = usable;

    const session = await this.createSession(user.id, meta);
    return {
      session,
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  }

  async resolveSession(sessionId: string): Promise<AuthedUser | null> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as session_id',
        'sessions.expires_at',
        'users.id as user_id',
        'users.email',
        'users.username',
        'users.role',
        'users.deleted_at',
      ])
      .where('sessions.id', '=', sessionId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.deleted_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;

    // Sliding window — refresh on activity.
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.db
      .updateTable('sessions')
      .set({ last_seen_at: nowIso(), expires_at: newExpiry })
      .where('id', '=', sessionId)
      .execute();

    return {
      id: row.user_id,
      email: row.email,
      username: row.username,
      role: row.role,
    };
  }

  /**
   * Change a user's password and rotate all of their sessions. After a
   * successful change every existing session (including any stolen cookie) is
   * invalidated, and a fresh session is issued for the caller so they stay
   * signed in. The controller re-sets the cookie from the returned session.
   */
  async changePassword(
    userId: string,
    oldPw: string,
    newPw: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ session: { id: string; expires_at: string } }> {
    const row = await this.db
      .selectFrom('users')
      .select(['password_hash'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new UnauthorizedException();
    const ok = await verifyPassword(oldPw, row.password_hash);
    if (!ok) throw new UnauthorizedException('Old password incorrect');
    await this.enforcePasswordPolicy(newPw);
    const hash = await hashPassword(newPw);
    await this.db
      .updateTable('users')
      .set({ password_hash: hash })
      .where('id', '=', userId)
      .execute();
    // Invalidate every existing session for this user, then re-issue one for
    // the caller so a rotated-out (or stolen) cookie can no longer be used.
    await this.db.deleteFrom('sessions').where('user_id', '=', userId).execute();
    const session = await this.createSession(userId, meta);
    return { session };
  }

  private async createSession(
    userId: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ id: string; expires_at: string }> {
    const id = newId();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.db
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        expires_at: expiresAt,
        created_at: now,
        last_seen_at: now,
        user_agent: meta.userAgent ?? null,
        ip_addr: meta.ip ?? null,
      })
      .execute();
    return { id, expires_at: expiresAt };
  }
}
