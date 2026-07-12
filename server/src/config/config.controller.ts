import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService } from './config.service.js';

class PasswordPolicyDto {
  @IsInt() @Min(1) @Max(128) min_length!: number;
  @IsBoolean() require_number!: boolean;
  @IsBoolean() require_symbol!: boolean;
  @IsBoolean() require_uppercase!: boolean;
}

/** Admin → Authentication → Local. Holds the local-password policy today; SSO/
 * LDAP provider config lands here in Wave 4. */
@AdminOnly()
@Controller('admin/auth')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get('password-policy')
  async getPolicy() {
    return { policy: await this.config.getPasswordPolicy() };
  }

  @Put('password-policy')
  async setPolicy(@CurrentUser() actor: AuthedUser, @Body() body: PasswordPolicyDto) {
    const policy = await this.config.setPasswordPolicy(body, actor.id);
    return { policy };
  }
}
