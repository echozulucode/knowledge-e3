import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService } from './config.service.js';
import { AuditService } from '../audit/audit.service.js';

class PasswordPolicyDto {
  @IsInt() @Min(1) @Max(128) min_length!: number;
  @IsBoolean() require_number!: boolean;
  @IsBoolean() require_symbol!: boolean;
  @IsBoolean() require_uppercase!: boolean;
}

class TokenPolicyDto {
  /** Longest personal-access-token lifetime in days; null lifts the limit. */
  @ValidateIf((o) => o.max_days !== null) @IsInt() @Min(1) @Max(3650) max_days!: number | null;
}

/** Admin → Authentication → Local. Holds the local-password policy today; SSO/
 * LDAP provider config lands here in Wave 4. */
@AdminOnly()
@Controller('admin/auth')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every setting on Admin → Authentication with its provenance: `source`
   * (`admin` | `env` | `config` | `default`), and for an admin-set value who
   * saved it and when. Read-only; each setting keeps its own PUT.
   */
  @Get('settings')
  async getSettings() {
    return this.config.getAuthSettings();
  }

  @Get('password-policy')
  async getPolicy() {
    return { policy: await this.config.getPasswordPolicy() };
  }

  @Put('password-policy')
  async setPolicy(@CurrentUser() actor: AuthedUser, @Body() body: PasswordPolicyDto) {
    const previous = await this.config.getPasswordPolicy();
    const policy = await this.config.setPasswordPolicy(body, actor.id);
    await this.audit.record({
      actor_id: actor.id,
      action: 'config.password_policy',
      payload: { from: previous, to: policy },
    });
    return { policy };
  }

  @Get('token-policy')
  async getTokenPolicy() {
    return { max_days: await this.config.getTokenMaxDays() };
  }

  @Put('token-policy')
  async setTokenPolicy(@CurrentUser() actor: AuthedUser, @Body() body: TokenPolicyDto) {
    const previous = await this.config.getTokenMaxDays();
    const max_days = await this.config.setTokenMaxDays(body.max_days, actor.id);
    // `max_days`, not a key containing "token": redact() would drop the latter.
    await this.audit.record({
      actor_id: actor.id,
      action: 'config.token_policy',
      payload: { from_max_days: previous, to_max_days: max_days },
    });
    return { max_days };
  }
}
