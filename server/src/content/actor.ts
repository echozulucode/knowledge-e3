/**
 * Bridge between the server's authenticated user and the `Actor` contract in
 * `@echozedlabs/knowledge-types`. The seam needs the caller's role as well
 * (the page services enforce owner-or-admin on every mutation), so the server
 * carries it alongside the shared fields.
 */
import type { Actor, WriteSource } from '@echozedlabs/knowledge-types';
import { e3OwnerToActor } from '@echozedlabs/okf';
import type { ReadActor } from '../pages/pages.service.js';

export interface ServerActor extends Actor {
  role: 'user' | 'admin';
}

/**
 * `okfActor` is `human:<username>` (falling back to the id) so a verification
 * appended by this actor tiers as human-reviewed; the local-system account
 * maps to `process:knowledge-e3` like every other system owner.
 */
export function actorFrom(user: { id: string; username?: string; role?: string }, via: WriteSource): ServerActor {
  return {
    userId: user.id,
    okfActor: e3OwnerToActor(user.username ?? user.id),
    via: { kind: via },
    role: user.role === 'admin' ? 'admin' : 'user',
  };
}

export function readActorOf(actor: ServerActor): ReadActor {
  return { id: actor.userId, role: actor.role };
}
