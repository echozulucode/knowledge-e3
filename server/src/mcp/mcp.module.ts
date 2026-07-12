import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { SearchModule } from '../search/search.module.js';
import { TaxonomyModule } from '../taxonomy/taxonomy.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OkfModule } from '../okf/okf.module.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';
import { CreateItemTool } from './tools/create-item.tool.js';
import { ExportOkfTool } from './tools/export-okf.tool.js';
import { ImportOkfTool } from './tools/import-okf.tool.js';
import { ListContentTypesTool } from './tools/list-content-types.tool.js';
import { ListSpacesTool } from './tools/list-spaces.tool.js';
import { ListTaxonomyTool } from './tools/list-taxonomy.tool.js';
import { SearchTool } from './tools/search.tool.js';

@Module({
  imports: [AuthModule, DbModule, ItemsModule, PagesModule, SearchModule, TaxonomyModule, AuditModule, OkfModule],
  controllers: [McpController],
  providers: [McpService, ListSpacesTool, ListTaxonomyTool, ListContentTypesTool, SearchTool, CreateItemTool, ExportOkfTool, ImportOkfTool],
  exports: [CreateItemTool],
})
export class McpModule {}
