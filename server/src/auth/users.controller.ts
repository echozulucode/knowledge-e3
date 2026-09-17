import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { AdminOnly, CurrentUser } from './auth.decorators.js';
import { AuthService, USER_SORT_KEYS, type UserSortKey } from './auth.service.js';
import type { AuthedUser } from './auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { wholeNumber } from './list-params.js';

function sortKey(raw: string | undefined): UserSortKey | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(USER_SORT_KEYS as readonly string[]).includes(value)) {
    throw new BadRequestException(`sort must be one of ${USER_SORT_KEYS.join(', ')}`);
  }
  return value as UserSortKey;
}

function sortDirection(raw: string | undefined): 'asc' | 'desc' | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value !== 'asc' && value !== 'desc') throw new BadRequestException('direction must be asc or desc');
  return value;
}

class UpdateUserDto {
  @IsOptional() @IsIn(['user', 'admin']) role?: 'user' | 'admin';
  @IsOptional() @IsBoolean() disabled?: boolean;
}

/**
 * Admin Users console. All routes are admin-only (class-level @AdminOnly). The
 * create endpoint stays on AuthController (POST /admin/users) for back-compat;
 * this controller adds list / update / reset-password.
 */
@AdminOnly()
@Controller('admin/users')
export class UsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One page of accounts. `{ users }` is what this route always returned;
   * `total`, `limit` and `offset` are additive. Unknown `role`/`status` values
   * are ignored as before; a malformed `limit`/`offset`/`sort`/`direction` is a
   * 400, since silently ignoring it would page or order the list wrongly.
   */
  @Get()
  async list(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
  ) {
    return this.auth.listUsers({
      q: q?.trim() || undefined,
      role: role === 'user' || role === 'admin' ? role : undefined,
      status: status === 'active' || status === 'disabled' ? status : undefined,
      limit: wholeNumber(limit, 'limit', 1),
      offset: wholeNumber(offset, 'offset', 0),
      sort: sortKey(sort),
      direction: sortDirection(direction),
    });
  }

  /** One account, for the user sheet opened from a link (`?user=<id>`). */
  @Get(':id')
  async get(@Param('id') id: string) {
    return { user: await this.auth.getUser(id) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    const user = await this.auth.updateUser(actor.id, id, body);
    return { user };
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() actor: AuthedUser, @Param('id') id: string) {
    const result = await this.auth.adminResetPassword(id);
    // The reset has already 404ed for an unknown account, so this resolves.
    // `username` lets the audit page say whose password was reset without a
    // lookup that fails once the account is gone.
    const target = await this.auth.getUser(id);
    // The temporary password is in the response and must stay out of the log —
    // hence a hand-built payload rather than spreading `result`. (`redact()`
    // would strip `temporary_password` by key, but that is a backstop, not a
    // design: it matches keys, never values.)
    await this.audit.record({
      actor_id: actor.id,
      action: 'user.password_reset',
      payload: { user_id: id, username: target.username },
    });
    return result;
  }
}
