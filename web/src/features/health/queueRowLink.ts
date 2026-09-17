/**
 * Where a Content health queue row points (the admin UX review §2 #11).
 *
 * Every queue member is a live item an admin fixes in Compose — except the
 * `declined_removal_still_deleted` queue, whose members are soft-deleted rows.
 * Their `/p/$slug/edit` page is the editor of an item that no longer exists, so
 * the useful destination is the change request the reviewer declined, which the
 * server already sends as `review.url`. A deleted row with no recorded URL is
 * shown as its title alone: a dead link would be worse than none.
 */
import type { HealthQueueItem, QueueName } from './queries.js';

export type QueueRowLink =
  | { kind: 'edit'; slug: string }
  | { kind: 'change-request'; url: string }
  | { kind: 'text' };

export function queueRowLink(queue: QueueName, item: Pick<HealthQueueItem, 'slug' | 'review'>): QueueRowLink {
  if (queue !== 'declined_removal_still_deleted') return { kind: 'edit', slug: item.slug };
  const url = item.review?.url?.trim();
  // Only a web address becomes a link; anything else would be an href the
  // browser resolves against this app.
  return url && /^https?:\/\//i.test(url) ? { kind: 'change-request', url } : { kind: 'text' };
}
