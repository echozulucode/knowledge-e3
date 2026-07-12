import { Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';
import { ConfigController } from './config.controller.js';
import { PrefsController } from './prefs.controller.js';
import { AccessController } from './access.controller.js';
import { SectionsController } from './sections.controller.js';

@Module({
  controllers: [ConfigController, PrefsController, AccessController, SectionsController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
