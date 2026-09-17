import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbModule } from './db/db.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BackupModule } from './backup/backup.module.js';
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
import { QueryModule } from './query/query.module.js';
import { ContentModule } from './content/content.module.js';
import { OutboxModule } from './content/outbox.module.js';
import { ContentStoreModule } from './storage/content-store.module.js';
import { FeedModule } from './feed/feed.module.js';
import { PopularModule } from './popular/popular.module.js';
import { ContentHealthModule } from './content-health/content-health.module.js';
import { SyncModule } from './sync/sync.module.js';
import { SystemHealthModule } from './system-health/system-health.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    LoggerModule,
    DbModule,
    ContentStoreModule,
    OutboxModule,
    AuditModule,
    AuthModule,
    ConfigModule,
    ContentTypesModule,
    WikiModule,
    PagesModule,
    ItemsModule,
    QueryModule,
    ContentModule,
    FeedModule,
    PopularModule,
    ContentHealthModule,
    SystemHealthModule,
    SyncModule,
    BackupModule,
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
