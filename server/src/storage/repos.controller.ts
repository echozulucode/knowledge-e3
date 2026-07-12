import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ItemsService } from '../items/items.service.js';
import { RepoConfigService } from './repo-config.service.js';
import { RepoPullService } from './repo-pull.service.js';

class RepoUpsertDto {
  @IsString() remote_url!: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class MainRemoteDto {
  @IsString() remote_url!: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class TestConnectionDto {
  @IsString() remote_url!: string;
}

/**
 * Admin → Repos: map each topic to a backend git repository and check
 * connectivity. Admin-only; credentials are never handled here (pushes use the
 * host's ambient SSH identity).
 */
@AdminOnly()
@Controller('admin/repos')
export class ReposController {
  constructor(
    private readonly repos: RepoConfigService,
    private readonly items: ItemsService,
    private readonly pull: RepoPullService,
  ) {}

  @Get()
  async list() {
    return { repos: await this.repos.list(), main: await this.repos.getMainRemote() };
  }

  @Put('main')
  async setMain(@Body() body: MainRemoteDto) {
    return { main: await this.repos.setMainRemote(body) };
  }

  @Post('test')
  async test(@Body() body: TestConnectionDto) {
    return this.repos.testConnection(body.remote_url);
  }

  @Post(':spaceId/sync')
  async sync(@Param('spaceId') spaceId: string) {
    return this.items.resyncSpace(spaceId);
  }

  @Post(':spaceId/pull')
  async pullIntoTopic(@CurrentUser() actor: AuthedUser, @Param('spaceId') spaceId: string) {
    return this.pull.pullIntoTopic(spaceId, actor);
  }

  @Put(':spaceId')
  async upsert(
    @CurrentUser() actor: AuthedUser,
    @Param('spaceId') spaceId: string,
    @Body() body: RepoUpsertDto,
  ) {
    await this.repos.upsert(spaceId, body, actor.id);
    return { ok: true };
  }

  @Delete(':spaceId')
  async remove(@Param('spaceId') spaceId: string) {
    await this.repos.remove(spaceId);
    return { ok: true };
  }
}
