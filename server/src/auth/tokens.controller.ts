import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { AdminOnly, CurrentUser } from './auth.decorators.js';
import type { AuthedUser, TokenScope } from './auth.service.js';
import { ApiTokensService, TOKEN_STATE_FILTERS, type TokenStateFilter } from './tokens.service.js';
import { wholeNumber } from './list-params.js';
import { ConfigService } from '../config/config.service.js';
import { AuditService } from '../audit/audit.service.js';

class CreateTokenDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsIn(['read', 'write']) scope!: TokenScope;
  /** One of the offered lifetimes, or an explicit null for "no expiry". */
  @ValidateIf((o) => o.expires_in_days !== null) @IsIn([30, 90, 365]) expires_in_days!: number | null;
}

/**
 * Token management requires a signed-in session: a bearer token must not be
 * able to mint, list, or revoke tokens, or a leaked token could extend its own
 * life or lock out its owner.
 */
function requireSession(user: AuthedUser): void {
  if (user.token) throw new ForbiddenException('Use a signed-in session to manage tokens');
}

/**
 * What a token event is allowed to remember: the token's identity and its
 * powers, never the secret. The raw value exists once, in the create response.
 *
 * The field is `id`, not `token_id`, on purpose — `redact()` drops any key whose
 * name contains "token", so `token_id` would silently vanish from the payload
 * and leave a row that cannot be matched to the token it describes.
 */
function tokenFacts(token: { id: string; name: string; scope: string; expires_at: string | null }) {
  return { id: token.id, name: token.name, scope: token.scope, expires_at: token.expires_at };
}

/**
 * A revoke's audit payload: which token (`id`, `token_name`) and whose it was
 * (`owner_username`), so the log reads "eric revoked bob's “CI”" without a
 * lookup. `token_name` survives `redact()` only because it is on that
 * function's exact-key allow-list; any other key containing "token" is dropped
 * (see `tokenFacts`). Names only, never the secret.
 */
function revokeFacts(id: string, self: boolean, facts: { name: string; owner_username: string }) {
  return { id, self, token_name: facts.name, owner_username: facts.owner_username };
}

/** `state=all` (or absent) is every state; anything else unknown is a 400. */
function stateFilter(raw: string | undefined): TokenStateFilter | undefined {
  const value = raw?.trim();
  if (!value || value === 'all') return undefined;
  if (!(TOKEN_STATE_FILTERS as readonly string[]).includes(value)) {
    throw new BadRequestException(`state must be one of all, ${TOKEN_STATE_FILTERS.join(', ')}`);
  }
  return value as TokenStateFilter;
}

function scopeFilter(raw: string | undefined): TokenScope | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value !== 'read' && value !== 'write') throw new BadRequestException('scope must be read or write');
  return value;
}

/** Self-service personal access tokens (Profile → Personal access tokens). */
@Controller('me/tokens')
export class MeTokensController {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    requireSession(user);
    const [tokens, max_days] = await Promise.all([
      this.tokens.listForUser(user.id),
      this.config.getTokenMaxDays(),
    ]);
    return { tokens, policy: { max_days } };
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthedUser, @Body() body: CreateTokenDto) {
    requireSession(user);
    const created = await this.tokens.create(user.id, body);
    await this.audit.record({
      actor_id: user.id,
      action: 'token.create',
      payload: tokenFacts(created),
    });
    return created;
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    requireSession(user);
    const facts = await this.tokens.revoke(id, user.id);
    await this.audit.record({ actor_id: user.id, action: 'token.revoke', payload: revokeFacts(id, true, facts) });
  }
}

/** Admin → Authentication → API tokens: every user's tokens, with revoke. */
@AdminOnly()
@Controller('admin/tokens')
export class AdminTokensController {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One page of every user's tokens. `{ tokens }` is what this route always
   * returned; `total`, `limit` and `offset` are additive — but it now returns
   * at most `limit` (default 50) rows. A malformed `state`, `scope`, `limit` or
   * `offset` is a 400: an ignored filter would show the admin the wrong tokens.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('owner') owner?: string,
    @Query('state') state?: string,
    @Query('scope') scope?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    requireSession(user);
    return this.tokens.listPage({
      owner: owner?.trim() || undefined,
      state: stateFilter(state),
      scope: scopeFilter(scope),
      q: q?.trim() || undefined,
      limit: wholeNumber(limit, 'limit', 1),
      offset: wholeNumber(offset, 'offset', 0),
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    requireSession(user);
    const facts = await this.tokens.revoke(id);
    // `self: false` distinguishes an admin revoking somebody else's token from
    // the owner revoking their own — the same action, a different question.
    await this.audit.record({ actor_id: user.id, action: 'token.revoke', payload: revokeFacts(id, false, facts) });
  }
}
