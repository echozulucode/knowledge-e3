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
import type { Database } from '../db/schema.js';
import { KYSELY } from '../db/db.module.js';
import type { ReadActor } from '../pages/pages.service.js';

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
      snippet: snippet(r.body_markdown, r.position),
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

function snippet(body: string, position: number, radius = 60): string {
  const start = Math.max(0, position - radius);
  const end = Math.min(body.length, position + radius);
  let s = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '...' + s;
  if (end < body.length) s = s + '...';
  return s;
}
