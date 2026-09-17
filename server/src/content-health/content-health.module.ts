import { Module } from '@nestjs/common';
import { OkfModule } from '../okf/okf.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { ContentHealthController } from './content-health.controller.js';
import { ContentHealthService } from './content-health.service.js';

/** Content health (plan §6.3): the OKF audit plus E3 work queues, admin-only. */
@Module({
  imports: [PagesModule, OkfModule],
  controllers: [ContentHealthController],
  providers: [ContentHealthService],
})
export class ContentHealthModule {}
