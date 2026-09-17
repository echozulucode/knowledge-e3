import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { parseBundleFiles, parseBundleAssets, parseBundleIndex, type OkfImportItem } from '@echozedlabs/okf';
import type { BundleValidationReport, WriteSource } from '@echozedlabs/knowledge-types';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { newId, nowIso } from '../common/ids.js';
import { slugify } from '../common/slug.js';
import { actorFrom, type ServerActor } from '../content/actor.js';
import { ContentCommandsService } from '../content/content-commands.service.js';
import { ItemsService, type ItemView } from '../items/items.service.js';
import { ImagesService } from '../images/images.service.js';
import { conceptPaths, gateBundle, policyDiagnosticsByPath } from './okf-bundle-validation.js';
import { bodyOf, e3FrontmatterFromFile } from '../storage/index-rebuild.service.js';
import { extractTarGz } from './tar.js';
import type { ReadActor } from '../pages/pages.service.js';

/**
 * Who is importing. `username` is optional (a script or test may only know the
 * id); when present it gives the command actor its `human:<username>` OKF actor,
 * exactly as `actorFrom` does for the other doors.
 */
export type ImportActor = ReadActor & { username?: string };

/** One concept document of a bundle: what the importer parsed, and the document it parsed it from. */
export interface ImportConcept {
  item: OkfImportItem;
  raw: string;
}

/**
 * The bundle's concepts in bundle order, each with its raw document. Pairs
 * `parseBundleFiles` with the files it kept by applying `conceptPaths` — the
 * same filter, kept in step with it for exactly this positional pairing — to
 * each file on its own.
 */
function bundleConcepts(files: { path: string; content: string }[]): ImportConcept[] {
  const kept = files.filter((f) => conceptPaths([f]).length === 1);
  return parseBundleFiles(files).map((item, index) => ({ item, raw: kept[index]!.content }));
}

/**
 * `sync_diagnostics.source_id` for policy findings from a bundle import. A bundle
 * arrives through a door, not from a registered source, so it has no real source
 * id — and the column has no foreign key precisely because it is the sync path's
 * partition key, not a join. Content health's lint-failed queue selects by `page_id`
 * where `cleared_at is null`, and since 2026-09-13 also DISPLAYS this column: a row
 * whose source id is this constant is labelled "OKF import" rather than a sync
 * source (web/src/features/health/lintQueue.ts keeps the same literal - change
 * both together). A constant keeps bundle findings partitioned away from any
 * repository's without inventing a second reporting channel.
 */
const IMPORT_SOURCE_ID = 'okf-import';

export type ImportStatus = 'draft' | 'published';

/** A `.tar.gz` bundle split into what the gate reads and what the asset restore reads. */
export interface BundleArchive {
  /** Concept documents and asset descriptor sidecars, decoded as UTF-8. */
  textFiles: { path: string; content: string }[];
  /** Binary asset bytes under `assets/`, sidecars excluded. */
  assetBytes: { path: string; bytes: Buffer }[];
}

/**
 * Read an uploaded bundle archive entirely in memory. Shared by the archive
 * import and its dry run (`POST /okf/validate/archive`) so both gate the same
 * text files: a validate that extracted differently from the import would be
 * previewing a different bundle.
 *
 * Nothing touches the disk — no temp dir to clean up, and no way for a dry run
 * to leave an extracted file under the content root.
 *
 * A body that is not gzip, or not a tar inside it, is a 400: the caller sent
 * something that is not an archive at all, which is a different statement from
 * the 422 "an archive, but not an OKF bundle".
 */
export function readBundleArchive(archive: Buffer): BundleArchive {
  let extracted: ReturnType<typeof extractTarGz>;
  try {
    extracted = extractTarGz(archive);
  } catch {
    throw new BadRequestException('expected a .tar.gz OKF bundle archive; the body could not be decompressed');
  }
  return {
    textFiles: extracted
      .filter((e) => e.path.endsWith('.md') || e.path.endsWith('.meta.json'))
      .map((e) => ({ path: e.path, content: e.bytes.toString('utf8') })),
    assetBytes: extracted
      .filter((e) => e.path.startsWith('assets/') && !e.path.endsWith('.meta.json'))
      .map((e) => ({ path: e.path, bytes: e.bytes })),
  };
}

