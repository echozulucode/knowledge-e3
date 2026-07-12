import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { AdminOnly, CurrentUser } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import type { AuthedUser } from './auth.service.js';

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
  constructor(private readonly auth: AuthService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    const users = await this.auth.listUsers({
      q: q?.trim() || undefined,
      role: role === 'user' || role === 'admin' ? role : undefined,
      status: status === 'active' || status === 'disabled' ? status : undefined,
    });
    return { users };
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
  async resetPassword(@Param('id') id: string) {
    return this.auth.adminResetPassword(id);
  }
}
