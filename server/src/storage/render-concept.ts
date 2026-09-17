/**
 * The one OKF concept renderer for the canonical file (plan §7.2–7.3). Both the
 * write-first command (which writes the file BEFORE the index) and the git
 * mirror adapter (which used to write it after) render through here, so the
 * bytes are identical and the adapter's content no-op guard finds the file the
 * command wrote and only schedules the commit.
 */
import type { Kysely } from 'kysely';
import { pageToConcept, type PageInput } from '@echozedlabs/okf';
import type { Database } from '../db/schema.js';
import type { RevisionMirrorEvent } from './revision-mirror.port.js';

/** The fields `pageToConcept` needs — a `PageView`, or the same shape built before the row exists. */
export interface PageLike {
  id: string;
  slug: string;
  title: string;
  raw_markdown: string;
  status: 'draft' | 'published';
  space_id: string | null;
  owner_id: string | null;
  tags: string[];
  categories: string[];
  groups: string[];
  created_at: string;
  updated_at: string;
  version_token: number;
  current_version_id: string | null;
}

export interface RenderedConceptFile {
  /** Repo-relative posix path: `<conceptDir>/<slug>.md`. */
  path: string;
  content: string;
}

/** Render the concept file for `view` as it lands in `conceptDir` of its repo. */
export function renderConceptFile(view: PageLike, spaceName: string | null, conceptDir: string): RenderedConceptFile {
  const concept = pageToConcept(toPageInput(view, spaceName), () => undefined, {
    linkStyle: 'preserve',
    conceptDir,
  });
  return { path: concept.path, content: concept.content };
}

export function pageLikeFromEvent(event: RevisionMirrorEvent): PageLike {
  return {
    id: event.itemId,
    slug: event.slug,
    title: event.title,
    raw_markdown: event.rawMarkdown,
    status: event.status,
    space_id: event.spaceId,
    owner_id: event.ownerId,
    tags: event.tags,
    categories: event.categories,
    groups: event.groups,
    created_at: event.createdAt,
    updated_at: event.updatedAt,
    version_token: event.versionToken,
    current_version_id: event.versionId,
  };
}

/**
 * The space value embedded in a concept: the human *name*, not the internal
 * `space_*` id, so a rebuild's `ensureSpace` resolves it back to the same space
 * (slugifying the id would mint a divergent one). Null for the default space.
 */
export async function exportSpaceName(db: Kysely<Database>, spaceId: string | null): Promise<string | null> {
  if (!spaceId || spaceId === 'space_default') return null;
  const row = await db.selectFrom('spaces').select('name').where('id', '=', spaceId).executeTakeFirst();
  return row?.name ?? null;
}

function toPageInput(view: PageLike, space: string | null): PageInput {
  return {
    id: view.id,
    slug: view.slug,
    title: view.title,
    status: view.status,
    space,
    ownerId: view.owner_id,
    tags: view.tags,
    categories: view.categories,
    groups: view.groups,
    rawMarkdown: view.raw_markdown,
    createdAt: view.created_at,
    updatedAt: view.updated_at,
  };
}
