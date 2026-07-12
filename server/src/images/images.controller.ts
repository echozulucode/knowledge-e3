import { BadRequestException, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminOnly, CurrentUser, PublicRead } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { ImagesService } from './images.service.js';

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', tiff: 'image/tiff',
};
/** Stored files are content-addressed (`<sha16>.<ext>`); reject anything else. */
const SAFE_FILE = /^[a-zA-Z0-9]+\.[a-zA-Z0-9]+$/;

@Controller()
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('images')
  async upload(@CurrentUser() user: AuthedUser, @Req() req: Request, @Query('alt') alt?: string) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body)) throw new BadRequestException('expected a raw image body');
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    return this.images.upload(user.id, body, mime, alt);
  }

  @PublicRead()
  @Get('assets/:file')
  async serve(@Param('file') file: string, @Res() res: Response): Promise<void> {
    if (!SAFE_FILE.test(file)) {
      res.status(404).end();
      return;
    }
    const bytes = this.images.bytes(file);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    const found = await this.images.findByFile(file);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    res.set('Content-Type', found?.mime ?? EXT_MIME[ext] ?? 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
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
