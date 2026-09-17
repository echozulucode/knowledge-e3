/**
 * Item-link indexing.
 *
 * Maintains the unified `item_links` table from page/item saves:
 *   - One row per wiki-link or Markdown link in a page body.
 *   - Rebuilt within the same transaction as a page save.
 *   - Backlinks for a page match wiki links by title and Markdown links by id,
 *     slug, or title reference.
 *
 * The legacy `wikilinks` table is still mirrored as a transitional compatibility
 * index for existing wiki-rename behavior and older callers.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { extractWikiLinks, parse, type ItemLinkOccurrence, type WikiLinkOccurrence } from '@echozedlabs/codec';
import { excerpt, plainTextForExcerpt, type ExcerptResult } from '@echozedlabs/search';
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import type { ReadActor } from '../pages/pages.service.js';
import { leadOf } from '../search/snippet.js';

export interface BacklinkRow {
  source_item_id: string;
  source_item_slug: string;
  source_item_title: string;
  source_page_id: string;
  source_title: string;
  source_slug: string;
  snippet: string;
  position: number;
  link_type: 'wiki' | 'markdown';
  link_text: string;
  target_ref: string;
}

export interface BacklinkTarget {
  id: string;
  slug: string;
  title: string;
}

@Injectable()
export class WikiService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Walk a raw markdown document and return its wiki-link occurrences.
   * Skips no-go zones (code blocks, image alt) per the codec contract.
   */
  scanRaw(raw: string): WikiLinkOccurrence[] {
    const parsed = parse(raw);
    return extractWikiLinks(parsed);
  }

  /**
   * Replace link-index rows for a given source page with the supplied set.
   * Caller is responsible for running this inside the same transaction as the
   * page save so the index can never lag the source of truth.
   */
  async indexInTx(
    tx: Kysely<Database>,
    sourcePageId: string,
    occurrences: ItemLinkOccurrence[],
  ): Promise<void> {
    await tx.deleteFrom('item_links').where('source_page_id', '=', sourcePageId).execute();
    await tx.deleteFrom('wikilinks').where('source_page_id', '=', sourcePageId).execute();
    if (occurrences.length === 0) return;

    await tx
      .insertInto('item_links')
      .values(
        occurrences.map((o) => ({
          source_page_id: sourcePageId,
          target_ref: o.target,
          link_type: o.type,
          link_text: o.text,
          position: o.start,
        })),
      )
      .execute();

    const wikiLinks = occurrences.filter((o) => o.type === 'wiki');
    if (wikiLinks.length === 0) return;
    await tx
      .insertInto('wikilinks')
      .values(
        wikiLinks.map((o) => ({
          source_page_id: sourcePageId,
          target_title: o.target,
          position: o.start,
        })),
      )
      .execute();
  }

  /**
   * Backlinks for a page. Wiki-links are title references; Markdown links can
   * reference the target by immutable id, current slug, or current title.
   */
  async backlinks(target: BacklinkTarget, actor?: ReadActor): Promise<BacklinkRow[]> {
    let q = this.db
      .selectFrom('item_links as l')
      .innerJoin('pages as p', 'p.id', 'l.source_page_id')
      .innerJoin('page_versions as v', 'v.id', 'p.current_version_id')
      .select([
        'l.source_page_id',
        'l.position',
        'l.link_type',
        'l.link_text',
        'l.target_ref',
        'p.title as source_title',
        'p.slug as source_slug',
        'v.body_markdown',
      ])
      .where((eb) =>
        eb.or([
          eb.and([eb('l.link_type', '=', 'wiki'), eb('l.target_ref', '=', target.title)]),
          eb.and([
            eb('l.link_type', '=', 'markdown'),
            eb.or([
              eb('l.target_ref', '=', target.id),
              eb('l.target_ref', '=', target.slug),
              eb('l.target_ref', '=', target.title),
            ]),
          ]),
        ]),
      )
      .where('p.deleted_at', 'is', null);

    // Draft-visibility parity: a non-admin must not see another user's draft
    // source page (its title/slug/snippet) just because it links to a page
    // they can read. Trusted internal callers (no actor) see everything.
    if (actor && actor.role !== 'admin') {
      q = q.where((eb) =>
        eb.or([eb('p.status', '=', 'published'), eb('p.owner_id', '=', actor.id)]),
      );
    }
    // Space gate, as `PagesService.isSpaceVisibleTo` applies it: an anonymous
    // visitor must not learn a private Topic's item (title, slug, snippet) just
    // because it links to a public one.
    if (actor?.id === ANONYMOUS_ACTOR.id) {
      q = q.where((eb) =>
        eb.or([
          eb('p.space_id', 'is', null),
          eb.exists(
            eb
              .selectFrom('spaces as s')
              .select('s.id')
              .whereRef('s.id', '=', 'p.space_id')
              .where('s.visibility', '!=', 'private'),
          ),
        ]),
      );
    }

    const rows = await q
      .orderBy('p.updated_at', 'desc')
      .orderBy('l.position', 'asc')
      .execute();
    return rows.map((r) => ({
      source_item_id: r.source_page_id,
      source_item_slug: r.source_slug,
      source_item_title: r.source_title,
      source_page_id: r.source_page_id,
      source_title: r.source_title,
      source_slug: r.source_slug,
      position: r.position,
      link_type: r.link_type,
      link_text: r.link_text,
      target_ref: r.target_ref,
      snippet: backlinkSnippet(r.body_markdown, r.position, r.link_text, target.title),
    }));
  }

  /**
   * Find pages that have wiki-links targeting the given title.
   * Used by the rename flow to know how many pages would be affected.
   */
  async findInboundSources(targetTitle: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('item_links')
      .select('source_page_id')
      .where('link_type', '=', 'wiki')
      .where('target_ref', '=', targetTitle)
      .distinct()
      .execute();
    return rows.map((r) => r.source_page_id);
  }
}

