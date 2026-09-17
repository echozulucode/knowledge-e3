/**
 * The facts an article states about itself, derived once from the item.
 *
 * These used to be computed inline in PageView. The reader (`ArticleReader`)
 * shows most of them in the header and the page's context pane shows several of
 * them again (Status, Topic, Authors, Series), so the derivation is one function
 * both call — the header and the Properties pane cannot drift into disagreeing
 * about, say, which topic an item is in.
 */
import { parse } from '@echozedlabs/codec';
import type { Frontmatter } from '@echozedlabs/codec';
import { itemPreview, resolveContentTypeMeta } from '@echozedlabs/ui';
import type { Page } from '../../queries.js';
import { authorsOf, coverAltOf, coverImageOf, displayDateOf, formatDate, seriesOf } from '../blog/blogMeta.js';
import { frontmatterString, slugifyFilterValue, topicForPage, type TopicLookup } from '../topics/topicFilters.js';

export interface ArticleFacts {
  frontmatter: Frontmatter;
  /** The lead under the title — see `summaryText`. */
  summary: string | null;
  status: string;
  statusTone: 'published' | 'draft';
  /** The topic as the page names it, or `''`. */
  topic: string;
  /** What "Search in <topic>" sends to /search as `topic`. */
  topicSearchValue: string;
  cover: string | null;
  coverAlt: string | null;
  authors: string[];
  /** The `series` slug, when the item is part of one. */
  series: string | null;
  /** Blog-style presentation (cover banner + byline) rather than "Updated <date>". */
  isArticle: boolean;
  /** The formatted display date for the byline, or `''`. */
  date: string;
}

/**
 * The lead paragraph under the title, through the one shared rule (plan R1.4):
 * `description` (what Compose's Publish drawer writes) then `summary` (what
 * imports and older items carry). The body fallback is deliberately NOT used
 * here — the body is right underneath, so repeating its first sentence as a
 * lead would be noise. A card in a list has no such luxury.
 */
function summaryText(frontmatter: Frontmatter | undefined): string | null {
  const fm = (frontmatter ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof fm[key] === 'string' ? (fm[key] as string) : null);
  return itemPreview({ description: str('description'), summary: str('summary') });
}

export function articleFacts(
  page: Page,
  topicLookup: TopicLookup,
  contentTypes: Parameters<typeof resolveContentTypeMeta>[1],
): ArticleFacts {
  // The server hands us body_markdown (without frontmatter) plus a parsed
  // frontmatter object; the codec re-parse is the fallback when the latter is
  // absent, so other extracted fields stay consistent.
  const frontmatter = (page.frontmatter as Frontmatter | undefined)
    ?? (parse(page.raw_markdown ?? page.body_markdown ?? '').frontmatter as Frontmatter);
  const fm = frontmatter as Record<string, unknown>;
  const status = typeof frontmatter?.status === 'string' ? frontmatter.status : (page.status ?? 'draft');
  const withFrontmatter = { ...page, frontmatter: fm };
  const topic = topicForPage(withFrontmatter, topicLookup) ?? frontmatterString(withFrontmatter, 'topic') ?? '';
  // "Search in <topic>" (reader plan §5.6): the scope goes to /search as the
  // topic's slug when the directory knows it, else as the name the page shows —
  // the search API matches a topic by id, slug or name.
  const topicSearchValue =
    ((page.space_id ? topicLookup.get(page.space_id.trim()) : undefined) ?? (topic ? topicLookup.get(slugifyFilterValue(topic)) : undefined))?.slug
    ?? topic;

  // Blog-style presentation for publishing-group types (blog-post, series,
  // release-note), or any item that carries a cover/author. Such items get an
  // article header — cover banner + "By X · date · N min read" — instead of the
  // plain "Updated <date>" line.
  const blogLike = {
    body_markdown: page.body_markdown,
    updated_at: page.updated_at,
    published_at: page.published_at,
    authors: page.authors,
    frontmatter: fm,
    type: page.type,
  };
  const cover = coverImageOf(blogLike);
  const authors = authorsOf(blogLike);

  return {
    frontmatter,
    summary: summaryText(frontmatter),
    status,
    statusTone: status === 'published' ? 'published' : 'draft',
    topic,
    topicSearchValue,
    cover,
    coverAlt: coverAltOf(blogLike),
    authors,
    series: seriesOf(blogLike),
    isArticle: resolveContentTypeMeta(page.type, contentTypes)?.groupKey === 'publishing' || Boolean(cover) || authors.length > 0,
    date: formatDate(displayDateOf(blogLike)),
  };
}
