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
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PagesService } from './pages.service.js';
import { forViewer, listForViewer } from './lifecycle-columns.js';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { actorFrom } from '../content/actor.js';
import { ContentCommandsService } from '../content/content-commands.service.js';

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
  /** Admin-only, audited opt-out of the publish gate (422 `lint_failed`). */
  @IsOptional() @IsBoolean() allow_lint_errors?: boolean;
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
  constructor(
    private readonly pages: PagesService,
    private readonly content: ContentCommandsService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthedUser, @Body() body: CreatePageDto) {
    const { item: page } = await this.content.create(actorFrom(user, 'ui'), body, 'ui');
    return { page, version_token: page.version_token };
  }

  @PublicRead()
  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    // Repeated `?tags=a&tags=b`, or a single value; a Section's any-of tag filter.
    @Query('tags') tags?: string | string[],
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('space') space?: string,
    @Query('type') type?: string,
    @Query('sort') sort?: string,
  ) {
    if (status && status !== 'draft' && status !== 'published') {
      throw new BadRequestException('invalid status filter');
    }
    const SORTS = ['updated', 'published', 'created', 'title'] as const;
    if (sort && !SORTS.includes(sort as (typeof SORTS)[number])) {
      throw new BadRequestException('invalid sort');
    }
    const opts = {
      q,
      status: status as 'draft' | 'published' | undefined,
      tag,
      tags: tags === undefined ? undefined : Array.isArray(tags) ? tags : [tags],
      since,
      limit: limit ? parseInt(limit, 10) : undefined,
      space,
      type,
      sort: sort as 'updated' | 'published' | 'created' | 'title' | undefined,
    };
    // `total` is every match for this caller, not the length of this page: the
    // Sections admin reads it as "Matches N items", and a count capped at
    // `limit` would under-report exactly the sections that matter most.
    const [items, total] = await Promise.all([this.pages.list(opts, user), this.pages.count(opts, user)]);
    return { items: listForViewer(items, user), total };
  }

  @PublicRead()
  @Get('by-title/:title')
  async byTitle(@CurrentUser() user: AuthedUser, @Param('title') title: string) {
    const page = await this.pages.getByTitle(title, user);
    return { page: forViewer(page, user) };
  }

  @PublicRead()
  @Get('by-slug/:slug')
  async bySlug(@CurrentUser() user: AuthedUser, @Param('slug') slug: string) {
    const page = await this.pages.getBySlug(slug, user);
    return { page: forViewer(page, user) };
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
    return { page: forViewer(page, user), version_token: page.version_token };
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
    const { item: page } = await this.content.update(actorFrom(user, 'ui'), id, body, expected, 'ui');
    return { page, version_token: page.version_token };
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    await this.content.remove(actorFrom(user, 'ui'), id);
  }

  @Post(':id/restore')
  async restore(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    const { item: page } = await this.content.restore(actorFrom(user, 'ui'), id);
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
    const { item: page, affected_pages } = await this.content.rename(actorFrom(user, 'ui'), id, body.new_title, {
      ifMatch: expected,
      linkAction: body.link_action,
      expectedAffectedVersions: (body.expected_affected_versions ?? {}) as Record<string, number>,
    });
    return { page, affected_pages };
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
