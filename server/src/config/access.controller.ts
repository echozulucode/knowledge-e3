import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AdminOnly, CurrentUser, Public } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService, type ReadAccessMode } from './config.service.js';
import { AuditService } from '../audit/audit.service.js';

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
  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get('access')
  async getAccess() {
    return { read_mode: await this.config.getReadAccessMode() };
  }

  @AdminOnly()
  @Put('admin/access')
  async setAccess(@CurrentUser() actor: AuthedUser, @Body() body: SetAccessDto) {
    // Read the outgoing mode first: this one flip decides whether the whole
    // library is readable by the anonymous internet, so the row has to say what
    // it was as well as what it became.
    const previous = await this.config.getReadAccessMode();
    const read_mode = await this.config.setReadAccessMode(body.read_mode, actor.id);
    await this.audit.record({
      actor_id: actor.id,
      action: 'config.read_access_change',
      payload: { from: previous, to: read_mode },
    });
    return { read_mode };
  }
}
