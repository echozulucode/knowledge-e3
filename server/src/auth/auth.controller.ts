import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Get, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE } from './auth.guard.js';
import { Public, CurrentUser, AdminOnly } from './auth.decorators.js';
import type { AuthedUser } from './auth.service.js';
import { LoginThrottleService, normalizeLoginUsername } from './throttle.js';
import { AuditService } from '../audit/audit.service.js';

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

/**
 * What a failed sign-in is allowed to remember about the attempt.
 *
 * The submitted username, normalized exactly the way `LoginThrottleService` keys
 * it (`normalizeLoginUsername`: trimmed, lowercased, length-capped). It is the
 * attacker's own input echoed back, so storing it confirms nothing about which
 * accounts exist — and without it "was this account attacked" has no answer at
 * all, which is the whole point of auditing failures.
 *
 * The oracle is closed one field over, deliberately: the row's `actor_id` is
 * ALWAYS null on a failure, even when the username resolves to a real user, and
 * nothing else in the payload varies with whether it does. A disabled account,
 * a wrong password and a name that was never registered all leave the same row.
 */
const attemptedUsername = normalizeLoginUsername;

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly throttle: LoginThrottleService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // The throttle is consulted BEFORE the password is verified (issue 41). A
    // caller over either bucket gets 429 without the password being looked at:
    // deciding afterwards turned a lockout into an oracle, since a correct guess
    // still came back 200. The refusal is the same for every username, real or
    // not, and costs no scrypt round, so it says nothing about account existence.
    const attempt = await this.throttle.begin(body.username, req.ip);
    if (!attempt.allowed) {
      // No password, no hash, nothing that varies with whether the account
      // exists — the same discipline as `auth.login_failed` below.
      await this.audit.record({
        actor_id: null,
        action: 'auth.login_throttled',
        payload: {
          username_attempted: attempt.username,
          ip: req.ip ?? null,
          buckets: attempt.buckets,
          retry_after_seconds: attempt.retryAfterSeconds,
        },
      });
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      throw new HttpException(
        {
          message: `Too many failed attempts; try again in ${Math.ceil(attempt.retryAfterSeconds / 60)} minutes`,
          retry_after_seconds: attempt.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let out: Awaited<ReturnType<AuthService['login']>>;
    try {
      out = await this.auth.login(body.username, body.password, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
    } catch (err) {
      if (!(err instanceof UnauthorizedException)) {
        // Not a verdict on the password (the database fell over): don't let an
        // outage count toward anyone's lockout.
        await this.throttle.released(attempt);
        throw err;
      }
      // The reservation stays: it is now a recorded failure in both buckets.
      // `actor_id: null` unconditionally — see attemptedUsername(). No password,
      // no hash of one, no session or token value, and no field that differs
      // between a real account and one that was never there. `throttled` marks
      // the failure that filled a bucket, i.e. the one that started a lockout.
      await this.audit.record({
        actor_id: null,
        action: 'auth.login_failed',
        payload: {
          username_attempted: attemptedUsername(body.username),
          ip: req.ip ?? null,
          throttled: attempt.locksOnFailure,
        },
      });
      throw err;
    }

    // See LoginThrottleService.succeeded for why this clears the username's
    // bucket but never the IP's.
    await this.throttle.succeeded(attempt);
    await this.audit.record({
      actor_id: out.user.id,
      action: 'auth.login',
      payload: { ip: req.ip ?? null },
    });
    res.cookie(SESSION_COOKIE, out.session.id, {
      ...COOKIE_OPTS,
      expires: new Date(out.session.expires_at),
    });
    return { user: out.user };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.sessionId) await this.auth.logout(req.sessionId);
    // The session id is the credential, so it is never in the payload.
    await this.audit.record({ actor_id: user.id, action: 'auth.logout', payload: { ip: req.ip ?? null } });
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
    // Beyond the plan's D2 list, and for the same reason `auth.logout` is on it:
    // this drops every other session the account had, so "why was I signed out"
    // must have an answer. Neither password reaches the payload.
    await this.audit.record({
      actor_id: user.id,
      action: 'user.password_change',
      payload: { sessions_rotated: true },
    });
    res.cookie(SESSION_COOKIE, session.id, {
      ...COOKIE_OPTS,
      expires: new Date(session.expires_at),
    });
  }

  @AdminOnly()
  @Post('admin/users')
  async createUser(@CurrentUser() actor: AuthedUser, @Body() body: CreateUserDto) {
    const user = await this.auth.createUser(body);
    // Recorded here rather than in AuthService.createUser: only the request
    // knows WHO created the account, and a user created by the seed script or a
    // test fixture has no admin behind it to name.
    await this.audit.record({
      actor_id: actor.id,
      action: 'user.create',
      payload: { user_id: user.id, username: user.username, role: user.role },
    });
    return { user };
  }
}