/** A related/backlink snippet's target length, a little shorter than a search row's. */
const BACKLINK_SNIPPET_CHARS = 160;

/**
 * Beyond this, the paragraph around a link is narrowed to its line, then to a
 * window, so one enormous paragraph cannot make every backlink row expensive.
 */
const MAX_CONTEXT_CHARS = 2000;

/**
 * The readable context of one link occurrence (issue 114), e.g. `See Hub for
 * context.` for `See [[Hub]] for context.`.
 *
 * The old snippet sliced ±60 characters of RAW Markdown around the link, so a
 * cut landed inside `[[Getting Started]]` and rows showed `[[Getting…`. Now the
 * block containing the link is reduced to prose FIRST (`plainTextForExcerpt`
 * turns `[[target|label]]` into `label`) and cut SECOND, on word boundaries,
 * around the link's visible text — or, failing that, the target's title words.
 * `…` marks a cut edge, because a backlink row has no truncation flags to carry.
 */
export function backlinkSnippet(body: string, position: number, linkText: string, targetTitle: string): string {
  const plain = plainTextForExcerpt(contextAround(body, position));
  const options = { maxChars: BACKLINK_SNIPPET_CHARS };
  const found: ExcerptResult | null =
    (linkText.trim() ? excerpt(plain, { terms: [], phrases: [linkText], prefixTerm: null }, options) : null) ??
    excerpt(plain, { terms: targetTitle.split(/\s+/).filter(Boolean), phrases: [], prefixTerm: null }, options);
  const cut = found ?? leadOf(plain, BACKLINK_SNIPPET_CHARS);
  if (!cut.text) return '';
  return `${cut.truncatedStart ? '…' : ''}${cut.text}${cut.truncatedEnd ? '…' : ''}`;
}

/**
 * The Markdown block the link sits in: its paragraph, else its line, else a
 * window snapped to whitespace. Blocks are cut at blank lines and newlines,
 * which Markdown link syntax never spans, so the text handed to
 * `plainTextForExcerpt` holds whole links rather than halves of them.
 */
function contextAround(body: string, position: number): string {
  const at = Math.max(0, Math.min(position, body.length));
  const between = (open: string, close: string) => {
    const start = body.lastIndexOf(open, at);
    const end = body.indexOf(close, at);
    return body.slice(start < 0 ? 0 : start + open.length, end < 0 ? body.length : end);
  };
  const paragraph = between('\n\n', '\n\n');
  if (paragraph.length <= MAX_CONTEXT_CHARS) return paragraph;
  const line = between('\n', '\n');
  if (line.length <= MAX_CONTEXT_CHARS) return line;
  const half = MAX_CONTEXT_CHARS / 2;
  const from = body.lastIndexOf(' ', Math.max(0, at - half));
  const to = body.indexOf(' ', Math.min(body.length, at + half));
  return body.slice(from < 0 ? 0 : from, to < 0 ? body.length : to);
}
