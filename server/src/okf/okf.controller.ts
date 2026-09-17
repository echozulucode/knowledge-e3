import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsArray } from 'class-validator';
import { AdminOnly, CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { auditBundle, summarizeBundleSignals } from '@echozedlabs/okf';
import { OkfExportService } from './okf-export.service.js';
import { OkfImportService, readBundleArchive, type PartialImportDetail } from './okf-import.service.js';
import { bundleSummaryLine, evaluateGate } from './okf-bundle-validation.js';
import { createTarGz } from './tar.js';
import { AuditService } from '../audit/audit.service.js';

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
    // `auditLog`, not `audit`: this controller already has an `audit()` route —
    // the OKF bundle HEALTH check at GET /okf/audit — which is a different
    // concept entirely from the audit log.
    private readonly auditLog: AuditService,
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
    await this.auditLog.record({
      actor_id: user.id,
      action: 'okf.export',
      payload: {
        format: 'json',
        item_count: result.item_count,
        space: space?.trim() ?? null,
        type: type?.trim() ?? null,
      },
    });
    return {
      okf_version: '0.2',
      item_count: result.item_count,
      conformance: result.conformance,
      files: result.bundle.files,
    };
  }

  /**
   * OKF v0.2 health audit of the whole library (admin-only, read-only). Returns
   * the three-tier report — normative `conformance` (the rejection gate), E3
   * `policy` recommendations, and v0.2 `advisories` (provenance/trust/freshness) —
   * plus a `signals` roll-up (counts by trust tier and freshness). `asOf` (a
   * `YYYY-MM-DD` date) makes staleness a reproducible "as of date X" query.
   */
  @AdminOnly()
  @Get('audit')
  async audit(
    @CurrentUser() user: AuthedUser,
    @Query('space') space?: string,
    @Query('type') type?: string,
    @Query('asOf') asOf?: string,
  ) {
    const result = await this.exporter.export(user, {
      space: space?.trim() || undefined,
      type: type?.trim() || undefined,
    });
    const opts = asOf?.trim() ? { asOf: asOf.trim() } : {};
    const report = auditBundle(result.bundle, opts);
    const signals = summarizeBundleSignals(result.bundle, opts);
    return { okf_version: '0.2', item_count: result.item_count, ...report, signals };
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
    // Full-fidelity archive: concept text + referenced binary assets and their
    // git-tracked sidecar descriptors, so the bundle is self-contained (an
    // exported `.tar.gz` no longer loses its images/attachments).
    const archiveFiles: { path: string; content: string | Uint8Array }[] = [...result.bundle.files];
    for (const asset of result.assets) {
      archiveFiles.push({ path: `assets/${asset.file}`, content: asset.bytes });
      if (asset.descriptorJson) {
        archiveFiles.push({ path: `assets/${asset.file}.meta.json`, content: asset.descriptorJson });
      }
    }
    const archive = createTarGz(archiveFiles);
    // After the archive exists, so a build that throws is not recorded as a
    // completed download of the whole library.
    await this.auditLog.record({
      actor_id: user.id,
      action: 'okf.export',
      payload: {
        format: 'archive',
        item_count: result.item_count,
        assets: result.assets.length,
        space: space?.trim() ?? null,
        type: type?.trim() ?? null,
      },
    });
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

  /**
   * An import door, so it gates (the product roadmap §7.1): a bundle whose
   * conformance tier carries a `critical` is refused whole with 422 and
   * `reason: 'bundle_not_conformant'` — nothing is written. Failing this
   * instance's content policy does not block the import; those findings come back
   * in `validation.policy` and are recorded for Content health.
   */
  @AdminOnly()
  @Post('import')
  async import(@CurrentUser() user: AuthedUser, @Body() body: OkfImportDto) {
    const files = bundleFilesOf(body);
    return this.auditedImport(user, { format: 'json', files: files.length }, () =>
      this.importer.importBundleFiles(user, files, { gate: true, via: 'rest' }),
    );
  }

  /**
   * The dry run for `POST import` (the admin UX plan A3): the same `{ files }`
   * body, the same three-tier report the gate builds, and NOTHING written — no
   * item, no `sync_diagnostics` row, no file, no commit, and no audit row. A
   * validation is a read of the caller's own upload, not an action on the
   * library, so there is nothing to record.
   *
   * A non-conformant bundle is a 200 here, not the import's 422: the question
   * asked was "would this import?", and "no, because…" is a successful answer.
   * `summary.conformant` carries the verdict. 200 rather than Nest's POST default
   * of 201 because nothing was created. `summary_line` is the MCP
   * `validate_okf_bundle` tool's prose verdict, so both doors say the same thing.
   *
   * `would_create` / `would_update` (review §4.9) say what the import would do,
   * matched the way the import matches. Present only for a conformant bundle —
   * a refused one changes nothing — and omitted when the import could not run
   * (see `OkfImportService.previewChanges`).
   */
  @AdminOnly()
  @Post('validate')
  @HttpCode(200)
  async validate(@CurrentUser() user: AuthedUser, @Body() body: OkfImportDto) {
    const files = bundleFilesOf(body);
    const report = evaluateGate(files);
    return { ...report, summary_line: bundleSummaryLine(report), ...(await this.wouldChange(user, files, report.summary.conformant)) };
  }

  /**
   * The dry run for `POST import/archive`: extracts in memory with the import's
   * own reader and gates the same text files. `assets` counts the binary files
   * the import would try to restore — reported, not validated, because the
   * upload policy that decides them is a write-time check (and an asset that
   * fails it is counted, never fatal, on import either).
   */
  @AdminOnly()
  @Post('validate/archive')
  @HttpCode(200)
  async validateArchive(@CurrentUser() user: AuthedUser, @Req() req: Request) {
    const { textFiles, assetBytes } = readBundleArchive(rawArchiveBody(req));
    const report = evaluateGate(textFiles);
    return {
      ...report,
      summary_line: bundleSummaryLine(report),
      assets: assetBytes.length,
      ...(await this.wouldChange(user, textFiles, report.summary.conformant)),
    };
  }

  /** The dry run's "what will change" fields, or nothing to spread when there is no honest answer. */
  private async wouldChange(
    user: AuthedUser,
    files: { path: string; content: string }[],
    conformant: boolean,
  ): Promise<{ would_create?: number; would_update?: number }> {
    if (!conformant) return {};
    return (await this.importer.previewChanges(user, files)) ?? {};
  }

  /**
   * Import a full-fidelity `.tar.gz` bundle (concepts + binary assets). The body
   * is the raw archive bytes (a scoped `express.raw` parser makes `req.body` a
   * Buffer — see configureApp); this is the reverse of `GET export/archive`.
   */
  @AdminOnly()
  @Post('import/archive')
  async importArchive(@CurrentUser() user: AuthedUser, @Req() req: Request) {
    const body = rawArchiveBody(req);
    return this.auditedImport(user, { format: 'archive', bytes: body.length }, () =>
      this.importer.importArchive(user, body, { via: 'rest' }),
    );
  }

  /**
   * Both import doors, audited the same way: `okf.import` on success,
   * `okf.import_rejected` when the conformance gate (or anything else) refuses.
   *
   * A refusal is the more interesting of the two — it is a whole-library write
   * that someone attempted and the instance turned away — so it is recorded
   * before the error is rethrown rather than left as a 422 in a client's face
   * and nowhere else. The bundle's CONTENT never enters the payload: it is
   * user-supplied text of unbounded size and unknown sensitivity.
   */
  private async auditedImport<T extends { created: number; updated: number }>(
    user: AuthedUser,
    context: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      await this.auditLog.record({
        actor_id: user.id,
        action: 'okf.import',
        payload: { ...context, created: result.created, updated: result.updated },
      });
      return result;
    } catch (err) {
      // A failure after some items landed (see `PartialImportDetail`) is not a
      // clean refusal: say how much of the bundle was written.
      const partial = partialImportOf(err);
      await this.auditLog.record({
        actor_id: user.id,
        action: 'okf.import_rejected',
        payload: {
          ...context,
          reason: refusalReason(err),
          ...(partial ? { partial: { created: partial.created, updated: partial.updated } } : {}),
        },
      });
      throw err;
    }
  }
}

