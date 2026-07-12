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
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
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

class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() raw?: string;
  @IsOptional() @IsString() raw_markdown?: string;
  @IsOptional() frontmatter?: Record<string, unknown>;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthedUser, @Body() body: CreateItemDto) {
    const item = await this.items.create(user.id, body);
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
    return { items, total: items.length };
  }

  @PublicRead()
  @Get(':id')
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const item = await this.items.getById(id, user);
    if (!item) return { item: null };
    res.setHeader('ETag', String(item.version_token));
    return { item, version_token: item.version_token };
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
    const item = await this.items.update(user, id, expected, body);
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
