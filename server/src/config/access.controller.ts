import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AdminOnly, CurrentUser, Public } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService, type ReadAccessMode } from './config.service.js';

class SetAccessDto {
  @IsIn(['public', 'authenticated']) read_mode!: ReadAccessMode;
}

/**
 * Instance read-access mode. `GET /access` is public so the web app can decide
 * whether to show content or send anonymous visitors to the login page;
 * `PUT /admin/access` is admin-only.
 */
@Controller()
export class AccessController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get('access')
  async getAccess() {
    return { read_mode: await this.config.getReadAccessMode() };
  }

  @AdminOnly()
  @Put('admin/access')
  async setAccess(@CurrentUser() actor: AuthedUser, @Body() body: SetAccessDto) {
    const read_mode = await this.config.setReadAccessMode(body.read_mode, actor.id);
    return { read_mode };
  }
}