export interface OkfImportResult {
  created: number;
  updated: number;
  ids: string[];
  /**
   * How many items declared no lifecycle state and took the default. A large
   * number here is the usual explanation for "I imported N files but only see M"
   * — they landed as drafts and anonymous visitors only see published items.
   */
  defaulted: number;
  /** The status the defaulted items received. */
  default_status: ImportStatus;
  /**
   * Values found in frontmatter that could not be interpreted as a lifecycle
   * state (e.g. `status: mostly-done`). Those items took the default. Reported
   * rather than silently swallowed, so a typo is discoverable.
   */
  unrecognized_status: { title: string; value: string }[];
  /** Binary assets restored from a full-fidelity archive (0 for JSON imports). */
  assets_imported: number;
  /** Assets in the archive that could not be re-registered (e.g. off-allowlist). */
  assets_failed: number;
  /**
   * The three-tier bundle report, present only when this import came through the
   * integrity gate. Absent on the warn-only inbound git path, which does not
   * gate and must not pay for the lint on every pulled file.
   */
  validation?: BundleValidationReport;
}

/** An import that went through the gate always carries its report. */
export type GatedOkfImportResult = OkfImportResult & { validation: BundleValidationReport };

export interface OkfImportOptions {
  /** Force every imported item into this topic (slug/name), overriding frontmatter. */
  space?: string;
  /**
   * Status for items whose frontmatter declares none. Callers that know the
   * source (e.g. a repo pull, which knows the binding's default_status) should
   * pass it; otherwise the instance-wide fallback applies.
   */
  defaultStatus?: ImportStatus;
  /**
   * Apply the bundle integrity gate (the product roadmap §7.1): validate all three
   * tiers before the first write, refuse the bundle WHOLE when the conformance
   * tier carries a `critical`, and record the policy tier as content diagnostics
   * once the write succeeds.
   *
   * Off by default, and deliberately so. The *import doors* — the MCP
   * `import_okf` tool and the `/okf/import*` endpoints — turn it on: they take a
   * bundle somebody hands us, and a malformed one written halfway is an index
   * nobody can explain afterwards. The inbound git path does NOT: a file arriving
   * from a mirrored repository stays warn-only and still indexes, because
   * refusing another repository's content would break the mirror it is a mirror
   * of.
   */
  gate?: boolean;
  /**
   * The door the bundle came through (`rest` for `/okf/import*` and a repo pull,
   * `mcp` for `knowledge.import_okf`), recorded as the command actor's `via`
   * like every other door records it. Default `import` (the CLI script, tests).
   * It does NOT choose the publish gate: every write is issued with source
   * `import` — see `IMPORT_WRITE_SOURCE`.
   */
  via?: WriteSource;
}

/**
 * The `WriteSource` every imported item is written with, whichever door carried
 * the bundle.
 *
 * WHY `import` and not the door: the import contract is that a CONFORMANT bundle
 * is never refused for failing this instance's content policy — its policy
 * findings are recorded for Content health instead (see `recordPolicyDiagnostics`
 * and okf-bundle-gate.e2e.test.ts). `ContentCommandsService.assertPublishable`
 * is the one publish gate for every door, and it already treats `import` (with
 * `git`) as an inbound, warn-only source: an imported item that lands published
 * with error-severity diagnostics is not refused, and — as for the git door —
 * no `content.refused` row is written, because nothing was refused. Passing
 * `rest`/`mcp` here would silently turn the import's warn-only policy tier into
 * a per-item refusal part-way through a bundle.
 */
const IMPORT_WRITE_SOURCE: WriteSource = 'import';

/**
 * A bundle import that stopped part-way: at least one item was already written
 * (each with its own outbox row — see `importItems` for why the import is
 * per-item) when a later one failed. Same HTTP status and body as the underlying
 * failure (so its `reason`, e.g. `changed_on_disk`, still reaches the caller and
 * the `okf.import_rejected` audit row), plus `partial_import`, which says what
 * DID land. An import that failed before writing anything throws the original
 * error unchanged: there is nothing partial to report.
 */
