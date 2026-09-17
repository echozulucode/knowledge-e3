/**
 * Blog surfaces over the `KnowledgeQuery` seam (plan §3.3): the site-wide and
 * per-Topic feeds, series (reading order), authors (a saved search), and the
 * Atom documents generated from the very same query the JSON feed answers.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Page, SeriesItem, Viewer } from '@echozedlabs/knowledge-types';
import {
  KnowledgeQueryService,
  type FeedQueryOptions,
  type HomepageFeedEntry,
} from '../query/knowledge-query.service.js';
import { renderAtom } from './atom.js';

/** What `/feed` and the Atom documents carry when the caller names no `types`. */
export const DEFAULT_FEED_TYPES = ['Blog Post', 'Release Note'];
const SERIES_LIMIT = 500;
const ATOM_LIMIT = 50;

@Injectable()
export class FeedService {
  constructor(private readonly query: KnowledgeQueryService) {}

  /** `allTypes` drops the default type restriction; explicit `types` always apply. */
  feed(q: FeedQueryOptions & { allTypes?: boolean }, viewer: Viewer): Promise<Page<HomepageFeedEntry>> {
    const { allTypes, ...rest } = q;
    const types = rest.types?.length ? rest.types : allTypes ? undefined : DEFAULT_FEED_TYPES;
    return this.query.feed({ ...rest, types }, viewer);
  }

  /**
   * Every visible member of a series in `series_order` (any content type), plus
   * the published Series item with the same slug when this viewer may read it
   * (home plan R2.11). `series_item` is additive: `series` stays the slug.
   */
  async series(
    slug: string,
    viewer: Viewer,
  ): Promise<{ series: string; series_item: SeriesItem | null; items: HomepageFeedEntry[] }> {
    const [page, seriesItem] = await Promise.all([
      this.query.feed({ series: slug, limit: SERIES_LIMIT }, viewer),
      this.query.seriesItem(slug, viewer),
    ]);
    return { series: slug, series_item: seriesItem, items: page.items };
  }

  author(name: string, q: Pick<FeedQueryOptions, 'limit' | 'cursor'>, viewer: Viewer): Promise<Page<HomepageFeedEntry>> {
    return this.query.feed({ author: name, limit: q.limit, cursor: q.cursor }, viewer);
  }

  async latestAtom(viewer: Viewer): Promise<string> {
    const page = await this.feed({ limit: ATOM_LIMIT }, viewer);
    return renderAtom({
      id: 'urn:e3:feed:latest',
      title: 'Knowledge E3 — Latest',
      selfHref: '/api/v1/feeds/latest.atom',
      alternateHref: '/latest',
      updated: latestUpdate(page.items),
      entries: page.items,
    });
  }

  /** 404 when the Topic does not exist or is not visible to this viewer. */
  async topicAtom(slug: string, viewer: Viewer): Promise<string> {
    const topic = await this.query.topic(slug, viewer);
    if (!topic) throw new NotFoundException('topic not found');
    const page = await this.feed({ topic: topic.slug, limit: ATOM_LIMIT }, viewer);
    return renderAtom({
      id: `urn:e3:feed:topic:${topic.slug}`,
      title: `Knowledge E3 — ${topic.name}`,
      selfHref: `/api/v1/feeds/topics/${encodeURIComponent(topic.slug)}.atom`,
      alternateHref: `/topics/${encodeURIComponent(topic.slug)}`,
      updated: latestUpdate(page.items),
      entries: page.items,
    });
  }
}

/** Atom requires a feed-level `updated`; use the newest entry, or "now" for an empty feed. */
function latestUpdate(entries: { updated_at: string }[]): string {
  let latest = '';
  for (const e of entries) if (e.updated_at > latest) latest = e.updated_at;
  return latest || new Date().toISOString();
}
