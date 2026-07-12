import { Controller, Get } from '@nestjs/common';
import { PublicRead } from '../auth/auth.decorators.js';
import { listContentTypes } from './content-types.registry.js';

/**
 * The first-class content-type vocabulary (OKF concept kinds) with templates and
 * domain frontmatter. Readable by anyone who may read content so the composer /
 * editor can offer the picker and scaffolds; the list is code-defined (no admin
 * write path yet).
 */
@Controller('content-types')
export class ContentTypesController {
  @PublicRead()
  @Get()
  list() {
    return { content_types: listContentTypes() };
  }
}
