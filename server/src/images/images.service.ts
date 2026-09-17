import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { AssetsService } from './assets.service.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';
import { attachmentMimesIn, resolveAttachmentType, sanitizeFilename } from './attachment-policy.js';
import type { ReadActor } from '../pages/pages.service.js';
import { isSiteBrandingAsset, siteBrandingAssetFiles } from '../config/server-config.js';

export interface ImageView {
  id: string;
  file: string;
  url: string;
  mime: string;
  byte_size: number;
  alt: string | null;
  /** Human-facing download name (null for legacy image rows). */
  original_filename: string | null;
  created_at: string;
  /** How many items reference it (body embed/link or cover frontmatter), trashed items included. */
  used_by: number;
  /**
   * The site's chrome uses it: the logo, dark logo, favicon or a pinned-topic
   * cover. No item links those, so before this flag they looked orphaned and a
   * reclaim pass could delete the front page's cover out from under it.
   */
  site_asset: boolean;
  /** Referenced by nothing - no item and not the site - so it is safe to delete. */
  orphan: boolean;
}

/** The Files page's type buckets, derived from the stored MIME. */
export const IMAGE_KINDS = ['image', 'document', 'other'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
export const IMAGE_USAGES = ['used', 'unused'] as const;
export type ImageUsage = (typeof IMAGE_USAGES)[number];
export const IMAGE_SORTS = ['newest', 'largest', 'name'] as const;
export type ImageSort = (typeof IMAGE_SORTS)[number];

export const IMAGES_LIST_MAX_LIMIT = 200;
/** How many referencing items the detail view names; `used_by` still counts them all. */
export const USED_BY_ITEMS_CAP = 50;

export interface ListImagesQuery {
  /** Case-insensitive substring of the download name, stored name or alt text. */
  q?: string;
  kind?: ImageKind;
  usage?: ImageUsage;
  /** Default `largest` - what this list has always been ordered by. */
  sort?: ImageSort;
  /** Absent: every match (the asset picker and the Overview read the whole library). */
  limit?: number;
  offset?: number;
}

/** Library-wide totals for the page header; independent of the filters. */
export interface ImageLibrarySummary {
  count: number;
  total_bytes: number;
  unused: number;
  reclaimable_bytes: number;
}

export interface ListImagesResult {
  images: ImageView[];
  total: number;
  limit: number | null;
  offset: number;
  summary: ImageLibrarySummary;
}

export interface UsedByItem {
  item_id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  /** In the trash: still references the file (so it still blocks deletion), but has no page to open. */
  deleted: boolean;
  topic: { slug: string; name: string; visibility: string } | null;
}

export interface ImageDetailView extends ImageView {
  created_by: string;
  /** Null when the uploader's account no longer exists. */
  created_by_username: string | null;
  /** Up to USED_BY_ITEMS_CAP items, live before trashed, then by title; `used_by` is the full count. */
  used_by_items: UsedByItem[];
}

/** MIME types in the "Documents" bucket: readable files (PDF, text, CSV, JSON), not archives. */
const DOCUMENT_MIMES = attachmentMimesIn('document', 'data');

/** SQL for how many items link an image (`idx_image_links_image`). */
const usedByCount = sql<number>`(select count(*) from image_links where image_links.image_id = i.id)`;

/** Metadata + management for uploaded images; bytes live in the bundle via AssetsService. */
@Injectable()
export class ImagesService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly assets: AssetsService,
    @Inject(REVISION_MIRROR) private readonly mirror: RevisionMirrorPort,
  ) {}

  /**
   * Tell the git mirror that `assets/` changed so the new bytes / removed file
   * are committed even with no concurrent page edit (ADR-0003, phase 2). This is
   * what makes an upload durable — on the cloud demo the git push is the only
   * backup path for asset bytes; Litestream replicates the DB only. Best-effort
   * and fire-and-forget: it must never fail or slow the upload response, and the
   * bytes are already on local disk regardless.
   *
   * `actorId` is the person whose upload or deletion this is, so the asset
   * commit is authored by them like a page edit (§7.1 per-edit authorship).
   * Omit it only where there genuinely is no such person.
   */
  private signalAssetsChanged(actorId?: string): void {
    void this.mirror.notifyAssetsChanged?.(actorId);
  }

  /**
   * Content-addressed attachment upload: identical bytes dedupe to one file/row.
   *
   * The type is resolved by CONTENT (magic bytes) via the attachment policy, not
   * the client's Content-Type — an inline image must match a real signature, and
   * anything off the allowlist is rejected. `filename` is the human-facing
   * download name; the stored name stays the opaque content-addressed one.
   */
  async upload(
    actorId: string,
    bytes: Buffer,
    mime: string,
    opts: { alt?: string; filename?: string } = {},
  ): Promise<ImageView> {
    const resolved = resolveAttachmentType(bytes, mime, opts.filename);
    if (!resolved.ok || !resolved.type) {
      throw new BadRequestException(resolved.reason ?? 'unsupported file');
    }
    const type = resolved.type;
    const originalFilename = sanitizeFilename(opts.filename);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.db.selectFrom('images').selectAll().where('sha256', '=', sha256).executeTakeFirst();
    if (existing) {
      const healed = !this.assets.exists(existing.file);
      if (healed) this.assets.write(existing.file, bytes); // heal a missing file
      this.writeDescriptor(existing); // heal a missing sidecar too
      if (healed) this.signalAssetsChanged(actorId);
      return this.toView(existing, 0);
    }

    const file = `${sha256.slice(0, 16)}.${type.ext}`;
    this.assets.write(file, bytes);
    const row = {
      id: newId(),
      file,
      mime: type.mime, // the DETECTED canonical mime, not the claimed one
      byte_size: bytes.length,
      sha256,
      alt: opts.alt?.trim() || null,
      original_filename: originalFilename,
      created_at: nowIso(),
      created_by: actorId,
    };
    await this.db.insertInto('images').values(row).execute();
    // The sidecar is the git-tracked source of truth (ADR-0003); the row is its
    // derived cache. Write it so a rebuild-from-git recovers this asset.
    this.writeDescriptor(row);
    // Commit the new bytes + sidecar to git so they become durable.
    this.signalAssetsChanged(actorId);
    return this.toView(row, 0);
  }

  /** Persist the git-tracked descriptor for a stored image row. */
  private writeDescriptor(row: {
    file: string;
    sha256: string;
    mime: string;
    byte_size: number;
    alt: string | null;
    original_filename: string | null;
    created_at: string;
    created_by: string;
  }): void {
    this.assets.writeDescriptor({
      schema_version: 1,
      file: row.file,
      sha256: row.sha256,
      mime: row.mime,
      byte_size: row.byte_size,
      original_filename: row.original_filename ?? null,
      alt: row.alt,
      provenance: 'uploaded',
      created_at: row.created_at,
      created_by: row.created_by,
    });
  }

  /** Every image, largest first (the unfiltered form of `listPage`). */
  async list(): Promise<ImageView[]> {
    return (await this.listPage()).images;
  }

  /**
   * One page of the Files library, filtered and sorted in SQL so the admin page
   * scales past a demo-sized library. Without `limit` every match is returned:
   * that is the shape `GET /admin/images` always had, and what the asset picker
   * and the Overview still read.
   *
   * "Used" means an item links it OR the site's chrome declares it - the same
   * two things that refuse its deletion - so Unused is exactly the deletable set.
   */
  async listPage(opts: ListImagesQuery = {}): Promise<ListImagesResult> {
    const limit =
      opts.limit === undefined ? null : Math.max(1, Math.min(IMAGES_LIST_MAX_LIMIT, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const siteFiles = siteBrandingAssetFiles();
    const needle = opts.q?.trim().toLowerCase();

    let base = this.db.selectFrom('images as i');
    if (needle) {
      // instr() rather than LIKE: "a_b" or "50%" mean those characters (as on Users).
      base = base.where((eb) =>
        eb.or([
          eb(sql<number>`instr(lower(coalesce(i.original_filename, '')), ${needle})`, '>', 0),
          eb(sql<number>`instr(lower(i.file), ${needle})`, '>', 0),
          eb(sql<number>`instr(lower(coalesce(i.alt, '')), ${needle})`, '>', 0),
        ]),
      );
    }
    if (opts.kind === 'image') base = base.where('i.mime', 'like', 'image/%');
    if (opts.kind === 'document') base = base.where('i.mime', 'in', DOCUMENT_MIMES);
    if (opts.kind === 'other') {
      base = base.where('i.mime', 'not like', 'image/%').where('i.mime', 'not in', DOCUMENT_MIMES);
    }
    if (opts.usage) {
      const usage = opts.usage;
      base = base.where((eb) => {
        const linked = eb(usedByCount, '>', 0);
        const used = siteFiles.length > 0 ? eb.or([linked, eb('i.file', 'in', siteFiles)]) : linked;
        return usage === 'used' ? used : eb.not(used);
      });
    }

    const sort = opts.sort ?? 'largest';
    let rowsQuery = base
      .select(['i.id', 'i.file', 'i.mime', 'i.byte_size', 'i.alt', 'i.original_filename', 'i.created_at'])
      .select(usedByCount.as('used_by'));
    if (sort === 'newest') rowsQuery = rowsQuery.orderBy('i.created_at', 'desc');
    // Largest first: this list is also the "what can I reclaim?" view, and the
    // biggest orphaned attachments are what an admin is hunting for.
    if (sort === 'largest') rowsQuery = rowsQuery.orderBy('i.byte_size', 'desc');
    if (sort === 'name') rowsQuery = rowsQuery.orderBy(sql`lower(coalesce(i.original_filename, i.file))`, 'asc');
    // A stable tiebreak, or equal sort values could land on two pages (or on none).
    rowsQuery = rowsQuery.orderBy('i.id', 'asc');
    if (limit !== null) rowsQuery = rowsQuery.limit(limit).offset(offset);
    // SQLite needs a LIMIT before an OFFSET; -1 is its "no limit".
    else if (offset > 0) rowsQuery = rowsQuery.limit(-1).offset(offset);

    const [rows, count, summary] = await Promise.all([
      rowsQuery.execute(),
      base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst(),
      this.summary(siteFiles),
    ]);
    return {
      images: rows.map((r) => this.toView(r, Number(r.used_by))),
      total: Number(count?.n ?? 0),
      limit,
      offset,
      summary,
    };
  }

  /** Header totals: the whole library, and the part of it nothing uses (what a cleanup would reclaim). */
  private async summary(siteFiles: string[]): Promise<ImageLibrarySummary> {
    const unused =
      siteFiles.length > 0
        ? sql<boolean>`(${usedByCount} = 0 and i.file not in (${sql.join(siteFiles)}))`
        : sql<boolean>`(${usedByCount} = 0)`;
    const row = await this.db
      .selectFrom('images as i')
      .select([
        sql<number>`count(*)`.as('count'),
        sql<number>`coalesce(sum(i.byte_size), 0)`.as('total_bytes'),
        sql<number>`coalesce(sum(case when ${unused} then 1 else 0 end), 0)`.as('unused'),
        sql<number>`coalesce(sum(case when ${unused} then i.byte_size else 0 end), 0)`.as('reclaimable_bytes'),
      ])
      .executeTakeFirst();
    return {
      count: Number(row?.count ?? 0),
      total_bytes: Number(row?.total_bytes ?? 0),
      unused: Number(row?.unused ?? 0),
      reclaimable_bytes: Number(row?.reclaimable_bytes ?? 0),
    };
  }

  /**
   * One file for the detail sheet, with the items that reference it.
   *
   * Admin-only (the route is `@AdminOnly`), and admins read every item, so the
   * list is unfiltered: private topics, drafts and trashed items all appear -
   * each is a reason the file cannot be deleted, and hiding one would make the
   * refusal inexplicable. A member-facing route must NOT reuse this as is: it
   * would name drafts and private-topic items the caller cannot open.
   */
  async get(id: string): Promise<ImageDetailView> {
    const row = await this.db
      .selectFrom('images as i')
      .leftJoin('users as u', 'u.id', 'i.created_by')
      .select(['i.id', 'i.file', 'i.mime', 'i.byte_size', 'i.alt', 'i.original_filename', 'i.created_at', 'i.created_by'])
      .select('u.username as created_by_username')
      .select(usedByCount.as('used_by'))
      .where('i.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('image not found');

    const items = await this.db
      .selectFrom('image_links as l')
      .innerJoin('pages as p', 'p.id', 'l.page_id')
      .leftJoin('spaces as s', 's.id', 'p.space_id')
      .select(['p.id as item_id', 'p.slug', 'p.title', 'p.status', 'p.deleted_at'])
      .select(['s.slug as topic_slug', 's.name as topic_name', 's.visibility as topic_visibility'])
      .where('l.image_id', '=', id)
      .orderBy(sql`p.deleted_at is not null`, 'asc')
      .orderBy(sql`lower(p.title)`, 'asc')
      .orderBy('p.id', 'asc')
      .limit(USED_BY_ITEMS_CAP)
      .execute();

    return {
      ...this.toView(row, Number(row.used_by)),
      created_by: row.created_by,
      created_by_username: row.created_by_username ?? null,
      used_by_items: items.map((it) => ({
        item_id: it.item_id,
        slug: it.slug,
        title: it.title,
        status: it.status,
        deleted: it.deleted_at !== null,
        topic:
          it.topic_slug && it.topic_name
            ? { slug: it.topic_slug, name: it.topic_name, visibility: String(it.topic_visibility) }
            : null,
      })),
    };
  }

  async findByFile(
    file: string,
  ): Promise<{ file: string; mime: string; original_filename: string | null } | null> {
    const row = await this.db
      .selectFrom('images')
      .select(['file', 'mime', 'original_filename'])
      .where('file', '=', file)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Is this asset reachable by an anonymous visitor — i.e. embedded in at least
   * one published, non-deleted page in a public (or unscoped) space?
   *
   * Serving is otherwise identity-blind: bytes are handed out on filename alone,
   * so an image that only ever appeared in an unpublished draft would be
   * fetchable by anyone who learned its name. Content-addressed names are not
   * secrets, just hard to guess. This is also what decides whether the response
   * may be cached by shared proxies (see ImagesController.serve).
   *
   * Uses idx_image_links_image; the join is a primary-key lookup per side.
   */
  async isPubliclyLinked(file: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('image_links as l')
      .innerJoin('images as i', 'i.id', 'l.image_id')
      .innerJoin('pages as p', 'p.id', 'l.page_id')
      .leftJoin('spaces as s', 's.id', 'p.space_id')
      .select('l.page_id')
      .where('i.file', '=', file)
      .where('p.status', '=', 'published')
      .where('p.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('p.space_id', 'is', null),
          eb('s.visibility', '!=', 'private'),
        ]),
      )
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * Apply the same signed-in page visibility rule used by PagesService: members
   * may read published pages and drafts they own; admins may read everything.
   * Only the uploader (or an admin) may preview an unlinked upload before the
   * page is saved.
   */
  async isReadableByMember(file: string, actor: ReadActor): Promise<boolean> {
    if (actor.role === 'admin') return true;

    const readableLink = await this.db
      .selectFrom('image_links as l')
      .innerJoin('images as i', 'i.id', 'l.image_id')
      .innerJoin('pages as p', 'p.id', 'l.page_id')
      .select('l.page_id')
      .where('i.file', '=', file)
      .where('p.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('p.status', '=', 'published'),
          eb('p.owner_id', '=', actor.id),
        ]),
      )
      .executeTakeFirst();
    if (readableLink) return true;

    const image = await this.db
      .selectFrom('images')
      .select('created_by')
      .where('file', '=', file)
      .executeTakeFirst();
    if (!image) return false;
    if (image.created_by === actor.id) return true;
    return false;
  }

  bytes(file: string): Buffer | null {
    return this.assets.read(file);
  }

  /** `actorId` attributes the removal commit; omitted only where no user acted. */
  async remove(id: string, actorId?: string): Promise<void> {
    const img = await this.db.transaction().execute(async (tx) => {
      const found = await tx.selectFrom('images').select(['file']).where('id', '=', id).executeTakeFirst();
      if (!found) throw new NotFoundException('image not found');
      // The site's chrome (logo, favicon, a pinned-topic cover) links no item,
      // so the reference check below would let it go and the front page would
      // lose its image. Change the site setting first, then delete.
      if (isSiteBrandingAsset(found.file)) {
        throw new ConflictException('file is used by the site (logo, favicon or a pinned-topic cover) and cannot be deleted');
      }

      const reference = await tx
        .selectFrom('image_links')
        .select('page_id')
        .where('image_id', '=', id)
        .executeTakeFirst();
      if (reference) {
        throw new ConflictException('file is referenced by one or more pages and cannot be deleted');
      }

      await tx.deleteFrom('images').where('id', '=', id).execute();
      return found;
    });
    // Only remove bytes if no other row shares the file (content-addressed → unique).
    const shared = await this.db.selectFrom('images').select('id').where('file', '=', img.file).executeTakeFirst();
    if (!shared) {
      this.assets.remove(img.file); // removes bytes + sidecar
      // Commit the removal so it sticks across a rebuild-from-git.
      this.signalAssetsChanged(actorId);
    }
  }

  private toView(
    row: {
      id: string;
      file: string;
      mime: string;
      byte_size: number;
      alt: string | null;
      original_filename?: string | null;
      created_at: string;
    },
    usedBy: number,
  ): ImageView {
    const siteAsset = isSiteBrandingAsset(row.file);
    return {
      id: row.id,
      file: row.file,
      url: `/assets/${row.file}`,
      mime: row.mime,
      byte_size: row.byte_size,
      alt: row.alt,
      original_filename: row.original_filename ?? null,
      created_at: row.created_at,
      used_by: usedBy,
      site_asset: siteAsset,
      orphan: usedBy === 0 && !siteAsset,
    };
  }
}