export interface PartialImportDetail {
  created: number;
  updated: number;
  /** Ids of the items written before the failure, in bundle order. */
  ids: string[];
  /** The concept that failed: its position among the bundle's concepts (0-based) and its title. */
  failed: { index: number; title: string };
}

interface ImportIdentityMatch {
  existing: ItemView | null;
  key: string;
}

/**
 * Import OKF concept documents back into Knowledge E3 — the reverse of the
 * export tool, completing the bidirectional bridge (OKF study Option C).
 *
 * A concept with an embedded `e3_id` is matched only by that stable identity.
 * Without an id, exact-title fallback is constrained to the unambiguous
 * destination topic, so re-importing updates without crossing topic boundaries.
 * Unmatched concepts are created.
 */
@Injectable()
export class OkfImportService {
  private readonly logger = new Logger(OkfImportService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly content: ContentCommandsService,
    private readonly images: ImagesService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  async importBundleFiles(
    actor: ImportActor,
    files: { path: string; content: string }[],
    opts: OkfImportOptions & { gate: true },
  ): Promise<GatedOkfImportResult>;
  async importBundleFiles(
    actor: ImportActor,
    files: { path: string; content: string }[],
    opts?: OkfImportOptions,
  ): Promise<OkfImportResult>;
  async importBundleFiles(
    actor: ImportActor,
    files: { path: string; content: string }[],
    opts: OkfImportOptions = {},
  ): Promise<OkfImportResult> {
    // The gate runs before the first write and throws, so a non-conformant
    // bundle is quarantined whole rather than imported up to the bad file.
    const validation = opts.gate ? gateBundle(files) : null;
    const result = await this.importItems(actor, bundleConcepts(files), opts);
    await this.applyBundleIndex(files, opts);
    if (!validation) return result;
    await this.recordPolicyDiagnostics(files, validation, result.ids);
    return { ...result, validation };
  }

  /**
   * Apply the bundle-root `index.md` presentation (profile, start-here, landing
   * prose) to the destination topic — only when the caller named one; a bundle
   * never creates topics. Runs after the concepts so the topic is known to exist.
   * TODO: rebuild-from-git (IndexRebuildService) does not yet read index.md.
   */
  private async applyBundleIndex(files: { path: string; content: string }[], opts: OkfImportOptions): Promise<void> {
    const ref = opts.space?.trim();
    const index = files.find((f) => f.path === 'index.md');
    if (!ref || !index) return;
    const info = parseBundleIndex(index.content);
    if (!info.presentation && !info.start_here && !info.landing_markdown) return;
    await this.db
      .updateTable('spaces')
      .set({
        ...(info.presentation ? { presentation: info.presentation } : {}),
        ...(info.start_here ? { start_here: info.start_here } : {}),
        ...(info.landing_markdown ? { landing_markdown: info.landing_markdown } : {}),
        updated_at: nowIso(),
      })
      .where((eb) => eb.or([eb('slug', '=', slugify(ref)), eb('name', '=', ref)]))
      .where('archived_at', 'is', null)
      .execute();
  }

  /**
   * Import a full-fidelity `.tar.gz` bundle: restore its binary assets, then its
   * concepts. Assets are re-registered FIRST so that per-page `image_links` resolve
   * when each concept is created/updated. Re-registration goes through the normal
   * content-addressed upload path, so identical bytes dedupe and the same
   * `assets/<file>` name is reproduced — the URLs embedded in concept bodies keep
   * resolving. An asset that fails the upload policy is counted, not fatal.
   *
   * Always gated: this method's only caller is the `/okf/import/archive` door,
   * so there is no warn-only archive path to preserve. The gate runs before the
   * ASSET restore as well as before the concepts — re-registering an image is a
   * write, and a refused archive must leave no orphans behind.
   */
  async importArchive(
    actor: ImportActor,
    archive: Buffer,
    opts: OkfImportOptions = {},
  ): Promise<GatedOkfImportResult> {
    const { textFiles, assetBytes } = readBundleArchive(archive);

    const validation = gateBundle(textFiles);

    let assetsImported = 0;
    let assetsFailed = 0;
    for (const asset of parseBundleAssets(textFiles, assetBytes)) {
      const d = asset.descriptor ?? {};
      const mime = typeof d['mime'] === 'string' ? (d['mime'] as string) : '';
      const alt = typeof d['alt'] === 'string' ? (d['alt'] as string) : undefined;
      const filename =
        typeof d['original_filename'] === 'string' ? (d['original_filename'] as string) : undefined;
      try {
        await this.images.upload(actor.id, Buffer.from(asset.bytes), mime, { alt, filename });
        assetsImported++;
      } catch {
        assetsFailed++;
      }
    }

    const result = await this.importItems(actor, bundleConcepts(textFiles), opts);
    await this.applyBundleIndex(textFiles, opts);
    result.assets_imported = assetsImported;
    result.assets_failed = assetsFailed;
    await this.recordPolicyDiagnostics(textFiles, validation, result.ids);
    return { ...result, validation };
  }

  /**
   * Record the policy tier where Content health already looks: `sync_diagnostics`,
   * the same table the inbound git lint writes and the `lint_failed_inbound`
   * queue reads. A bundle import that fails local standards is exactly the
   * condition that queue describes, so it gets the existing channel rather than
   * a second one nobody would think to check.
   *
   * Concept paths and the returned ids line up positionally because
   * {@link conceptPaths} applies the same filter, in the same order, as
   * `parseBundleFiles` — that is how a finding on `concepts/orders.md` reaches
   * the page it became. A concept whose policy tier came back clean CLEARS any
   * earlier row for that path, mirroring how a clean inbound version clears.
   */
  private async recordPolicyDiagnostics(
    files: { path: string; content: string }[],
    validation: BundleValidationReport,
    ids: string[],
  ): Promise<void> {
    const byPath = policyDiagnosticsByPath(validation);
    const paths = conceptPaths(files);
    const now = nowIso();
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!;
      const pageId = ids[index] ?? null;
      await this.clearImportDiagnostics(path, pageId, now);
      const diagnostics = byPath.get(path) ?? [];
      // Only an `error` puts an item in the lint-failed queue; warnings would
      // fill it with style notes and make it useless, exactly as they would on
      // the inbound path (which records only when the lint actually failed).
      if (!diagnostics.some((d) => d.severity === 'error')) continue;
      await this.db
        .insertInto('sync_diagnostics')
        .values({
          id: newId(),
          source_id: IMPORT_SOURCE_ID,
          path,
          page_id: pageId,
          diagnostics_json: JSON.stringify(diagnostics),
          detected_at: now,
          cleared_at: null,
          commented_at: null,
        })
        .execute();
    }
  }

