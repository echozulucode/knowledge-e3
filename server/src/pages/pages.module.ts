import { Module } from '@nestjs/common';
import { PagesService } from './pages.service.js';
import { PagesController } from './pages.controller.js';
import { BacklinksController } from './backlinks.controller.js';
import { WikiModule } from '../wiki/wiki.module.js';

@Module({
  imports: [WikiModule],
  controllers: [PagesController, BacklinksController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
