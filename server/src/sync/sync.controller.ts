import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConflictQueueService, DEFAULT_RESOLVED_LIMIT, MAX_RESOLVED_LIMIT } from './conflict-queue.service.js';
import { SourceRegistryService } from './source-registry.service.js';
import { SyncService } from './sync.service.js';
import { AuditService } from '../audit/audit.service.js';

class SourceUpsertDto {
  @IsOptional() @IsString() space_id?: string | null;
  @IsOptional() @IsString() local_dir?: string;
  @IsOptional() @IsString() remote_url?: string | null;
  @IsOptional() @IsString() branch?: string | null;
  @IsOptional() @IsIn(['authoritative', 'reference']) role?: 'authoritative' | 'reference';
  @IsOptional() @IsIn(['direct', 'review', 'read-only']) mode?: 'direct' | 'review' | 'read-only';
  @IsOptional() @IsString() branch_prefix?: string | null;
  @IsOptional() @IsIn(['github', 'bitbucket-dc']) host_kind?: 'github' | 'bitbucket-dc' | null;
  @IsOptional() @IsString() host_base_url?: string | null;
  /** Name of the env var holding the host token — never the token itself. */
  @IsOptional() @IsString() host_token_env?: string | null;
  @IsOptional() @IsInt() @Min(5) sync_every_seconds?: number | null;
  @IsOptional() @IsString() webhook_secret_env?: string | null;
  @IsOptional() @IsIn(['draft', 'published']) default_status?: 'draft' | 'published' | null;
  /**
   * Non-OKF import (plan §8.3): repo-relative globs selecting the files to index; `[]`/null restores the default.
   * Shape only here; `SourceRegistryService.upsert` rejects absolute paths and `..` segments with a 400.
   */
  @IsOptional() @IsArray() @IsString({ each: true }) include_globs?: string[] | null;
  @IsOptional() @IsArray() @IsString({ each: true }) exclude_globs?: string[] | null;
  /** Content type for an imported file with none of its own; validated against the content-type registry. */
  @IsOptional() @IsString() default_type?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class ResolveConflictDto {
  @IsIn(['ours', 'theirs']) choice!: 'ours' | 'theirs';
  /** Merged content to use instead of either side (recorded as a `manual` resolution). */
  @IsOptional() @IsString() content?: string;
}

/** `?includeResolved=1|true` — anything else (including absent) means open conflicts only. */
function parseFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** `?resolvedLimit=` — a positive integer, clamped to the queue's ceiling. */
function parseResolvedLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESOLVED_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('resolvedLimit must be a positive integer');
  return Math.min(n, MAX_RESOLVED_LIMIT);
}

/**
 * Admin → Repos over the source registry (plan §7.4): every registered
 * source with its live sync status, run a cycle or a push now, and the
 * conflict queue (§8.1). Admin-only; tokens are named by env var, never stored.
 */
@AdminOnly()
@Controller('admin/sources')
export class SyncController {
  constructor(
    private readonly registry: SourceRegistryService,
    private readonly sync: SyncService,
    private readonly conflicts: ConflictQueueService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    return { sources: await this.sync.statuses() };
  }

  @Put(':id')
  async upsert(@CurrentUser() actor: AuthedUser, @Param('id') id: string, @Body() body: SourceUpsertDto) {
    // The prior row is read for one reason: `mode` is the field a security
    // question is actually about ("who made this source writable"), and
    // read-only -> direct is only legible with both sides of it.
    const before = await this.registry.get(id);
    const source = await this.registry.upsert(id, body);
    await this.sync.reload();
    // `host_env_var` / `webhook_env_var`, not the DB column names: redact()
    // drops any key containing "token" or "secret", so `host_token_env` would
    // vanish even though its VALUE is only the name of an environment variable.
    // The values themselves live in the environment and never reach this row.
    await this.audit.record({
      actor_id: actor.id,
      action: 'source.upsert',
      payload: {
        id,
        created: before === null,
        fields: Object.keys(body).sort(),
        mode_from: before?.mode ?? null,
        mode_to: source.mode,
        role: source.role,
        enabled: source.enabled === 1,
        remote_url: source.remote_url,
        host_env_var: source.host_token_env,
        webhook_env_var: source.webhook_secret_env,
      },
    });
    // The same shape the list returns — item count and HEAD included — so a
    // client that renders the saved row does not show it blanker than the list.
    const [view] = await this.sync.detailedViews([source]);
    return { source: view };
  }

