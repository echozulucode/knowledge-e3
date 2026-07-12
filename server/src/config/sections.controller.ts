import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsArray } from 'class-validator';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ConfigService, type SectionDef } from './config.service.js';

class SectionsDto {
  @IsArray() sections!: SectionDef[];
}

/**
 * Curated sections (type × space). Readable by anyone who may read content so the
 * section nav/landing pages work; only admins curate the list.
 */
@Controller('sections')
export class SectionsController {
  constructor(private readonly config: ConfigService) {}

  @PublicRead()
  @Get()
  async list() {
    return { sections: await this.config.getSections() };
  }

  @AdminOnly()
  @Put()
  async replace(@CurrentUser() actor: AuthedUser, @Body() body: SectionsDto) {
    const sections = await this.config.setSections(body.sections ?? [], actor.id);
    return { sections };
  }
}
