import { Module } from '@nestjs/common';
import { AssetsService } from './assets.service.js';
import { ImagesService } from './images.service.js';
import { ImagesController } from './images.controller.js';

/**
 * Images/assets: upload, serve (bundle-relative `/assets/<file>`), and admin
 * management (usage counts + orphan detection). Bytes live in the bundle's
 * `assets/` dir (git-of-record); the DB holds the derived metadata + link index.
 */
@Module({
  controllers: [ImagesController],
  providers: [ImagesService, AssetsService],
  exports: [ImagesService, AssetsService],
})
export class ImagesModule {}
