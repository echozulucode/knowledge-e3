import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsArray } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { OkfExportService } from './okf-export.service.js';
import { OkfImportService } from './okf-import.service.js';
import { createTarGz } from './tar.js';

class OkfImportDto {
  @IsArray() files!: { path: string; content: string }[];
}

/**
 * Human-facing OKF data bridge: download the library as an OKF bundle and import
 * one back, no CLI or agent required. Admin-only — these are whole-library data
 * operations. The download is a JSON envelope ({ files }) that the import accepts
 * verbatim; a directory of `.md` files is also available via the CLI/git mirror.
 */
@Controller('okf')
export class OkfController {
  constructor(
    private readonly exporter: OkfExportService,
    private readonly importer: OkfImportService,
  ) {}

  @AdminOnly()
  @Get('export')
  async export(
    @CurrentUser() user: AuthedUser,
    @Query('space') space?: string,
    @Query('type') type?: string,
  ) {
    const result = await this.exporter.export(user, {
      space: space?.trim() || undefined,
      type: type?.trim() || undefined,
    });
    return {
      okf_version: '0.1',
      item_count: result.item_count,
      conformance: result.conformance,
      files: result.bundle.files,
    };
  }

  @AdminOnly()
  @Get('export/archive')
  async exportArchive(
    @CurrentUser() user: AuthedUser,
    @Res() res: Response,
    @Query('space') space?: string,
    @Query('type') type?: string,
  ): Promise<void> {
    const result = await this.exporter.export(user, {
      space: space?.trim() || undefined,
      type: type?.trim() || undefined,
    });
    const archive = createTarGz(result.bundle.files);
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = space?.trim() ? `-${space.trim().replace(/[^a-z0-9-]+/gi, '-')}` : '';
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="knowledge-okf${suffix}-${stamp}.tar.gz"`,
      'X-OKF-Item-Count': String(result.item_count),
      'X-OKF-Conformant': String(result.conformance.conformant),
    });
    res.send(archive);
  }

  @AdminOnly()
  @Post('import')
  async import(@CurrentUser() user: AuthedUser, @Body() body: OkfImportDto) {
    const files = (Array.isArray(body.files) ? body.files : []).filter(
      (f): f is { path: string; content: string } =>
        typeof f?.path === 'string' && typeof f?.content === 'string',
    );
    return this.importer.importBundleFiles(user, files);
  }
}
