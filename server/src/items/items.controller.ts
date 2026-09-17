import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { actorFrom } from '../content/actor.js';
import { ContentCommandsService } from '../content/content-commands.service.js';
import { forViewer, listForViewer } from '../pages/lifecycle-columns.js';
import { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { viewerFrom } from '../query/viewer.js';
import { ItemsService } from './items.service.js';

class CreateItemDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() raw?: string;
  @IsOptional() @IsString() raw_markdown?: string;
  @IsOptional() frontmatter?: Record<string, unknown>;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class MoveItemDto {
  /** Target topic: slug or name. Created on demand, exactly as `topic` in a create does. */
  @IsString() @MaxLength(200) topic!: string;
}

class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() raw?: string;
  @IsOptional() @IsString() raw_markdown?: string;
  @IsOptional() frontmatter?: Record<string, unknown>;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  /** Admin-only, audited opt-out of the publish gate (422 `lint_failed`). */
  @IsOptional() @IsBoolean() allow_lint_errors?: boolean;
}

@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly content: ContentCommandsService,
    private readonly query: KnowledgeQueryService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthedUser, @Body() body: CreateItemDto) {
    const { item } = await this.content.create(actorFrom(user, 'rest'), body, 'rest');
    return { item, version_token: item.version_token };
  }

  @PublicRead()
  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    if (status && status !== 'draft' && status !== 'published') {
      throw new BadRequestException('invalid status filter');
    }
    const items = await this.items.list(
      {
        q,
        status: status as 'draft' | 'published' | undefined,
        tag,
        since,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
      user,
    );
    // Same redaction as `GET /pages` (plan §6, R4.5): both are `@PublicRead`,
    // and a list row's source ref is plumbing no list surface renders.
    return { items: listForViewer(items, user), total: items.length };
  }

  @PublicRead()
  @Get(':id')
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const item = await this.query.item(id, viewerFrom(user));
    if (!item) return { item: null };
    res.setHeader('ETag', String(item.version_token));
    return { item: forViewer(item, user), version_token: item.version_token };
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: UpdateItemDto,
    @CurrentUser() user: AuthedUser,
  ) {
    const expected = parseEtag(req.headers['if-match']);
    if (expected === null) throw new BadRequestException('If-Match header is required');
    const { item } = await this.content.update(actorFrom(user, 'rest'), id, body, expected, 'rest');
    return { item, version_token: item.version_token };
  }

  /**
   * Move an item to another topic (plan §8.3) — across repositories when the two
   * topics resolve to different sources. `If-Match` is honoured when sent and
   * defaults to the item's current version otherwise, as `POST /pages/:id/rename`
   * does. The slug never changes, so `/p/:slug` and `/items/:id` keep resolving.
   */
  @Post(':id/move')
  async move(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: MoveItemDto,
    @CurrentUser() user: AuthedUser,
  ) {
    const expected = parseEtag(req.headers['if-match']);
    const { item } = await this.content.move(actorFrom(user, 'rest'), id, body.topic, {
      ...(expected === null ? {} : { ifMatch: expected }),
    });
    return { item, version_token: item.version_token };
  }
}

function parseEtag(h: string | string[] | undefined): number | null {
  if (!h) return null;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return null;
  const cleaned = v.replace(/^W\//, '').replace(/"/g, '');
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}
