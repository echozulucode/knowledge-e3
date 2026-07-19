import { Module } from '@nestjs/common';
import { WikiModule } from '../wiki/wiki.module.js';
import { ItemsModule } from '../items/items.module.js';
import { OkfModule } from '../okf/okf.module.js';
import { ImagesModule } from '../images/images.module.js';
import { IndexRebuildService } from './index-rebuild.service.js';
import { RepoConfigService } from './repo-config.service.js';
import { RepoPullService } from './repo-pull.service.js';
import { ReposController } from './repos.controller.js';

/**
 * Storage-layer services for the git-of-record model (ADR-0001). Hosts the
 * Phase B rebuild-from-git path, the admin per-topic backend-repo mappings
 * (Admin → Repos), and repo→topic pull. The git mirror adapter is wired in
 * ItemsModule.
 */
@Module({
  imports: [WikiModule, ItemsModule, OkfModule, ImagesModule],
  controllers: [ReposController],
  providers: [IndexRebuildService, RepoConfigService, RepoPullService],
  exports: [IndexRebuildService, RepoConfigService, RepoPullService],
})
export class StorageModule {}