  @Delete(':id')
  async remove(@CurrentUser() actor: AuthedUser, @Param('id') id: string) {
    const before = await this.registry.get(id);
    await this.registry.remove(id);
    await this.sync.reload();
    await this.audit.record({
      actor_id: actor.id,
      action: 'source.remove',
      payload: { id, mode: before?.mode ?? null, remote_url: before?.remote_url ?? null },
    });
    return { ok: true };
  }

  @Post(':id/sync')
  @HttpCode(200)
  async runNow(@Param('id') id: string) {
    return { status: await this.sync.runNow(id) };
  }

  @Post(':id/push')
  @HttpCode(200)
  async push(@Param('id') id: string) {
    return { status: await this.sync.requestPush(id, 'manual') };
  }

  /**
   * Change requests this source has opened for its items (plan §8.2 `review`).
   * `refresh` re-asks the host; `merge` merges through the host (when it
   * supports it) and then reconciles, which indexes the merged file.
   */
  @Get(':id/reviews')
  async reviews(@Param('id') id: string) {
    return { reviews: await this.sync.listReviews(id) };
  }

  @Post(':id/reviews/:pageId/merge')
  @HttpCode(200)
  async mergeReview(@Param('id') id: string, @Param('pageId') pageId: string) {
    return { review: await this.sync.mergeReview(id, pageId) };
  }

  @Post(':id/reviews/:pageId/refresh')
  @HttpCode(200)
  async refreshReview(@Param('id') id: string, @Param('pageId') pageId: string) {
    const reviews = await this.sync.refreshReviews(id, pageId);
    return { review: reviews[0] ?? null };
  }

  /**
   * The conflict queue for one source. Open conflicts only by default (oldest
   * first); `includeResolved` appends the resolved history — newest first and
   * capped at `resolvedLimit` (default 20, max 100) so it is never unbounded.
   */
  @Get(':id/conflicts')
  async conflictsFor(
    @Param('id') id: string,
    @Query('includeResolved') includeResolved?: string,
    @Query('resolvedLimit') resolvedLimit?: string,
  ) {
    const open = await this.conflicts.list(id);
    if (!parseFlag(includeResolved)) return { conflicts: open };
    const limit = parseResolvedLimit(resolvedLimit);
    const resolved = await this.conflicts.listResolved(id, limit);
    return { conflicts: [...open, ...resolved], resolved_limit: limit };
  }

  @Post('conflicts/:conflictId/resolve')
  @HttpCode(200)
  async resolve(@CurrentUser() actor: AuthedUser, @Param('conflictId') conflictId: string, @Body() body: ResolveConflictDto) {
    const choice = body.content !== undefined ? { content: body.content } : body.choice;
    const result = await this.conflicts.resolve(conflictId, choice, actor.id);
    // Duplicates `sync_conflicts.resolved_by` deliberately (plan §9 Q7): the
    // audit log is the one place that is a COMPLETE account of admin actions,
    // and a reader should not have to know which table also happens to hold it.
    await this.audit.record({
      actor_id: actor.id,
      action: 'source.conflict_resolve',
      // `page_id` so the row links back to the item the conflict was about,
      // the same way a content write does.
      page_id: result.conflict.page_id,
      payload: {
        conflict_id: conflictId,
        source_id: result.conflict.source_id,
        path: result.conflict.path,
        resolution: result.conflict.resolution,
      },
    });
    return result;
  }
}
