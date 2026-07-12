import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { OkfController } from './okf.controller.js';
import { OkfExportService } from './okf-export.service.js';
import { OkfImportService } from './okf-import.service.js';

/**
 * OKF (Open Knowledge Format) interchange. Hosts the import service that
 * round-trips OKF bundles back into Knowledge E3, the export service, and the
 * human-facing /okf HTTP bridge (download/upload). Export is also offered through
 * the MCP `knowledge.export_okf` / `import_okf` tools and the `export:okf` script.
 */
@Module({
  imports: [ItemsModule],
  controllers: [OkfController],
  providers: [OkfImportService, OkfExportService],
  exports: [OkfImportService, OkfExportService],
})
export class OkfModule {}
