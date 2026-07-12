import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SpacesService } from './spaces.service.js';
import { RepoConfigService } from '../storage/repo-config.service.js';
import { RepoPullService } from '../storage/repo-pull.service.js';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';

class CreateTopicDto {
  @IsOptional() @IsString() @MaxLength(100) slug?: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  /** Optional dedicated backend repo for this topic (else it lives in the main repo). */
  @IsOptional() repo?: { remote_url: string; branch?: string; pull?: boolean };
}

class UpdateTopicDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

class CreatePrimaryCategoryDto {
  @IsOptional() @IsString() @MaxLength(100) slug?: string;
  @IsString() @MaxLength(200) name!: string;
}

class UpdatePrimaryCategoryDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}

class CreateGroupDto {
  @IsOptional() @IsString() @MaxLength(100) slug?: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(100) scope?: string;
  @IsOptional() @IsString() @MaxLength(200) space_id?: string;
  @IsOptional() @IsString() @MaxLength(200) space_slug?: string;
}

@Controller()
export class TaxonomyController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly repos: RepoConfigService,
    private readonly repoPull: RepoPullService,
  ) {}

  @PublicRead()
  @Get('topics')
  async listTopics() {
    const topics = await this.spaces.listWithCounts();
    return { topics, total: topics.length };
  }

  @PublicRead()
  @Get('spaces')
  async listSpaces() {
    const spaces = await this.spaces.list();
    return { spaces, total: spaces.length };
  }

  @PublicRead()
  @Get('taxonomy/tags')
  async listTags(@Query('q') q?: string) {
    const tags = await this.spaces.listTags(q);
    return { tags, total: tags.length };
  }

  @PublicRead()
  @Get('taxonomy/categories')
  async listCategories(@Query('q') q?: string) {
    const categories = await this.spaces.listCategories(q);
    return { categories, total: categories.length };
  }

  @Post('taxonomy/categories')
  @HttpCode(201)
  @AdminOnly()
  async createCategory(@Body() body: CreatePrimaryCategoryDto) {
    const category = await this.spaces.createCategory(body);
    return { category };
  }

  @Put('taxonomy/categories/:slug')
  @AdminOnly()
  async updateCategory(@Param('slug') slug: string, @Body() body: UpdatePrimaryCategoryDto) {
    const category = await this.spaces.updateCategory(slug, body);
    return { category };
  }

  @Delete('taxonomy/categories/:slug')
  @AdminOnly()
  async archiveCategory(@Param('slug') slug: string) {
    const category = await this.spaces.archiveCategory(slug);
    return { category };
  }

  @PublicRead()
  @Get('taxonomy/groups')
  async listGroups(@Query('q') q?: string) {
    const groups = await this.spaces.listGroups(q);
    return { groups, total: groups.length };
  }

  @Post('taxonomy/groups')
  @HttpCode(201)
  @AdminOnly()
  async createGroup(@Body() body: CreateGroupDto) {
    const group = await this.spaces.createGroup(body);
    return { group };
  }

  @Post('topics')
  @HttpCode(201)
  @AdminOnly()
  async createTopic(@CurrentUser() actor: AuthedUser, @Body() body: CreateTopicDto) {
    const topic = await this.spaces.create({
      slug: body.slug,
      name: body.name,
      description: body.description,
    });
    // Optionally bind a dedicated backend repo at creation time; otherwise the
    // topic lives in the main repo as a subtree (no binding needed).
    let pulled: { created: number; updated: number } | undefined;
    if (body.repo?.remote_url?.trim()) {
      await this.repos.upsert(topic.id, { remote_url: body.repo.remote_url, branch: body.repo.branch }, null);
      // Optionally pull the repo's existing content straight into the new topic.
      if (body.repo.pull) {
        const result = await this.repoPull.pullIntoTopic(topic.id, actor);
        pulled = { created: result.created, updated: result.updated };
      }
    }
    return { topic, ...(pulled ? { pulled } : {}) };
  }

  @Put('topics/:id')
  @AdminOnly()
  async updateTopic(@Param('id') id: string, @Body() body: UpdateTopicDto) {
    const topic = await this.spaces.update(id, body);
    return { topic };
  }

  @Delete('topics/:id')
  @AdminOnly()
  async archiveTopic(@Param('id') id: string) {
    const topic = await this.spaces.archive(id);
    return { topic };
  }

  @Post('spaces')
  @HttpCode(201)
  @AdminOnly()
  async createSpace(@Body() body: CreateTopicDto) {
    const space = await this.spaces.create(body);
    return { space };
  }
}
