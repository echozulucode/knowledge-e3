import { Module } from '@nestjs/common';
import { BackupDrillService } from '../backup/backup-drill.service.js';
import { BACKUP_DRILL_STATUS, type BackupDrillStatusPort } from './backup-drill.port.js';
import { SystemHealthController } from './system-health.controller.js';
import { SystemHealthService } from './system-health.service.js';

/**
 * System health (plan §5): the instance-level report and the readiness subset.
 *
 * It imports nothing. Everything it reads comes from modules that are already
 * `@Global` — `DbModule` (KYSELY), `ContentStoreModule` (`ContentPathResolver`),
 * `SyncModule` (`SyncService`) and `BackupModule` (`BackupDrillService`) — so
 * this module cannot form an import cycle with any of them.
 *
 * The one line of coupling to the restore drill lives here rather than in the
 * service: the service depends only on `BACKUP_DRILL_STATUS`, and this binding
 * adapts whatever producer the instance happens to have. The injection is
 * OPTIONAL and the fallback is `null`, which the service reports as
 * `outcome: 'never'` — an instance with no drill producer has not rehearsed a
 * restore, and saying so is the point of issue 71.
 *
 * `SystemHealthService` is exported because `HealthController` (`/readyz`)
 * lives in `AppModule` and runs the readiness subset.
 */
@Module({
  controllers: [SystemHealthController],
  providers: [
    SystemHealthService,
    {
      provide: BACKUP_DRILL_STATUS,
      useFactory: (drill?: BackupDrillService): BackupDrillStatusPort | null => drill ?? null,
      inject: [{ token: BackupDrillService, optional: true }],
    },
  ],
  exports: [SystemHealthService],
})
export class SystemHealthModule {}
