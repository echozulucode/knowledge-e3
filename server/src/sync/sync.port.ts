/**
 * The one thing the write path needs from the sync engine: "push soon". Kept
 * behind a token so `ContentCommandsService` (which the engine's inbound
 * indexer calls) never imports `SyncService` — no DI cycle, no ESM cycle.
 */
export const SYNC_PUSH = Symbol('SYNC_PUSH');

export interface SyncPushPort {
  /** Flag a push for `sourceId` and run a cycle in the background. Resolves when the cycle ends. */
  requestPush(sourceId: string, reason: 'publish' | 'manual'): Promise<unknown>;
}
