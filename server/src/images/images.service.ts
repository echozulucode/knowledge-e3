import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { AssetsService } from './assets.service.js';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
};

export interface ImageView {
  id: string;
  file: string;
  url: string;
  mime: string;
  byte_size: number;
  alt: string | null;
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
  ) {}

  /** Content-addressed upload: identical bytes dedupe to a single stored file/row. */
  async upload(actorId: string, bytes: Buffer, mime: string, alt?: string): Promise<ImageView> {
    if (!bytes || bytes.length === 0) throw new BadRequestException('empty upload');
    if (!mime.startsWith('image/')) throw new BadRequestException(`unsupported content-type: ${mime}`);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.db.selectFrom('images').selectAll().where('sha256', '=', sha256).executeTakeFirst();
    if (existing) {
      if (!this.assets.exists(existing.file)) this.assets.write(existing.file, bytes); // heal a missing file
      return this.toView(existing, 0);
    }

    const ext = MIME_EXT[mime] ?? 'bin';
    const file = `${sha256.slice(0, 16)}.${ext}`;
    this.assets.write(file, bytes);
    const row = {
      id: newId(),
      file,
      mime,
      byte_size: bytes.length,
      sha256,
      alt: alt?.trim() || null,
      created_at: nowIso(),
      created_by: actorId,
    };
    await this.db.insertInto('images').values(row).execute();
    return this.toView(row, 0);
  }

  async list(): Promise<ImageView[]> {
    const rows = await this.db
      .selectFrom('images as i')
      .leftJoin('image_links as l', 'l.image_id', 'i.id')
      .select(['i.id', 'i.file', 'i.mime', 'i.byte_size', 'i.alt', 'i.created_at'])
      .select((eb) => eb.fn.count('l.page_id').as('used_by'))
      .groupBy('i.id')
      .orderBy('i.created_at', 'desc')
      .execute();
    return rows.map((r) => this.toView(r, Number(r.used_by)));
  }

  async findByFile(file: string): Promise<{ file: string; mime: string } | null> {
    const row = await this.db.selectFrom('images').select(['file', 'mime']).where('file', '=', file).executeTakeFirst();
    return row ?? null;
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
    if (!shared) this.assets.remove(img.file);
  }

  private toView(row: { id: string; file: string; mime: string; byte_size: number; alt: string | null; created_at: string }, usedBy: number): ImageView {
    return {
      id: row.id,
      file: row.file,
      url: `/assets/${row.file}`,
      mime: row.mime,
      byte_size: row.byte_size,
      alt: row.alt,
      created_at: row.created_at,
      used_by: usedBy,
      orphan: usedBy === 0,
    };
  }
}
