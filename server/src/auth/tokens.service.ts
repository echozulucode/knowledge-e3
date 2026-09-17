import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { newId, nowIso } from '../common/ids.js';
import type { AuthedUser, TokenScope } from './auth.service.js';
import { ConfigService } from '../config/config.service.js';

export const TOKEN_PREFIX = 'e3_';
const TOKEN_RANDOM_LENGTH = 40;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** `last_used_at` is refreshed at most this often, so a busy client does not
 * turn every request into a write. */
const LAST_USED_REFRESH_MS = 60_000;

/**
 * A token as any client sees it. There is deliberately no `prefix` here: secrets
 * are presence-only, and even the first characters of a token narrow the search
 * for the rest (the admin UX review §2). A token is recognised by
 * its name, scope and dates; the raw value exists once, in the create response.
 */
export interface ApiTokenView {
  id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreateTokenInput {
  name: string;
  scope: TokenScope;
  /** null = never expires (only allowed when no admin maximum is set). */
  expires_in_days: number | null;
}

/** An admin-list row: the token plus who owns it, and whether that owner can
 * still use it. */
export interface AdminApiTokenView extends ApiTokenView {
  user_id: string;
  username: string;
  /**
   * The owner's account is disabled. `authenticate()` refuses every token of a
   * disabled owner, so a row that is neither revoked nor expired would otherwise
   * read "active" for a credential that no longer opens anything.
   */
  owner_disabled: boolean;
}

export const TOKEN_STATE_FILTERS = ['active', 'expired', 'revoked', 'owner_disabled'] as const;
export type TokenStateFilter = (typeof TOKEN_STATE_FILTERS)[number];

export const TOKENS_LIST_DEFAULT_LIMIT = 50;
export const TOKENS_LIST_MAX_LIMIT = 200;

export interface ListTokensQuery {
  /** Owner's username or user id. */
  owner?: string;
  /** Absent = every state. */
  state?: TokenStateFilter;
  scope?: TokenScope;
  /** Case-insensitive substring of the token's name. */
  q?: string;
  /** Default {@link TOKENS_LIST_DEFAULT_LIMIT}; clamped to {@link TOKENS_LIST_MAX_LIMIT}. */
  limit?: number;
  offset?: number;
}

export interface ListTokensResult {
  tokens: AdminApiTokenView[];
  /** Every token matching the filters, not just this page. */
  total: number;
  limit: number;
  offset: number;
}

/** What the audit row of a revoke names. */
export interface RevokedTokenFacts {
  name: string;
  owner_username: string;
}

/** Unbiased base62 string of `length` chars from crypto randomness. */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      // 248 = 4 * 62: reject the tail so every symbol is equally likely.
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Extract the raw token from an `Authorization: Bearer e3_…` header, if any. */
export function bearerTokenFrom(header: unknown): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  const raw = match?.[1];
  return raw && raw.startsWith(TOKEN_PREFIX) ? raw : null;
}

const VIEW_COLUMNS = [
  'id',
  'name',
  'scope',
  'created_at',
  'expires_at',
  'last_used_at',
  'revoked_at',
] as const;

