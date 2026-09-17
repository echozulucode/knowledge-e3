import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from './auth/auth.decorators.js';
import { SystemHealthService } from './system-health/system-health.service.js';

/**
 * The two probes, which answer two different questions (plan §5, item 13).
 *
 * `/healthz` is LIVENESS and `/readyz` is READINESS. They are not two spellings
 * of the same thing, and the difference decides what a supervisor does with the
 * answer: liveness failing means "restart this process", readiness failing means
 * "stop sending it traffic until it says otherwise".
 */
@Controller()
export class HealthController {
  constructor(private readonly system: SystemHealthService) {}

  /**
   * Liveness. **Deliberately unconditional — do not add dependency checks here.**
   *
   * This endpoint answers exactly one question: is this process alive and able
   * to route an HTTP request? That is precisely what a restart-on-failure
   * supervisor (Docker's HEALTHCHECK, a Kubernetes livenessProbe, Azure
   * Container Apps) should read, and the only remedy it has is a restart.
   *
   * Folding the database, the content root or the git mirror into it would mean
   * a database blip restarts a perfectly healthy process — and a restart makes
   * every one of those conditions strictly worse, because it throws away the
   * in-flight work and the outbox replay has to run again. If you came here to
   * "fix" this by making it check something: the check you want belongs in
   * `/readyz` (readiness, bounded, `@Public`) or in `/admin/health/system`
   * (the full operational report, admin-only). Both already exist.
   */
  @Public()
  @Get('healthz')
  healthz() {
    return 'ok';
  }

  /**
   * Readiness: can this instance serve requests correctly right now?
   *
   * Bounded by `SystemHealthService.READINESS_CHECKS` — the database answers,
   * the schema is the one this binary queries, and the content root resolves.
   * That is narrower than "is everything well" on purpose; the service's
   * `readiness()` doc lists what is excluded and why.
   *
   * Two constraints shape the response:
   *
   *  1. **It leaks nothing.** A load balancer cannot authenticate, so this is
   *     `@Public()` — and an anonymous caller therefore gets a bare status and
   *     an HTTP code, never the check ids, paths, env var names or error text
   *     that `/admin/health/system` returns. The reason is logged server-side.
   *  2. **It is cheap.** Every check runs in its shallow form (one `SELECT 1`,
   *     one `sqlite_master` read, one `stat`) because this is polled every few
   *     seconds. No `PRAGMA quick_check`, no disk probe write.
   *
   * 200 + `{status:'ready'}` when ready; 503 + `{status:'not ready'}` when not,
   * so a probe that only reads the status code still gets the right answer.
   */
  @Public()
  @Get('readyz')
  async readyz(@Res() res: Response): Promise<void> {
    const { ready } = await this.system.readiness();
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({ status: ready ? 'ready' : 'not ready' });
  }
}
