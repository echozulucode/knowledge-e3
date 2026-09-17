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
import { McpReadBackend } from './mcp-read-backend.js';
import { McpService } from './mcp.service.js';
import { CreateItemTool } from './tools/create-item.tool.js';
import { ExportOkfTool } from './tools/export-okf.tool.js';
import { GetItemTool } from './tools/get-item.tool.js';
import { ImportOkfTool } from './tools/import-okf.tool.js';
import { ListContentTypesTool } from './tools/list-content-types.tool.js';
import { ListSpacesTool } from './tools/list-spaces.tool.js';
import { ListTaxonomyTool } from './tools/list-taxonomy.tool.js';
import { PublishItemTool } from './tools/publish-item.tool.js';
import { SearchTool } from './tools/search.tool.js';
import { SuggestMetadataTool } from './tools/suggest-metadata.tool.js';
import { UpdateItemTool } from './tools/update-item.tool.js';
import { ValidateItemTool } from './tools/validate-item.tool.js';
import { ValidateOkfBundleTool } from './tools/validate-okf-bundle.tool.js';

@Module({
  imports: [AuthModule, DbModule, ItemsModule, PagesModule, SearchModule, TaxonomyModule, AuditModule, OkfModule],
  controllers: [McpController],
  providers: [
    McpService,
    McpReadBackend,
    GetItemTool,
    ListSpacesTool,
    ListTaxonomyTool,
    ListContentTypesTool,
    SearchTool,
    CreateItemTool,
    ExportOkfTool,
    ImportOkfTool,
    ValidateOkfBundleTool,
    SuggestMetadataTool,
    ValidateItemTool,
    UpdateItemTool,
    PublishItemTool,
  ],
  exports: [CreateItemTool],
})
export class McpModule {}
