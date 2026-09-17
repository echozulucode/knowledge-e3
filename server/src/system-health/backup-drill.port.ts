/**
 * The Restore-drill row's source (issue 71).
 *
 * The drill itself lives outside this module — a scheduled command that backs
 * up, restores into an isolated instance, boots it and reads from it
 * (`server/scripts/restore-drill.ts`). System health only *reports* its
 * outcome, which is why the seam is a port rather than an import: the producer
 * registers itself under {@link BACKUP_DRILL_STATUS}, and this module depends
 * on nothing but the shared `BackupDrillStatus` contract.
 *
 * **An absent producer is not an absent finding.** When no provider is
 * registered the service reports {@link NEVER_DRILLED} — `outcome: 'never'` —
 * because "nothing schedules a drill here" and "a drill is scheduled and has
 * not run yet" are the same fact from the operator's chair: this instance's
 * recovery has not been rehearsed. Rendering that as "no data" would be exactly
 * the silence issue 71 exists to break.
 */
import type { BackupDrillStatus } from '@echozedlabs/knowledge-types';

export const BACKUP_DRILL_STATUS = Symbol('BACKUP_DRILL_STATUS');

export interface BackupDrillStatusPort {
  /** The most recent drill's outcome, or a `never` record. Must not run a drill. */
  status(): Promise<BackupDrillStatus> | BackupDrillStatus;
}

/** What an instance with no drill producer, and an instance that has never drilled, both look like. */
export const NEVER_DRILLED: BackupDrillStatus = {
  outcome: 'never',
  last_run_at: null,
  rpo_seconds: null,
  rto_seconds: null,
  failure: null,
  next_run_at: null,
};
