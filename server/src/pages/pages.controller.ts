import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PagesService } from './pages.service.js';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';

class CreatePageDto {
  @IsString() @MaxLength(500) title!: string;
  @IsString() body!: string;
  @IsOptional() frontmatter?: Record<string, unknown>;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class UpdatePageDto {
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsString() raw?: string;
  @IsOptional() @IsString() @MaxLength(500) title?: string;
  @IsOptional() @IsIn(['draft', 'published']) status?: 'draft' | 'published';
  @IsOptional() frontmatter?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class RenameDto {
  @IsString() @MaxLength(500) new_title!: string;
  @IsIn(['update_all', 'skip']) link_action!: 'update_all' | 'skip';
  // Shape (Record<string, number>) is enforced inside PagesService.rename,
  // where non-numeric values are rejected with a 400.
  @IsOptional() expected_affected_versions?: Record<string, unknown>;
}

@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthedUser, @Body() body: CreatePageDto) {
    const page = await this.pages.create(user.id, body);
    return { page, version_token: page.version_token };
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
    @Query('space') space?: string,
    @Query('type') type?: string,
  ) {
    if (status && status !== 'draft' && status !== 'published') {
      throw new BadRequestException('invalid status filter');
    }
    const items = await this.pages.list(
      {
        q,
        status: status as 'draft' | 'published' | undefined,
        tag,
        since,
        limit: limit ? parseInt(limit, 10) : undefined,
        space,
        type,
      },
      user,
    );
    return { items, total: items.length };
  }

  @PublicRead()
  @Get('by-title/:title')
  async byTitle(@CurrentUser() user: AuthedUser, @Param('title') title: string) {
    const page = await this.pages.getByTitle(title, user);
    return { page };
  }

  @PublicRead()
  @Get('by-slug/:slug')
  async bySlug(@CurrentUser() user: AuthedUser, @Param('slug') slug: string) {
    const page = await this.pages.getBySlug(slug, user);
    return { page };
  }

  // Must precede `:id` so "link-index" isn't captured as a page id.
  @PublicRead()
  @Get('link-index')
  async linkIndex() {
    return { slugs: await this.pages.listSlugs() };
  }

  @PublicRead()
  @Get(':id')
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const page = await this.pages.getById(id, { actor: user });
    if (!page) return { page: null };
    res.setHeader('ETag', String(page.version_token));
    return { page, version_token: page.version_token };
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: UpdatePageDto,
    @CurrentUser() user: AuthedUser,
  ) {
    const ifMatch = req.headers['if-match'];
    const expected = parseEtag(ifMatch);
    if (expected === null) {
      throw new BadRequestException('If-Match header is required');
    }
    const page = await this.pages.update(user, id, expected, body);
    return { page, version_token: page.version_token };
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    await this.pages.softDelete(user, id);
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    const page = await this.pages.restore(user, id);
    return { page };
  }

  @Post(':id/rename')
  async rename(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: RenameDto,
    @CurrentUser() user: AuthedUser,
  ) {
    const expected = parseEtag(req.headers['if-match']);
    if (expected === null) throw new BadRequestException('If-Match header is required');
    return this.pages.rename(
      user,
      id,
      expected,
      body.new_title,
      body.link_action,
      (body.expected_affected_versions ?? {}) as Record<string, number>,
    );
  }

  @Get(':id/versions')
  async listVersions(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    const versions = await this.pages.listVersions(id, user);
    return { versions };
  }

  @Get(':id/versions/:vid')
  async getVersion(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('vid') vid: string,
  ) {
    const version = await this.pages.getVersion(id, vid, user);
    return { version };
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
