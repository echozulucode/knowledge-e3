/**
 * Bridge between the server's `ReadActor` (the shape every read service takes)
 * and the `Viewer` contract in `@echozedlabs/knowledge-types`.
 *
 * Anonymous visitors are represented server-side by the ANONYMOUS_ACTOR
 * sentinel (a non-admin id that can never own content); in the seam they are
 * `{ userId: null, role: 'anonymous' }`. Both directions are lossless for the
 * three roles the read services distinguish.
 */
import type { Viewer } from '@echozedlabs/knowledge-types';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { isAnonymousActor, type ReadActor } from '../pages/pages.service.js';

export function viewerFrom(user: { id: string; role: string } | undefined): Viewer {
  if (!user || isAnonymousActor(user as ReadActor)) return { userId: null, role: 'anonymous' };
  return { userId: user.id, role: user.role === 'admin' ? 'admin' : 'user' };
}

export function toReadActor(viewer: Viewer): ReadActor {
  if (viewer.role === 'anonymous' || viewer.userId === null) {
    return { id: ANONYMOUS_ACTOR.id, role: ANONYMOUS_ACTOR.role };
  }
  return { id: viewer.userId, role: viewer.role };
}
