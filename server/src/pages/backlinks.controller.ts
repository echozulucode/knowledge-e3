import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service.js';
import { WikiService } from '../wiki/wiki.service.js';
import { CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';

@Controller('pages')
export class BacklinksController {
  constructor(
    private readonly pages: PagesService,
    private readonly wiki: WikiService,
  ) {}

  @PublicRead()
  @Get(':id/backlinks')
  async backlinks(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    const page =
      (await this.pages.getById(id, { actor: user })) ??
      (await this.pages.getBySlug(id, user)) ??
      (await this.pages.getByTitle(id, user));
    if (!page) throw new NotFoundException();
    const backlinks = await this.wiki.backlinks(
      { id: page.id, slug: page.slug, title: page.title },
      user,
    );
    return { backlinks };
  }
}
