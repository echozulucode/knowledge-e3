import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { auditRetentionDays } from '../config/server-config.js';
import { AuditService } from './audit.service.js';

/** The action the trim writes about itself. Not a content action — no page_id. */
export const AUDIT_RETENTION_ACTION = 'audit.retention_trim';

/**
 * Audit retention (plan §6 D3), on boot.
 *
 * D2 multiplies the log's write rate by an order of magnitude — `auth.login`
 * alone fires once per sign-in — so an unpruned table is both a cost and a
 * liability: the oldest rows are the least useful and the most sensitive thing
 * still on disk. `audit.retention` (default 365 days) is the knob; see
 * `server-config.ts` for its precedence and units.
 *
 * The deletion is made observable two ways, because "records silently vanished"
 * and "retention ran" must never look alike to an operator:
 *  - a log line naming the cutoff, the count and the configured window, and
 *  - a row IN THE AUDIT LOG ITSELF (`audit.retention_trim`), written after the
 *    delete so it survives it. A gap in the log is then explained by a record
 *    inside the log, which is the only place an administrator is looking.
 */
@Injectable()
export class AuditRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger('audit');

  constructor(private readonly audit: AuditService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Never fatal, and the failure mode is "kept too much", never "deleted the
    // wrong thing": a malformed window skips the trim entirely. (A malformed
    // window in the CONFIG FILE still refuses the boot, in `loadServerConfig`,
    // the same way `git.commit.quiet` does — only the env override lands here.)
    await this.trim().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`retention did not run; nothing was removed: ${reason}`);
    });
  }

  /**
   * Delete rows older than the configured window. Returns what happened so a
   * test — and a caller that wants to report it — can see it.
   */
  async trim(): Promise<{ removed: number; cutoff: string | null; retention_days: number | null }> {
    const days = auditRetentionDays();
    if (days === null) return { removed: 0, cutoff: null, retention_days: null };

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const removed = await this.audit.trim(cutoff);
    if (removed > 0) {
      this.logger.log(`retention: removed ${removed} row(s) older than ${cutoff} (audit.retention = ${days}d)`);
      await this.audit.record({
        actor_id: null,
        action: AUDIT_RETENTION_ACTION,
        payload: { removed, cutoff, retention_days: days },
      });
    }
    return { removed, cutoff, retention_days: days };
  }
}
