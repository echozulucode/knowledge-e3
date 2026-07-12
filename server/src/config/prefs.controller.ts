import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsDefined, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService } from './config.service.js';

class SetPrefDto {
  @IsString() @MinLength(1) @MaxLength(64) key!: string;
  @IsDefined() value!: unknown;
}

/** Self-service per-user preferences (e.g. theme). Authenticated, not admin. */
@Controller('me/prefs')
export class PrefsController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  async get(@CurrentUser() user: AuthedUser) {
    return { prefs: await this.config.getUserPrefs(user.id) };
  }

  @Put()
  async set(@CurrentUser() user: AuthedUser, @Body() body: SetPrefDto) {
    await this.config.setUserPref(user.id, body.key, body.value);
    return { prefs: await this.config.getUserPrefs(user.id) };
  }
}
