import { Module } from '@nestjs/common';
import { ContentTypesController } from './content-types.controller.js';

/**
 * Serves the code-defined content-type registry. Stateless — the registry lives
 * in `content-types.registry.ts` and is imported directly where needed
 * (PagesService canonicalization, the MCP tool).
 */
@Module({
  controllers: [ContentTypesController],
})
export class ContentTypesModule {}
