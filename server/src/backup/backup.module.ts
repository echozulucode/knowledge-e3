import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ItemsModule } from '../items/items.module.js';
import { BackupDrillService } from './backup-drill.service.js';
import { ChildProcessDrillRunner, DRILL_RUNNER } from './drill-runner.js';

/**
 * The scheduled restore drill (issue 71). No controller: the schedule is the
 * product surface, and the only read is `BackupDrillService.status()`, which
 * the system-health verdict consumes in-process.
 *
 * Global so that consumer can inject the service without importing this module
 * — the same reason `SyncModule` and `AuditModule` are global, and the same
 * reason there is no import cycle: nothing here is imported back by anything it
 * depends on.
 *
 * `ItemsModule` is imported for `REVISION_MIRROR` (the pre-capture flush; see
 * `BackupDrillService.quiesce`). `ConfigModule` for `app_config`. `SyncService`
 * and `AuditService` arrive through their own global modules.
 *
 * `DRILL_RUNNER` is a token rather than a direct dependency so the suite can
 * substitute a runner that spawns nothing — without it, every test of the
 * scheduler would be a test that copies an entire instance.
 */
@Global()
@Module({
  imports: [ConfigModule, ItemsModule],
  providers: [BackupDrillService, { provide: DRILL_RUNNER, useClass: ChildProcessDrillRunner }],
  exports: [BackupDrillService],
})
export class BackupModule {}
