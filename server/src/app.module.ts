import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbModule } from './db/db.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { ContentTypesModule } from './content-types/content-types.module.js';
import { CsrfGuard } from './common/csrf.guard.js';
import { PagesModule } from './pages/pages.module.js';
import { ItemsModule } from './items/items.module.js';
import { WikiModule } from './wiki/wiki.module.js';
import { SearchModule } from './search/search.module.js';
import { BugReportModule } from './bugreport/bugreport.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { LoggerModule } from './logger/logger.module.js';
import { TaxonomyModule } from './taxonomy/taxonomy.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { OkfModule } from './okf/okf.module.js';
import { StorageModule } from './storage/storage.module.js';
import { ImagesModule } from './images/images.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    LoggerModule,
    DbModule,
    AuditModule,
    AuthModule,
    ConfigModule,
    ContentTypesModule,
    WikiModule,
    PagesModule,
    ItemsModule,
    McpModule,
    OkfModule,
    StorageModule,
    ImagesModule,
    TaxonomyModule,
    SearchModule,
    BugReportModule,
    TelemetryModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
})
export class AppModule {}
