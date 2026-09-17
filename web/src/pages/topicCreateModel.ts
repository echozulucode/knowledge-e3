/**
 * The New Topic dialog's visibility rule and request body
 * (the admin UX review §2 #7).
 *
 * Public stays the default for a topic that starts empty — the site is
 * browseable by anonymous visitors by default. A topic bound to a repository is
 * different: its content arrives in bulk, possibly in the same request that
 * creates it (`repo.pull`), and nobody has read it yet. Creating it public and
 * flipping it afterwards would expose that content in between, which is why
 * `POST /topics` accepts `visibility` at creation. So a repository URL
 * preselects Private — until the admin picks a visibility themselves, after
 * which their choice stands whatever the URL does.
 */

export type TopicVisibility = 'public' | 'private';

/** Matches the server's column (`CreateTopicDto.slug`, `@MaxLength(100)`). */
export const TOPIC_SLUG_MAX = 100;

/**
 * The slug the server will store for this input. Mirrors `slugify` in
 * server/src/common/slug.ts — including its diacritic folding, which the
 * Sections slug does not do — because `SpacesService.create` runs whatever the
 * dialog sends through it again. Showing anything else would promise a URL the
 * topic does not get. Empty in, empty out: the server's `'untitled'` fallback
 * is a last resort the dialog should not suggest.
 */
export function slugifyTopic(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TOPIC_SLUG_MAX);
}

/**
 * What is wrong with the slug the dialog would send, or null. A clash is
 * checked against the topics the list already has, so it shows while typing;
 * an archived topic still holds its slug, which only the server knows about —
 * its 409 lands in the dialog's error instead.
 */
export function topicSlugProblem(slug: string, existing: readonly { slug: string }[]): string | null {
  if (!slug) return 'Enter a name or a slug with at least one letter or number.';
  if (slug.length > TOPIC_SLUG_MAX) return `Keep the slug to ${TOPIC_SLUG_MAX} characters.`;
  if (existing.some((topic) => topic.slug === slug)) return `Another topic already uses /topics/${slug}.`;
  return null;
}

/** The visibility the dialog should show after the repository URL changed. */
export function visibilityForRepoUrl(repoUrl: string, current: TopicVisibility, chosenByAdmin: boolean): TopicVisibility {
  if (chosenByAdmin) return current;
  return repoUrl.trim() ? 'private' : 'public';
}

export interface CreateTopicFields {
  name: string;
  slug: string;
  description: string;
  visibility: TopicVisibility;
  repoUrl: string;
  repoBranch: string;
  repoPull: boolean;
}

export interface CreateTopicBody {
  name: string;
  slug?: string;
  description?: string;
  visibility: TopicVisibility;
  repo?: { remote_url: string; branch?: string; pull?: boolean };
}

export function createTopicBody(fields: CreateTopicFields): CreateTopicBody {
  const repoUrl = fields.repoUrl.trim();
  return {
    name: fields.name.trim(),
    slug: fields.slug.trim() || undefined,
    description: fields.description.trim() || undefined,
    // Always sent, so the topic is created with the exposure the dialog showed
    // rather than whatever the server default happens to be.
    visibility: fields.visibility,
    repo: repoUrl ? { remote_url: repoUrl, branch: fields.repoBranch.trim() || undefined, pull: fields.repoPull } : undefined,
  };
}
