import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsArray } from 'class-validator';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService, type SectionDef } from './config.service.js';
import { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { viewerFrom } from '../query/viewer.js';

class SectionsDto {
  @IsArray() sections!: SectionDef[];
}

/**
 * Curated sections (type × space). Readable by anyone who may read content so the
 * section nav/landing pages work; only admins curate the list.
 */
@Controller('sections')
export class SectionsController {
  constructor(
    private readonly config: ConfigService,
    private readonly query: KnowledgeQueryService,
  ) {}

  @PublicRead()
  @Get()
  async list() {
    return { sections: await this.config.getSections() };
  }

  /**
   * The cross-topic sections — those naming no topic — resolved to their items
   * for the caller. Its own route rather than a flag on `/topics/:slug/landing`
   * because these belong to the FRONT PAGE, not to any topic: a topic landing
   * must keep showing only the sections that name it.
   */
  @PublicRead()
  @Get('cross-topic')
  async crossTopic(@CurrentUser() user: AuthedUser) {
    return { sections: await this.query.crossTopicSections(viewerFrom(user)) };
  }

  @AdminOnly()
  @Put()
  async replace(@CurrentUser() actor: AuthedUser, @Body() body: SectionsDto) {
    const sections = await this.config.setSections(body.sections ?? [], actor.id);
    return { sections };
  }
}
