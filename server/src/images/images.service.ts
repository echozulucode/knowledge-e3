import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { AssetsService } from './assets.service.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../storage/revision-mirror.port.js';
import { resolveAttachmentType, sanitizeFilename } from './attachment-policy.js';

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
  used_by: number;
  orphan: boolean;
}

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
   */
  private signalAssetsChanged(): void {
    void this.mirror.notifyAssetsChanged?.();
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
      if (healed) this.signalAssetsChanged();
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
    this.signalAssetsChanged();
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

  async list(): Promise<ImageView[]> {
    const rows = await this.db
      .selectFrom('images as i')
      .leftJoin('image_links as l', 'l.image_id', 'i.id')
      .select(['i.id', 'i.file', 'i.mime', 'i.byte_size', 'i.alt', 'i.original_filename', 'i.created_at'])
      .select((eb) => eb.fn.count('l.page_id').as('used_by'))
      .groupBy('i.id')
      // Largest first: this list is also the "what can I reclaim?" view, and the
      // biggest orphaned attachments are what an admin is hunting for.
      .orderBy('i.byte_size', 'desc')
      .execute();
    return rows.map((r) => this.toView(r, Number(r.used_by)));
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
   * one published, non-deleted page?
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
      .select('l.page_id')
      .where('i.file', '=', file)
      .where('p.status', '=', 'published')
      .where('p.deleted_at', 'is', null)
      .executeTakeFirst();
    return Boolean(row);
  }

  bytes(file: string): Buffer | null {
    return this.assets.read(file);
  }

  async remove(id: string): Promise<void> {
    const img = await this.db.selectFrom('images').select(['file']).where('id', '=', id).executeTakeFirst();
    if (!img) throw new NotFoundException('image not found');
    await this.db.deleteFrom('image_links').where('image_id', '=', id).execute();
    await this.db.deleteFrom('images').where('id', '=', id).execute();
    // Only remove bytes if no other row shares the file (content-addressed → unique).
    const shared = await this.db.selectFrom('images').select('id').where('file', '=', img.file).executeTakeFirst();
    if (!shared) {
      this.assets.remove(img.file); // removes bytes + sidecar
      // Commit the removal so it sticks across a rebuild-from-git.
      this.signalAssetsChanged();
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
      orphan: usedBy === 0,
    };
  }
}
