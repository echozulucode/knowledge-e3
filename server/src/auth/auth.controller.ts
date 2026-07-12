import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE } from './auth.guard.js';
import { Public, CurrentUser, AdminOnly } from './auth.decorators.js';
import type { AuthedUser } from './auth.service.js';
import { loginThrottle } from './throttle.js';

class LoginDto {
  @IsString() username!: string;
  @IsString() @MinLength(1) password!: string;
}

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsOptional() @IsIn(['user', 'admin']) role?: 'user' | 'admin';
}

class ChangePasswordDto {
  @IsString() @MinLength(1) old_password!: string;
  @IsString() @MinLength(8) new_password!: string;
}

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env['NODE_ENV'] === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Try login first, then decide. We deliberately do NOT pre-block — a
    // legitimate user with the correct password can recover from a streak of
    // typos without being locked out of their own account. The cost is one
    // scrypt verify per attempt even when over the threshold; acceptable for
    // the v0.1 trial-cohort scale.
    try {
      const out = await this.auth.login(body.username, body.password, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      // Successful login; reset the failure counter.
      loginThrottle.resetFailures(body.username);
      res.cookie(SESSION_COOKIE, out.session.id, {
        ...COOKIE_OPTS,
        expires: new Date(out.session.expires_at),
      });
      return { user: out.user };
    } catch (err) {
      // Authentication failed. Record the failure; if we're now over the
      // per-username threshold, surface 429 instead of 401.
      const { throttled, retryAfterSeconds } = loginThrottle.recordFailure(body.username);
      if (throttled) {
        throw new HttpException(
          {
            message: `Too many failed attempts; try again in ${Math.ceil(retryAfterSeconds / 60)} minutes`,
            retry_after_seconds: retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId) await this.auth.logout(req.sessionId);
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthedUser) {
    return { user };
  }

  @Post('me/password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthedUser,
    @Body() body: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Rotates all sessions; re-set the caller's cookie to the freshly issued one
    // so they aren't logged out by their own password change.
    const { session } = await this.auth.changePassword(
      user.id,
      body.old_password,
      body.new_password,
      { userAgent: req.headers['user-agent'], ip: req.ip },
    );
    res.cookie(SESSION_COOKIE, session.id, {
      ...COOKIE_OPTS,
      expires: new Date(session.expires_at),
    });
  }

  @AdminOnly()
  @Post('admin/users')
  async createUser(@Body() body: CreateUserDto) {
    const user = await this.auth.createUser(body);
    return { user };
  }
}