/**
 * The well-formed `{ path, content }` entries of a JSON bundle body. Shared by
 * the import and its dry run so a malformed entry is dropped identically by both —
 * otherwise the validate would be judging files the import never sees.
 */
function bundleFilesOf(body: OkfImportDto): { path: string; content: string }[] {
  return (Array.isArray(body.files) ? body.files : []).filter(
    (f): f is { path: string; content: string } => typeof f?.path === 'string' && typeof f?.content === 'string',
  );
}

/** The raw archive bytes the scoped `express.raw` parser left on `req.body` (see configureApp). */
function rawArchiveBody(req: Request): Buffer {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new BadRequestException('expected a raw .tar.gz archive body');
  }
  return body;
}

/** The `partial_import` detail an import that stopped part-way carries, if this is one. */
function partialImportOf(err: unknown): PartialImportDetail | null {
  const response = (err as { response?: unknown })?.response;
  const partial = response && typeof response === 'object' ? (response as { partial_import?: unknown }).partial_import : null;
  return partial && typeof partial === 'object' ? (partial as PartialImportDetail) : null;
}

/**
 * The machine-readable refusal discriminator the import gate sets
 * (`bundle_not_conformant`), or the HTTP status when there is none. Never the
 * message: a validation error quotes the rejected file back at you.
 */
function refusalReason(err: unknown): string {
  const response = (err as { response?: unknown })?.response;
  if (response && typeof response === 'object' && typeof (response as { reason?: unknown }).reason === 'string') {
    return (response as { reason: string }).reason;
  }
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? `http_${status}` : 'error';
}
