import { Injectable } from '@nestjs/common';
import type { MirroredFile } from './git-revision-mirror.adapter.js';
import type { MovedOutSource, RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

@Injectable()
export class NoopRevisionMirrorAdapter implements RevisionMirrorPort {
  /**
   * With no git repo there is nothing to commit, so the write-first outbox row
   * for an item is complete the moment its index transaction landed. Optional
   * so the adapter can still be constructed bare (tests, seams).
   */
  constructor(private readonly onCommitted?: (committed: MirroredFile[], at: string) => Promise<void>) {}

  async afterItemVersionPersisted(event: RevisionMirrorEvent): Promise<void> {
    // The database is the transactional store; storage mirrors develop behind
    // this seam. Only the outbox bookkeeping happens here. `path: null` — there
    // is no repo, so every pending row for the item is complete, including the
    // source-side `move` row of a topic change.
    await this.onCommitted?.([{ itemId: event.itemId, path: null }], new Date().toISOString());
  }

  /**
   * A soft delete (issue 76). There is no repo, so the file the command already
   * unlinked is the whole of the change and the `delete` outbox row is complete
   * — the same `path: null` "everything for this item" settlement the write
   * above uses. Without this the row would stay pending forever on a DB-only
   * instance, and the replay would keep re-emitting it.
   */
  async afterItemRemoved(_from: MovedOutSource, event: { itemId: string }): Promise<void> {
    await this.onCommitted?.([{ itemId: event.itemId, path: null }], new Date().toISOString());
  }
}
