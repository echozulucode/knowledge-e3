import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SpacesService } from './spaces.service.js';
import { RepoConfigService } from '../storage/repo-config.service.js';
import { RepoPullService } from '../storage/repo-pull.service.js';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { isAnonymousActor } from '../pages/pages.service.js';
import { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { AuditService } from '../audit/audit.service.js';
import { viewerFrom } from '../query/viewer.js';
import type { SpacePresentation, SpaceVisibility } from '../db/schema.js';

const PRESENTATIONS: SpacePresentation[] = ['portal', 'blog', 'docs', 'wiki'];

/** A query-string boolean: `?curated`, `?curated=1`, `?curated=true` all mean yes. */
function isTruthyFlag(value?: string): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '' || v === '1' || v === 'true' || v === 'yes';
}

class CreateTopicDto {
  @IsOptional() @IsString() @MaxLength(100) slug?: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  /**
   * 'private' keeps the topic off the anonymous surface. Settable at creation
   * so a topic bound to a repo can be closed BEFORE its first pull lands —
   * creating it public and flipping it afterwards would expose the content in
   * between.
   */
  @IsOptional() @IsIn(['public', 'private']) visibility?: SpaceVisibility;
  /** Landing-page presentation profile (plan §3.1); defaults to 'wiki'. */
  @IsOptional() @IsIn(PRESENTATIONS) presentation?: SpacePresentation;
  @IsOptional() @IsString() @MaxLength(20000) landing_markdown?: string;
  /** Slug of the "Start here" item. */
  @IsOptional() @IsString() @MaxLength(200) start_here?: string;
  /** Optional dedicated backend repo for this topic (else it lives in the main repo). */
  @IsOptional() repo?: { remote_url: string; branch?: string; pull?: boolean };
}

class UpdateTopicDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(['public', 'private']) visibility?: SpaceVisibility;
  @IsOptional() @IsIn(PRESENTATIONS) presentation?: SpacePresentation;
  @IsOptional() @IsString() @MaxLength(20000) landing_markdown?: string;
  @IsOptional() @IsString() @MaxLength(200) start_here?: string;
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

/**
 * No slug: a group's slug and id are what items reference, so they are fixed
 * at creation. `description: null` clears it. Scope is kept unless one of
 * scope/space_id/space_slug is sent — `scope: 'global'` means "All topics".
 */
class UpdateGroupDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsIn(['global', 'space']) scope?: 'global' | 'space';
  @IsOptional() @IsString() @MaxLength(200) space_id?: string | null;
  @IsOptional() @IsString() @MaxLength(200) space_slug?: string | null;
}

