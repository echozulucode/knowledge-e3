import { Body, Controller, Inject, Post, BadRequestException, HttpCode } from '@nestjs/common';
import { Kysely } from 'kysely';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import { Public } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { newId, nowIso } from '../common/ids.js';

class BugReportDto {
  @IsString() @MaxLength(4096) body!: string;
  @IsObject() context!: Record<string, unknown>;
  @IsOptional() @IsString() page_id?: string;
}

/**
 * Validates the depth of a nested object.
 * Returns the maximum depth encountered, or -1 if maxDepth is exceeded.
 */
function validateContextDepth(obj: unknown, maxDepth: number, currentDepth = 0): number {
  if (currentDepth > maxDepth) {
    return -1; // Exceeded max depth.
  }

  if (obj === null || obj === undefined) {
    return currentDepth;
  }

  if (typeof obj !== 'object') {
    return currentDepth;
  }

  let maxChildDepth = currentDepth;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const childDepth = validateContextDepth(item, maxDepth, currentDepth + 1);
      if (childDepth === -1) return -1; // Early exit on overflow.
      maxChildDepth = Math.max(maxChildDepth, childDepth);
    }
  } else {
    for (const value of Object.values(obj)) {
      const childDepth = validateContextDepth(value, maxDepth, currentDepth + 1);
      if (childDepth === -1) return -1; // Early exit on overflow.
      maxChildDepth = Math.max(maxChildDepth, childDepth);
    }
  }

  return maxChildDepth;
}

@Controller('bug-report')
export class BugReportController {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  @Public()
  @Post()
  @HttpCode(201)
  async submit(@Body() body: BugReportDto, @CurrentUser() user?: AuthedUser) {
    // Validate context object depth (max 10 levels).
    const depth = validateContextDepth(body.context, 10);
    if (depth === -1) {
      throw new BadRequestException('Context object exceeds maximum nesting depth of 10');
    }

    const id = newId();
    await this.db
      .insertInto('bug_reports')
      .values({
        id,
        reporter_id: user?.id ?? null,
        page_id: body.page_id ?? null,
        body: body.body,
        context_json: JSON.stringify(body.context),
        created_at: nowIso(),
        status: 'new',
      })
      .execute();
    return { id };
  }
}