  /**
   * Clear this bundle path's open findings, and any open finding against the page
   * it resolved to: an item re-imported under a NEW path would otherwise keep the
   * old path's row open forever, since nothing else ever visits it again.
   */
  private async clearImportDiagnostics(path: string, pageId: string | null, at: string): Promise<void> {
    await this.db
      .updateTable('sync_diagnostics')
      .set({ cleared_at: at })
      .where('source_id', '=', IMPORT_SOURCE_ID)
      .where('cleared_at', 'is', null)
      .where((eb) => (pageId ? eb.or([eb('path', '=', path), eb('page_id', '=', pageId)]) : eb('path', '=', path)))
      .execute();
  }

  /**
   * What an import of these files WOULD do, for the validate dry run (review
   * §4.9, "what will change"): how many concepts would be created and how many
   * would update an existing item. Resolved with the import's own identity
   * match (`resolveExisting`: embedded `e3_id`, else exact title in the
   * destination topic), and read-only — the match is a lookup, nothing more.
   *
   * Null when the import itself would not get as far as writing: two concepts
   * resolving to the same identity (the import's 409), or a lookup that throws.
   * Counts for an import that will not run would be a promise the page cannot keep.
   */
  async previewChanges(
    actor: ReadActor,
    files: { path: string; content: string }[],
    opts: OkfImportOptions = {},
  ): Promise<{ would_create: number; would_update: number } | null> {
    try {
      const keys = new Set<string>();
      let wouldCreate = 0;
      let wouldUpdate = 0;
      for (const item of parseBundleFiles(files)) {
        const match = await this.resolveExisting(actor, item, opts);
        if (keys.has(match.key)) return null;
        keys.add(match.key);
        if (match.existing) wouldUpdate++;
        else wouldCreate++;
      }
      return { would_create: wouldCreate, would_update: wouldUpdate };
    } catch {
      return null;
    }
  }