@Controller()
export class TaxonomyController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly repos: RepoConfigService,
    private readonly repoPull: RepoPullService,
    private readonly query: KnowledgeQueryService,
    private readonly audit: AuditService,
  ) {}

  @PublicRead()
  @Get('topics')
  async listTopics(@CurrentUser() user: AuthedUser) {
    const topics = await this.spaces.listWithCounts({ anonymousViewer: isAnonymousActor(user) });
    return { topics, total: topics.length };
  }

  /** Topic landing page (plan §3.1): profile, landing markdown, and Sections resolved to items. */
  @PublicRead()
  @Get('topics/:slug/landing')
  async topicLanding(@CurrentUser() user: AuthedUser, @Param('slug') slug: string) {
    const topic = await this.query.topic(slug, viewerFrom(user));
    if (!topic) throw new NotFoundException('Topic not found');
    return { topic };
  }

  @PublicRead()
  @Get('spaces')
  async listSpaces(@CurrentUser() user: AuthedUser) {
    const spaces = await this.spaces.list({ anonymousViewer: isAnonymousActor(user) });
    return { spaces, total: spaces.length };
  }

  @PublicRead()
  @Get('taxonomy/tags')
  async listTags(@CurrentUser() user: AuthedUser, @Query('q') q?: string) {
    const tags = await this.spaces.listTags(q, { anonymousViewer: isAnonymousActor(user) });
    return { tags, total: tags.length };
  }

  /**
   * `?curated=1` returns ONLY the admin-curated catalog — "what may I publish
   * into" — which is what the Publish drawer's picker offers, because primary
   * categories are curated, not emergent (Eric, 2026-09-11). Without the flag
   * this stays the union of catalog and usage — "what exists" — which is what
   * browse and the facets need so a legacy term nobody has curated is still
   * visible. See the two accessors in SpacesService; they must not be merged.
   */
  @PublicRead()
  @Get('taxonomy/categories')
  async listCategories(@CurrentUser() user: AuthedUser, @Query('q') q?: string, @Query('curated') curated?: string) {
    const opts = { anonymousViewer: isAnonymousActor(user) };
    const categories = isTruthyFlag(curated)
      ? await this.spaces.listCuratedCategories(q, opts)
      : await this.spaces.listCategories(q, opts);
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

  /**
   * Archived catalog entries, for the admin's Archived filter. Admin-only: a
   * retired term is catalog housekeeping, not vocabulary anyone publishes into.
   * A literal segment, so it never collides with the `:slug` routes (none of
   * which is a GET).
   */
  @Get('taxonomy/categories/archived')
  @AdminOnly()
  async listArchivedCategories() {
    const categories = await this.spaces.listArchivedCategories();
    return { categories, total: categories.length };
  }

  /** Undo for archive: 404 for an unknown slug, 409 when the category is not archived. */
  @Post('taxonomy/categories/:slug/restore')
  @HttpCode(200)
  @AdminOnly()
  async restoreCategory(@Param('slug') slug: string) {
    const category = await this.spaces.restoreCategory(slug);
    return { category };
  }

  @PublicRead()
  @Get('taxonomy/groups')
  async listGroups(@CurrentUser() user: AuthedUser, @Query('q') q?: string) {
    const groups = await this.spaces.listGroups(q, { anonymousViewer: isAnonymousActor(user) });
    return { groups, total: groups.length };
  }

  @Post('taxonomy/groups')
  @HttpCode(201)
  @AdminOnly()
  async createGroup(@Body() body: CreateGroupDto) {
    const group = await this.spaces.createGroup(body);
    return { group };
  }

  @Put('taxonomy/groups/:id')
  @AdminOnly()
  async updateGroup(@Param('id') id: string, @Body() body: UpdateGroupDto) {
    const group = await this.spaces.updateGroup(id, body);
    return { group };
  }

  /** Soft archive; 409 "group is in use by N items" while any item is in the group. */
  @Delete('taxonomy/groups/:id')
  @AdminOnly()
  async archiveGroup(@Param('id') id: string) {
    const group = await this.spaces.archiveGroup(id);
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
      visibility: body.visibility,
      presentation: body.presentation,
      landing_markdown: body.landing_markdown,
      start_here: body.start_here,
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
  async updateTopic(@CurrentUser() actor: AuthedUser, @Param('id') id: string, @Body() body: UpdateTopicDto) {
    // Read the OUTGOING visibility before the write. Flipping this one field
    // decides whether a whole topic and everything in it exists for the
    // anonymous internet, so it gets the same treatment `config.read_access_change`
    // gives the instance-wide toggle: a row that says what it was as well as
    // what it became. Only read when the request actually carries the field, so
    // a plain rename costs no extra query.
    const previous = body.visibility !== undefined ? (await this.spaces.getById(id))?.visibility : undefined;
    const topic = await this.spaces.update(id, body);
    // A no-op flip (private → private) is not a change and must not read as one
    // in the log; `previous` is undefined when the request never named the field.
    if (previous !== undefined && previous !== topic.visibility) {
      await this.audit.record({
        actor_id: actor.id,
        action: 'space.visibility_change',
        payload: { space_id: topic.id, slug: topic.slug, from: previous, to: topic.visibility },
      });
    }
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
