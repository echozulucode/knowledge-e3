import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { Kysely } from 'kysely';
import { IsOptional, IsNumber, IsString } from 'class-validator';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { newId, nowIso } from '../common/ids.js';

class PageViewDto {
  @IsString() page_id!: string;
  @IsOptional() @IsNumber() dwell_ms?: number;
}

@Controller('events')
export class TelemetryController {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  @Post('page-view')
  @HttpCode(204)
  async pageView(@Body() body: PageViewDto, @CurrentUser() user: AuthedUser) {
    // Validate the target before inserting: page_id is an FK, so an unknown id
    // would surface as a 500. Also enforce visibility so a view can't be
    // recorded against another user's draft.
    const page = await this.db
      .selectFrom('pages')
      .select(['status', 'owner_id'])
      .where('id', '=', body.page_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const visible =
      page && (user.role === 'admin' || page.status === 'published' || page.owner_id === user.id);
    if (!visible) throw new BadRequestException('unknown or inaccessible page_id');

    await this.db
      .insertInto('page_views')
      .values({
        id: newId(),
        page_id: body.page_id,
        user_id: user.id,
        session_id: null,
        viewed_at: nowIso(),
        dwell_ms: body.dwell_ms ?? null,
      })
      .execute();
  }
}