@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** Mint a token. The raw value is returned exactly once; only its hash is stored. */
  async create(userId: string, input: CreateTokenInput): Promise<ApiTokenView & { token: string }> {
    const maxDays = await this.config.getTokenMaxDays();
    if (maxDays !== null) {
      if (input.expires_in_days === null) {
        throw new BadRequestException(`Tokens must expire within ${maxDays} days on this instance.`);
      }
      if (input.expires_in_days > maxDays) {
        throw new BadRequestException(`Token lifetime cannot exceed ${maxDays} days.`);
      }
    }

    const raw = `${TOKEN_PREFIX}${input.scope === 'write' ? 'w' : 'r'}${randomBase62(TOKEN_RANDOM_LENGTH)}`;
    const view: ApiTokenView = {
      id: newId(),
      name: input.name.trim(),
      scope: input.scope,
      created_at: nowIso(),
      expires_at:
        input.expires_in_days === null
          ? null
          : new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000).toISOString(),
      last_used_at: null,
      revoked_at: null,
    };
    await this.db
      .insertInto('api_tokens')
      // `prefix` is a NOT NULL column from the original schema. It is still
      // written so no migration is needed, but never read back or sent to a
      // client; lookup is by `token_hash` alone.
      .values({ ...view, prefix: raw.slice(0, 8), user_id: userId, token_hash: hashToken(raw) })
      .execute();
    return { ...view, token: raw };
  }

  async listForUser(userId: string): Promise<ApiTokenView[]> {
    return this.db
      .selectFrom('api_tokens')
      .select(VIEW_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  /**
   * Admin → API tokens: one page of every user's tokens, newest first, with the
   * owner's username and state, and the total matching the filters.
   *
   * Filtering and paging happen in SQL, like `AuthService.listUsers`: the old
   * route returned every token on the instance, which an admin page cannot
   * render once there are thousands. The `state` filter follows the same
   * precedence as the web's `tokenState()` — revoked, then expired, then owner
   * disabled — so a row the filter returns for "Owner disabled" also SAYS
   * "Owner disabled". `expires_at` is an ISO-8601 UTC string, so comparing it
   * to now as text is comparing instants.
   */
  async listPage(opts: ListTokensQuery = {}): Promise<ListTokensResult> {
    const limit = Math.max(1, Math.min(TOKENS_LIST_MAX_LIMIT, Math.floor(opts.limit ?? TOKENS_LIST_DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const now = new Date().toISOString();

    let base = this.db.selectFrom('api_tokens').innerJoin('users', 'users.id', 'api_tokens.user_id');
    const owner = opts.owner?.trim();
    // A username (what a shared link carries, like the audit page's `actor`) or a user id.
    if (owner) base = base.where((eb) => eb.or([eb('users.username', '=', owner), eb('users.id', '=', owner)]));
    if (opts.scope) base = base.where('api_tokens.scope', '=', opts.scope);
    const needle = opts.q?.trim().toLowerCase();
    // instr() rather than LIKE, as in listUsers: "50%" means those characters.
    if (needle) base = base.where(sql<number>`instr(lower(api_tokens.name), ${needle})`, '>', 0);
    switch (opts.state) {
      case 'revoked':
        base = base.where('api_tokens.revoked_at', 'is not', null);
        break;
      case 'expired':
        base = base.where('api_tokens.revoked_at', 'is', null).where('api_tokens.expires_at', '<', now);
        break;
      case 'owner_disabled':
        base = base
          .where('api_tokens.revoked_at', 'is', null)
          .where((eb) => eb.or([eb('api_tokens.expires_at', 'is', null), eb('api_tokens.expires_at', '>=', now)]))
          .where('users.deleted_at', 'is not', null);
        break;
      case 'active':
        base = base
          .where('api_tokens.revoked_at', 'is', null)
          .where((eb) => eb.or([eb('api_tokens.expires_at', 'is', null), eb('api_tokens.expires_at', '>=', now)]))
          .where('users.deleted_at', 'is', null);
        break;
      default:
        break;
    }

    const [rows, count] = await Promise.all([
      base
        .select([
          'api_tokens.id as id',
          'api_tokens.name as name',
          'api_tokens.scope as scope',
          'api_tokens.created_at as created_at',
          'api_tokens.expires_at as expires_at',
          'api_tokens.last_used_at as last_used_at',
          'api_tokens.revoked_at as revoked_at',
          'api_tokens.user_id as user_id',
          'users.username as username',
          'users.deleted_at as owner_deleted_at',
        ])
        .orderBy('api_tokens.created_at', 'desc')
        // Stable tiebreak so equal timestamps cannot straddle two pages.
        .orderBy('api_tokens.id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst(),
    ]);
    return {
      // A disabled account is a soft-deleted one (see AuthService.updateUser); the
      // timestamp itself is not the client's business, only that it is set.
      tokens: rows.map(({ owner_deleted_at, ...row }) => ({ ...row, owner_disabled: owner_deleted_at != null })),
      total: Number(count?.n ?? 0),
      limit,
      offset,
    };
  }

  /**
   * Revoke a token. Idempotent; scoped to `userId` when given (self-service),
   * unscoped for admins. 404 when the token is not visible to the caller.
   *
   * Returns the token's name and owner so the audit row can say WHICH token was
   * revoked and whose it was, in words that survive the token being forgotten —
   * names only, never any part of the secret.
   */
  async revoke(id: string, userId?: string): Promise<RevokedTokenFacts> {
    let query = this.db
      .selectFrom('api_tokens')
      .innerJoin('users', 'users.id', 'api_tokens.user_id')
      .select(['api_tokens.id as id', 'api_tokens.revoked_at as revoked_at', 'api_tokens.name as name', 'users.username as owner_username'])
      .where('api_tokens.id', '=', id);
    if (userId) query = query.where('api_tokens.user_id', '=', userId);
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundException('Token not found');
    if (!row.revoked_at) {
      await this.db.updateTable('api_tokens').set({ revoked_at: nowIso() }).where('id', '=', id).execute();
    }
    return { name: row.name, owner_username: row.owner_username };
  }

  /** Resolve a raw bearer token to its user. Null when unknown, revoked,
   * expired, or the owner is disabled. */
  async authenticate(raw: string): Promise<AuthedUser | null> {
    const row = await this.db
      .selectFrom('api_tokens')
      .innerJoin('users', 'users.id', 'api_tokens.user_id')
      .select([
        'api_tokens.id as token_id',
        'api_tokens.scope as scope',
        'api_tokens.expires_at as expires_at',
        'api_tokens.last_used_at as last_used_at',
        'api_tokens.revoked_at as revoked_at',
        'users.id as user_id',
        'users.email as email',
        'users.username as username',
        'users.role as role',
        'users.deleted_at as deleted_at',
      ])
      .where('api_tokens.token_hash', '=', hashToken(raw))
      .executeTakeFirst();
    if (!row || row.revoked_at || row.deleted_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

    const now = Date.now();
    if (!row.last_used_at || now - new Date(row.last_used_at).getTime() > LAST_USED_REFRESH_MS) {
      await this.db
        .updateTable('api_tokens')
        .set({ last_used_at: new Date(now).toISOString() })
        .where('id', '=', row.token_id)
        .execute();
    }

    return {
      id: row.user_id,
      email: row.email,
      username: row.username,
      role: row.role,
      token: { id: row.token_id, scope: row.scope },
    };
  }
}
