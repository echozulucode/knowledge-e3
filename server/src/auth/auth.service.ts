import {
  Inject,
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { newId, nowIso } from '../common/ids.js';
import { hashPassword, verifyPassword } from './password.js';
import { LOCAL_SYSTEM_ACTOR } from './auth-mode.js';
import { ConfigService, validatePassword } from '../config/config.service.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding (per spec)

export interface AuthedUser {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
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

@Injectable()
export class AuthService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** Throw a 400 if the password violates the current admin policy. */
  private async enforcePasswordPolicy(password: string): Promise<void> {
    const policy = await this.config.getPasswordPolicy();
    const failures = validatePassword(policy, password);
    if (failures.length > 0) {
      throw new BadRequestException(`Password must ${failures.join(', ')}.`);
    }
  }

  /**
   * Local no-auth mode still needs a stable actor row because pages/audit rows
   * retain user foreign keys. This method is intentionally idempotent and only
   * used when KNOWLEDGE_E3_AUTH_MODE=disabled.
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
    const passwordHash = await hashPassword(`disabled-auth-${LOCAL_SYSTEM_ACTOR.id}`);

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
      throw new ConflictException('User with that email or username already exists');
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

  /** Admin Users console: list accounts with derived status + last-seen. The
   * internal local-system actor is never shown. `q`/`role`/`status` are optional
   * filters; at trial-cohort scale `q`/`status` are applied in memory. */
  async listUsers(
    opts: { q?: string; role?: 'user' | 'admin'; status?: 'active' | 'disabled' } = {},
  ): Promise<UserListItem[]> {
    let query = this.db
      .selectFrom('users')
      .leftJoin('sessions', 'sessions.user_id', 'users.id')
      .select([
        'users.id as id',
        'users.username as username',
        'users.email as email',
        'users.role as role',
        'users.created_at as created_at',
        'users.deleted_at as deleted_at',
      ])
      .select((eb) => eb.fn.max('sessions.last_seen_at').as('last_seen_at'))
      .where('users.id', '!=', LOCAL_SYSTEM_ACTOR.id)
      .groupBy('users.id');
    if (opts.role) query = query.where('users.role', '=', opts.role);

    const rows = await query.orderBy('users.created_at', 'asc').execute();
    let items: UserListItem[] = rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      role: r.role,
      status: r.deleted_at ? 'disabled' : 'active',
      created_at: r.created_at,
      last_seen_at: r.last_seen_at ?? null,
    }));

    if (opts.q) {
      const needle = opts.q.trim().toLowerCase();
      items = items.filter(
        (u) => u.username.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
      );
    }
    if (opts.status) items = items.filter((u) => u.status === opts.status);
    return items;
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
    if (!row || row.deleted_at) throw new UnauthorizedException('Invalid credentials');

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const session = await this.createSession(row.id, meta);
    return {
      session,
      user: { id: row.id, email: row.email, username: row.username, role: row.role },
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
