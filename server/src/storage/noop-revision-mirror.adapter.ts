import { Injectable } from '@nestjs/common';
import type { RevisionMirrorEvent, RevisionMirrorPort } from './revision-mirror.port.js';

@Injectable()
export class NoopRevisionMirrorAdapter implements RevisionMirrorPort {
  async afterItemVersionPersisted(_event: RevisionMirrorEvent): Promise<void> {
    // Intentionally empty: first MVP keeps the database as the transactional
    // source of truth while storage mirrors are developed behind this seam.
  }
}
