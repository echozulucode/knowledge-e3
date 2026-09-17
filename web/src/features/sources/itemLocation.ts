/**
 * "Where this lives" for one item (plan B1) — the registry id, the repo-relative
 * file path, and the file on its host.
 *
 * No server work: `item.source` already carries all three. What it does NOT
 * carry is the same for every viewer, and that is the whole subtlety here. The
 * server redacts the ref on the way out (`redactSourceForViewer`): `role` and
 * `mode` reach everyone because they are claims about trust; `url` requires a
 * sign-in, because a public instance may front a private repository; `path` is
 * **admin-only**; and the ref is dropped from list rows entirely below admin.
 *
 * So this must degrade rather than look broken, because for most viewers it
 * always will be partial. It also answers the asymmetry the two halves of the
 * UX plan are built on: the reader is promised one library and must not be made
 * to feel the distribution, while the administrator is promised the truth about
 * it. Hence the rule below — the id alone is not "where this lives", it is just
 * a word; the block appears only when there is a path or a door to show, which
 * is exactly the viewer the server decided may see one.
 */
import type { ItemSourceRef } from '@echozedlabs/knowledge-types';

export interface ItemLocation {
  /** Source registry id — `main`, `topic:matlab`. */
  id: string;
  /** Repo-relative posix path of the canonical file. Admin-only, so usually null. */
  path: string | null;
  /** The file on the host's web UI. Needs a sign-in, and an addressable remote. */
  url: string | null;
}

export function itemLocation(source: ItemSourceRef | null | undefined): ItemLocation | null {
  if (!source?.id) return null;
  const path = source.path?.trim() || null;
  const url = source.url?.trim() || null;
  if (!path && !url) return null;
  return { id: source.id, path, url };
}
