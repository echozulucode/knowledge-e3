import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ItemsService } from '../items/items.service.js';
import { SyncService } from '../sync/sync.service.js';
import { RepoConfigService } from './repo-config.service.js';
import { RepoPullService } from './repo-pull.service.js';

class RepoUpsertDto {
  @IsString() remote_url!: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /**
   * Status for pulled items whose frontmatter declares no lifecycle state.
   * Omit to defer to the instance fallback. Set 'published' for a repo whose
   * content is ready to read as-is (the common case for a curated bundle).
   */
  @IsOptional() @IsIn(['draft', 'published']) default_status?: 'draft' | 'published';
}

class MainRemoteDto {
  @IsString() remote_url!: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class TestConnectionDto {
  @IsString() remote_url!: string;
  /**
   * NAMES only (issue 122): the variable this source reads its git credential
   * from and the host kind that picks the username convention. Sent from the
   * unsaved Sources form so an admin can test the credential before saving.
   * A value never crosses this boundary in either direction.
   */
  @IsOptional() @IsString() host_token_env?: string;
  @IsOptional() @IsString() host_kind?: string;
}

/**
 * Admin → Repos: map each topic to a backend git repository and check
 * connectivity. Admin-only; only the NAME of a source's credential variable is
 * handled here — the token itself is read from the server's environment and
 * reaches git through its child process (issue 122).
 */
@AdminOnly()
@Controller('admin/repos')
export class ReposController {
  constructor(
    private readonly repos: RepoConfigService,
    private readonly items: ItemsService,
    private readonly pull: RepoPullService,
    private readonly sync: SyncService,
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
    return this.repos.testConnection(body.remote_url, {
      tokenEnv: body.host_token_env ?? null,
      hostKind: body.host_kind ?? null,
    });
  }

  @Post(':spaceId/sync')
  async syncNow(@Param('spaceId') spaceId: string) {
    const result = await this.items.resyncSpace(spaceId);
    // The mirror flush above commits; when the sync engine owns the push for
    // this source (plan §12 cadence) ask it to push now rather than wait.
    const bound = await this.repos.forSpace(spaceId);
    const sourceId = bound?.id ?? 'main';
    if (this.sync.isManaged(sourceId)) await this.sync.requestPush(sourceId, 'manual');
    return result;
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
