import { Controller, Get } from '@nestjs/common';
import { AdminOnly } from '../auth/auth.decorators.js';
import { SystemHealthService } from './system-health.service.js';

/**
 * Admin → Health → System (plan §5): the protected operational-health detail
 * endpoint issue 71 has asked for since 2026-08-13.
 *
 *   GET /admin/health/system
 *
 * Admin-only, and it must stay that way: the report names filesystem paths,
 * source ids, env var NAMES and merge-conflict counts. Its anonymous sibling is
 * `/readyz`, which returns a bare status over a subset of the same checks.
 */
@Controller('admin/health')
export class SystemHealthController {
  constructor(private readonly health: SystemHealthService) {}

  @AdminOnly()
  @Get('system')
  system() {
    return this.health.report();
  }
}
