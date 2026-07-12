import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { SpacesService } from './spaces.service.js';

@Module({
  imports: [DbModule, StorageModule],
  controllers: [TaxonomyController],
  providers: [SpacesService],
  exports: [SpacesService],
})
export class TaxonomyModule {}
