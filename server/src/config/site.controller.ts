import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { IsArray } from 'class-validator';
import type { Kysely } from 'kysely';
import { parseBundleIndex, type BundleLink } from '@echozedlabs/okf';
import { AdminOnly, CurrentUser, Public, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { viewerFrom } from '../query/viewer.js';
import { ContentPathResolver } from '../storage/content-path.resolver.js';
import { ConfigService, type PinnedTopicDef } from './config.service.js';
import { loadServerConfig } from './server-config.js';

/** The topic the shared main repository's own root `index.md` belongs to. */
const DEFAULT_TOPIC_SLUG = 'default';

/**
 * The entries are deliberately not nested-validated: `normalizePin` is the one
 * place a pin's fields (`topic`, `color`, `icon`, `cover`, `cover_dark`) are
 * checked, and it drops a malformed field rather than refusing the whole list.
 * `whitelist` only strips undecorated properties of THIS class, so every pin
 * field reaches the normalizer intact.
 */
class PinnedTopicsDto {
  @IsArray() pinned!: PinnedTopicDef[];
}

/**
 * One pin as the home page renders it: the curator's fields plus the topic's
 * own name and description, resolved for the calling viewer.
 *
 * `name === null` means "this pin names nothing this viewer can see". Those
 * entries are omitted for everyone except an admin, who gets them back so the
 * admin surface can show a dead pin instead of silently eating the row they
 * just typed. The omission is the security half: `visibility: 'private'` means
 * "not exposed to anonymous visitors", and a pin must never be a way around
 * that — a pinned private topic would otherwise put its name, its description
 * and its cover image on the most public page in the product.
 */
export interface PinnedTopicView {
  topic: string;
  name: string | null;
  description: string | null;
  color: string | null;
  /** A `PIN_ICONS` token name, or null. */
  icon: string | null;
  cover: string | null;
  cover_dark: string | null;
}

/**
 * Site-wide presentation settings the web app needs before it can render its
 * first screen. Public for the same reason `GET /access` is: an anonymous
 * visitor lands on Home, and Home has to know which topic it is — and, since
 * the reader plan's §4, whose logo and name to put on the chrome.
 */
@Controller()
export class SiteController {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly paths: ContentPathResolver,
    private readonly config: ConfigService,
  ) {}

  /**
   * Tenant identity and site-wide presentation, snake_case like every other
   * payload. Every field is nullable: null means "the operator set nothing",
   * and the web app answers with the built-in default rather than a blank —
   * so an instance with no `site:` block renders exactly as it always has.
   */
  @Public()
  @Get('site')
  getSite() {
    const site = loadServerConfig().site;
    return {
      home_topic: site.homeTopic ?? null,
      name: site.name ?? null,
      short_name: site.shortName ?? null,
      logo: site.logo ?? null,
      // A tenant with one logo gets it in both themes; the fallback lives here
      // rather than in the client so every surface agrees.
      logo_dark: site.logoDark ?? site.logo ?? null,
      favicon: site.favicon ?? null,
      tagline: site.tagline ?? null,
      search_placeholder: site.searchPlaceholder ?? null,
    };
  }

  /**
   * Curated landing-page links for a topic — Eric's "links to sections from the
   * main page" (reader plan §4, R2.4).
   *
   * They are read from the topic's own bundle `index.md` (`links:`), not from a
   * table and not from this host's configuration, because that is the one place
   * curation travels with the content: committed beside the concepts, restored
   * by a rebuild-from-git, carried by a backup, and moved with the bundle when a
   * topic is split into its own repository.
   *
   * `?topic=` names the topic; omitted, it falls back to the configured home
   * topic. Anything unresolvable answers with an empty list, never an error: the
   * front page must render whatever the curator has or has not done.
   */
  @Public()
  @Get('site/links')
  async getSiteLinks(@Query('topic') topic?: string): Promise<{ links: BundleLink[] }> {
    const slug = (topic ?? loadServerConfig().site.homeTopic ?? '').trim();
    if (!slug) return { links: [] };
    try {
      return { links: await this.linksFor(slug) };
    } catch {
      return { links: [] };
    }
  }

  /**
   * The home page's featured topics — Eric's "a small number of user-specified
   * key topics, with an image and/or a colour" — resolved for the caller.
   *
   * `@PublicRead`, not `@Public`: an anonymous visitor is this product's
   * default reader (`readAccess.default` is `public`) and the front page is
   * theirs, but unlike the logo these are not needed on the login screen, so
   * they follow the instance's read-access mode like every other content read.
   *
   * Resolution is deliberately server-side. The pin list itself is just slugs
   * and asset URLs, but a slug is exactly what `GET /topics` withholds from
   * anonymous visitors — "a private topic's very existence is not public" —
   * so handing the raw list to the client would make pinning a way to leak one.
   */
  @PublicRead()
  @Get('site/pinned')
  async getPinned(@CurrentUser() user: AuthedUser): Promise<{ pinned: PinnedTopicView[] }> {
    return { pinned: await this.resolvePins(user) };
  }

  /**
   * Replace the pin list. Admin-only, which is the whole point: featuring a
   * topic on the front page is a statement the company makes, not a personal
   * bookmark. Whole-list replace rather than per-pin routes because the ORDER
   * is the curation — the same reason `PUT /sections` replaces the catalog.
   */
  @AdminOnly()
  @Put('site/pinned')
  async setPinned(@CurrentUser() actor: AuthedUser, @Body() body: PinnedTopicsDto): Promise<{ pinned: PinnedTopicView[] }> {
    await this.config.setPinnedTopics(body.pinned ?? [], actor.id);
    return { pinned: await this.resolvePins(actor) };
  }

  /** Join the stored pins to the topics this viewer may see, in the curator's order. */
  private async resolvePins(user: AuthedUser | undefined): Promise<PinnedTopicView[]> {
    const pins = await this.config.getPinnedTopics();
    if (pins.length === 0) return [];
    const viewer = viewerFrom(user);
    let q = this.db
      .selectFrom('spaces')
      .select(['id', 'slug', 'name', 'description'])
      .where('archived_at', 'is', null);
    // The same gate `SpacesService.listWithCounts` applies, for the same reason.
    if (viewer.role === 'anonymous') q = q.where('visibility', '!=', 'private');
    const rows = await q.execute();
    const byRef = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      byRef.set(row.slug, row);
      byRef.set(row.id, row);
    }
    const out: PinnedTopicView[] = [];
    for (const pin of pins) {
      const topic = byRef.get(pin.topic);
      // A pin nobody can resolve is dropped, silently, the way `bundleLinks`
      // drops a malformed link: a deleted topic must not cost the site its
      // front page. An admin keeps the dead row so the editor can show it.
      if (!topic && viewer.role !== 'admin') continue;
      out.push({
        // The SLUG when it resolves, not whatever the curator typed: the card
        // links to `/topics/:slug`, and a pin written as a topic id would
        // otherwise render a link that 404s.
        topic: topic?.slug ?? pin.topic,
        name: topic?.name ?? null,
        description: topic?.description ?? null,
        color: pin.color ?? null,
        icon: pin.icon ?? null,
        cover: pin.cover ?? null,
        // The dark cover falls back to the light one HERE rather than in the
        // client, exactly as `logo_dark` does, so every surface agrees.
        cover_dark: pin.cover_dark ?? pin.cover ?? null,
      });
    }
    return out;
  }

  /**
   * The `links:` in the bundle index that carries this topic's presentation.
   *
   * Mirrors `ContentPathResolver`'s layout: a dedicated topic repo is a flat
   * bundle whose root `index.md` is the topic's, while a topic inside the shared
   * main repo is a subtree (`<slug>/index.md`). The main repo's *root* index
   * carries the default topic, so that is the last place looked.
   */
  private async linksFor(slug: string): Promise<BundleLink[]> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id'])
      .where('slug', '=', slug)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!space) return [];
    const target = await this.paths.resolve(space.id);
    const candidates = target.dedicated
      ? [join(target.repoDir, 'index.md')]
      : [
          join(target.repoDir, dirname(target.conceptDir), 'index.md'),
          // Only the default topic may claim the shared repo's root index —
          // otherwise every topic in the main repo would inherit its links.
          ...(slug === DEFAULT_TOPIC_SLUG ? [join(target.repoDir, 'index.md')] : []),
        ];
    for (const abs of candidates) {
      if (!existsSync(abs)) continue;
      const links = parseBundleIndex(readFileSync(abs, 'utf8')).links;
      if (links?.length) return links;
    }
    return [];
  }
}