  /**
   * Resolve every identity, then write each concept through `ContentCommands`
   * (plan §5.1, issue 70): the concept file first, then the index row and its
   * `content_outbox` row in ONE transaction, then the git mirror — the same
   * command path a UI, REST or MCP save takes. Nothing here touches
   * `PagesService` writes directly.
   *
   * WHY per-item and not one transaction around the whole bundle:
   * `ContentCommands` cannot run inside a caller-provided transaction. Each
   * command reads before it writes (`prepareCreate`/`prepareUpdate`, identity
   * allocation, source resolution, the on-disk digest guard), does file I/O
   * between those reads and its index transaction, and after committing hands
   * the item to the git mirror or — in a `review` source — stages and PUSHES an
   * item branch. The database is one SQLite connection behind Kysely's
   * connection mutex, so a bundle-wide transaction would either deadlock on the
   * commands' own `db` reads or, restructured to avoid that, hold the only
   * connection — blocking every other request's reads as well as writes — across
   * hundreds of file writes and, for review sources, network pushes. The only
   * all-or-nothing design is a batch variant of the command (prepare all → write
   * all files → one index transaction for N rows, as `rename` does for its
   * affected pages), which would duplicate the relocation, review-staging and
   * compensation logic `updateWriteFirst` owns; that is a follow-up, not this.
   *
   * So the guarantee is per item — each item's state and its outbox row commit
   * together or not at all, and a failed item's file is compensated — and the
   * bundle is made as close to all-or-nothing as a preflight can make it: every
   * identity (and so every 404/409 the match can raise, and the duplicate-identity
   * 409) is resolved before the first write, as before. A failure the preflight
   * cannot see (a concurrent edit, `changed_on_disk`, a read-only source) after
   * some items landed is reported explicitly as a partial import
   * (`PartialImportDetail`), never silently.
   */
  async importItems(
    actor: ImportActor,
    concepts: ImportConcept[],
    opts: OkfImportOptions = {},
  ): Promise<OkfImportResult> {
    const items = concepts.map((c) => c.item);
    const defaultStatus = opts.defaultStatus ?? instanceDefaultImportStatus();
    const result: OkfImportResult = {
      created: 0,
      updated: 0,
      ids: [],
      defaulted: 0,
      default_status: defaultStatus,
      unrecognized_status: [],
      assets_imported: 0,
      assets_failed: 0,
    };

    // Resolve every identity before performing the first write. This keeps a
    // later unknown/ambiguous destination from leaving an earlier concept
    // partially imported.
    const matches: ImportIdentityMatch[] = [];
    const identityKeys = new Set<string>();
    for (const item of items) {
      if (!item.status) result.defaulted++;
      if (item.unrecognizedStatus) {
        result.unrecognized_status.push({ title: item.title, value: item.unrecognizedStatus });
      }
      const match = await this.resolveExisting(actor, item, opts);
      if (identityKeys.has(match.key)) {
        throw new ConflictException(`duplicate import identity for "${item.title}"`);
      }
      identityKeys.add(match.key);
      matches.push(match);
    }

    const commandActor = commandActorOf(actor, opts);
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      let outcome: { action: 'created' | 'updated'; id: string };
      try {
        outcome = await this.persistItem(commandActor, concepts[index]!, opts, matches[index]!.existing);
      } catch (err) {
        throw this.partialImportError(err, result, { index, title: item.title });
      }
      if (outcome.action === 'created') result.created++;
      else result.updated++;
      result.ids.push(outcome.id);
    }
    return result;
  }

  /**
   * The error to surface when concept `failed` could not be written. Unchanged
   * when nothing was written yet — the bundle then failed as a whole, exactly as
   * before. Otherwise the same status and body, plus `partial_import`.
   */
  private partialImportError(err: unknown, progress: OkfImportResult, failed: PartialImportDetail['failed']): unknown {
    const written = progress.created + progress.updated;
    if (written === 0) return err;
    const partial: PartialImportDetail = {
      created: progress.created,
      updated: progress.updated,
      ids: [...progress.ids],
      failed,
    };
    const where = `OKF import stopped at concept ${failed.index + 1} ("${failed.title}") after ${written} item(s) were written`;
    if (err instanceof HttpException) {
      const response = err.getResponse();
      const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
      const cause = typeof body['message'] === 'string' ? body['message'] : err.message;
      return new HttpException({ ...body, message: `${where}: ${cause}`, partial_import: partial }, err.getStatus(), {
        cause: err,
      });
    }
    // An unexpected error: its message may be internal detail, so it goes to the
    // log and the caller gets the partial report under a plain 500.
    this.logger.error(`${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return new HttpException(
      { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: where, partial_import: partial },
      HttpStatus.INTERNAL_SERVER_ERROR,
      { cause: err },
    );
  }

  private async resolveExisting(
    actor: ReadActor,
    item: OkfImportItem,
    opts: OkfImportOptions,
  ): Promise<ImportIdentityMatch> {
    if (item.e3Id) {
      return {
        existing: await this.items.getById(item.e3Id, actor),
        key: JSON.stringify(['id', item.e3Id]),
      };
    }
    const resolved = await this.items.getByTitleInSpace(item.title, opts.space ?? item.space, actor);
    return {
      existing: resolved.item,
      key: JSON.stringify(['title', resolved.spaceId, item.title]),
    };
  }

  private async persistItem(
    actor: ServerActor,
    { item, raw }: ImportConcept,
    opts: OkfImportOptions,
    existing: ItemView | null,
  ): Promise<{ action: 'created' | 'updated'; id: string }> {
    // Items without an explicit status take the caller's default (a repo's
    // configured default_status) or the instance fallback.
    const status = item.status ?? opts.defaultStatus ?? instanceDefaultImportStatus();
    // The SAME mapping a rebuild applies to the file this write produces (and the
    // git inbound door to a file that arrives): the concept's `type` survives,
    // an authored `description` stays `description`, and the exporter's
    // synthesized provenance is not mistaken for real provenance. Mapping with
    // `toE3Frontmatter` alone dropped `type` and left a leading blank line on
    // the body, so a drop-and-rebuild changed every imported item (issue 70's
    // equivalence test found it).
    const frontmatter = e3FrontmatterFromFile(raw, item);
    const body = bodyOf(item);
    // Pull-into-topic forces the destination topic, overriding the file's own.
    if (opts.space) frontmatter['topic'] = opts.space;
    // Reflect the resolved status in the mirrored frontmatter too (keeps git + DB consistent).
    frontmatter['status'] = status;

    // The command path (issue 70): file, then index + outbox row in one
    // transaction, then the mirror. The version token is the one the preflight
    // read, so an edit that lands between the preflight and this write is a 409,
    // not a silent overwrite.
    if (existing) {
      const { item: updated } = await this.content.update(
        actor,
        existing.id,
        { title: item.title, body, frontmatter, status, tags: item.tags },
        existing.version_token,
        IMPORT_WRITE_SOURCE,
      );
      return { action: 'updated', id: updated.id };
    }

    const { item: created } = await this.content.create(
      actor,
      { id: item.e3Id, title: item.title, body, frontmatter, status, tags: item.tags },
      IMPORT_WRITE_SOURCE,
    );
    return { action: 'created', id: created.id };
  }
}

/** The `ContentCommands` actor for an import: the importing user, through the door the bundle came in by. */
function commandActorOf(actor: ImportActor, opts: OkfImportOptions): ServerActor {
  return actorFrom({ id: actor.id, username: actor.username, role: actor.role }, opts.via ?? IMPORT_WRITE_SOURCE);
}

/**
 * Instance-wide fallback for imported items that declare no status and whose
 * caller supplies no default: KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS =
 * 'published' | 'draft' (defaults to 'draft' — safe by default, matching the
 * instance read-access default).
 *
 * Prefer the per-repo `default_status`: whether content is ready to publish is a
 * property of its source, not of the whole instance.
 */
function instanceDefaultImportStatus(): ImportStatus {
  return process.env['KNOWLEDGE_E3_IMPORT_DEFAULT_STATUS'] === 'published' ? 'published' : 'draft';
}
