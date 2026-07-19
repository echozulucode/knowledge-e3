import { BadRequestException, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { ImagesService } from './images.service.js';
import { dispositionFor, sanitizeFilename } from './attachment-policy.js';

/** Unauthenticated visitor on a public instance (see SessionGuard/@PublicRead). */
const isAnonymous = (user: AuthedUser | undefined): boolean =>
  !user || user.id === ANONYMOUS_ACTOR.id;

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', tiff: 'image/tiff', pdf: 'application/pdf', zip: 'application/zip',
  csv: 'text/csv', json: 'application/json', txt: 'text/plain',
};
/** Stored files are content-addressed (`<sha16>.<ext>`); reject anything else. */
const SAFE_FILE = /^[a-zA-Z0-9]+\.[a-zA-Z0-9]+$/;

@Controller()
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('images')
  async upload(
    @CurrentUser() user: AuthedUser,
    @Req() req: Request,
    @Query('alt') alt?: string,
    @Query('filename') filename?: string,
  ) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body)) throw new BadRequestException('expected a raw file body');
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    return this.images.upload(user.id, body, mime, { alt, filename });
  }

  @PublicRead()
  @Get('assets/:file')
  async serve(
    @Param('file') file: string,
    @CurrentUser() user: AuthedUser,
    @Res() res: Response,
  ): Promise<void> {
    if (!SAFE_FILE.test(file)) {
      res.status(404).end();
      return;
    }
    const bytes = this.images.bytes(file);
    if (!bytes) {
      res.status(404).end();
      return;
    }

    // Bytes are served by filename alone, so this is the only visibility check
    // an asset ever gets. An anonymous visitor may fetch an asset only if some
    // published page embeds it — otherwise a draft-only image would be readable
    // by anyone who learned its (non-secret) content-addressed name.
    const publiclyLinked = await this.images.isPubliclyLinked(file);
    if (!publiclyLinked && isAnonymous(user)) {
      res.status(404).end();
      return;
    }

    const found = await this.images.findByFile(file);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const mime = found?.mime ?? EXT_MIME[ext] ?? 'application/octet-stream';
    res.set('Content-Type', mime);
    // Never let the browser second-guess the type — the whole allowlist/serving
    // policy depends on the declared type being honored (OWASP).
    res.set('X-Content-Type-Options', 'nosniff');
    // Images render inline; everything else (PDF, zip, SVG, text) is a download,
    // so active or mislabelled content can't execute in the page (ADR-0003 §7).
    if (dispositionFor(mime) === 'download') {
      const name = sanitizeFilename(found?.original_filename ?? undefined) ?? file;
      res.set('Content-Disposition', `attachment; filename="${name}"`);
    }
    // Content-addressed, so always immutable — but only cacheable by SHARED
    // caches once it is public. Marking an identity-gated response `public`
    // would let a proxy serve a draft's image to anonymous visitors.
    res.set(
      'Cache-Control',
      publiclyLinked ? 'public, max-age=31536000, immutable' : 'private, max-age=31536000, immutable',
    );
    res.send(bytes);
  }

  @AdminOnly()
  @Get('admin/images')
  async listAdmin() {
    return { images: await this.images.list() };
  }

  @AdminOnly()
  @Delete('admin/images/:id')
  async remove(@Param('id') id: string) {
    await this.images.remove(id);
    return { ok: true };
  }
}
