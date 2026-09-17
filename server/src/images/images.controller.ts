import { BadRequestException, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import { isSiteBrandingAsset } from '../config/server-config.js';
import { IMAGE_KINDS, IMAGE_SORTS, IMAGE_USAGES, ImagesService } from './images.service.js';
import { wholeNumber } from '../auth/list-params.js';
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

/** An optional enum query parameter: absent → undefined, unknown → 400. */
function oneOf<T extends string>(raw: string | undefined, param: string, allowed: readonly T[]): T | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${param} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

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
    // published page in a public space embeds it — otherwise a draft-only or
    // private-space image would be readable by anyone who learned its
    // (non-secret) content-addressed name.
    //
    // The site's own logo/favicon is the exception: it is embedded in the chrome
    // rather than in any item, so nothing would ever link it, and naming it in
    // `site:` is the operator declaring it the public face of the instance.
    const branding = isSiteBrandingAsset(file);
    const publiclyLinked = branding || (await this.images.isPubliclyLinked(file));
    if (!publiclyLinked && isAnonymous(user)) {
      res.status(404).end();
      return;
    }
    if (!branding && !isAnonymous(user) && !(await this.images.isReadableByMember(file, user))) {
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

  /**
   * The Files library. `{ images }` is what this route always returned, every
   * file largest-first, and it still does when no parameter is given (the
   * asset picker and the Overview read the whole list). `total`, `limit`,
   * `offset` and `summary` are additive; `q`/`type`/`usage`/`sort`/`limit`/
   * `offset` filter and page in SQL. A malformed value is a 400, since silently
   * ignoring it would filter or page the list wrongly.
   */
  @AdminOnly()
  @Get('admin/images')
  async listAdmin(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('usage') usage?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.images.listPage({
      q: q?.trim() || undefined,
      kind: oneOf(type, 'type', IMAGE_KINDS),
      usage: oneOf(usage, 'usage', IMAGE_USAGES),
      sort: oneOf(sort, 'sort', IMAGE_SORTS),
      limit: wholeNumber(limit, 'limit', 1),
      offset: wholeNumber(offset, 'offset', 0),
    });
  }

  /** One file for the detail sheet (`?file=<id>`): uploader and the items that use it. */
  @AdminOnly()
  @Get('admin/images/:id')
  async getAdmin(@Param('id') id: string) {
    return { image: await this.images.get(id) };
  }

  @AdminOnly()
  @Delete('admin/images/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthedUser) {
    await this.images.remove(id, user.id);
    return { ok: true };
  }
}
