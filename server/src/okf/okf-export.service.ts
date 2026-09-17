import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  buildBundle,
  validateBundle,
  type ConformanceReport,
  type LinkStyle,
  type OkfBundle,
  type PageInput,
} from '@echozedlabs/okf';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { ItemsService, type ItemView } from '../items/items.service.js';
import type { ReadActor } from '../pages/pages.service.js';
import { DEFAULT_SPACE_ID } from '../taxonomy/spaces.service.js';
import { AssetsService } from '../images/assets.service.js';
import { serializeDescriptor } from '../images/asset-descriptor.js';
import { extractAssetFiles } from '../pages/image-links.js';

const MAX_EXPORT = 100_000;

/** A referenced binary asset gathered for a full-fidelity (archive) export. */
export interface ExportedAsset {
  /** Content-addressed file name (`<sha16>.<ext>`); becomes `assets/<file>`. */
  file: string;
  bytes: Buffer;
  /** Serialized sidecar descriptor JSON, when a sidecar exists on disk. */
  descriptorJson?: string;
}

export interface OkfExportOptions {
  /** Restrict to a single space (topic), by space id or slug. */
  space?: string;
  /** Restrict to a single concept kind (OKF `type`) — export one "section". */
  type?: string;
  status?: 'draft' | 'published';
  tag?: string;
  linkStyle?: LinkStyle;
  limit?: number;
}

export interface OkfExportResult {
  bundle: OkfBundle;
  item_count: number;
  conformance: ConformanceReport;
  /**
   * Referenced binary assets (bytes + sidecars). Populated for full-fidelity
   * (archive) callers; the JSON `{ files }` endpoint ignores them.
   */
  assets: ExportedAsset[];
}

/**
 * Build an OKF bundle from the items a caller may see — the shared export path
 * used by the HTTP endpoint (and available to other callers). Permission-aware:
 * filtering and visibility are delegated to ItemsService.
 */
@Injectable()
export class OkfExportService {
  constructor(
    private readonly items: ItemsService,
    private readonly assets: AssetsService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  async export(actor: ReadActor | undefined, opts: OkfExportOptions = {}): Promise<OkfExportResult> {
    const views = await this.items.list(
      {
        status: opts.status,
        tag: opts.tag,
        space: opts.space,
        type: opts.type,
        limit: opts.limit ?? MAX_EXPORT,
      },
      actor,
    );
    const pages: PageInput[] = views.map(toPageInput);
    const topic = await this.indexTopic(opts.space);
    const bundle = buildBundle(pages, {
      linkStyle: opts.linkStyle ?? 'dual',
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Exported from Knowledge E3 in Open Knowledge Format (OKF v0.2).',
      presentation: topic?.presentation,
      startHere: topic?.start_here ?? undefined,
      landingMarkdown: topic?.landing_markdown ?? undefined,
    });
    return {
      bundle,
      item_count: pages.length,
      conformance: validateBundle(bundle),
      // Gathered from the ITEM views, not the `PageInput`s: only the views still
      // carry the parsed frontmatter, and a cover lives there rather than in the
      // body. `PageInput.rawMarkdown` would hand the extractor a YAML block it
      // has no business pattern-matching.
      assets: this.gatherAssets(views),
    };
  }

  /**
   * The topic whose presentation the bundle-root `index.md` carries: the scoped
   * topic (id or slug) when the export is limited to one, else the default topic.
   */
  private async indexTopic(ref: string | undefined) {
    const row = await this.db
      .selectFrom('spaces')
      .select(['presentation', 'start_here', 'landing_markdown'])
      .where((eb) => (ref ? eb.or([eb('id', '=', ref), eb('slug', '=', ref)]) : eb('id', '=', DEFAULT_SPACE_ID)))
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Collect every asset the exported items reference (union across bodies AND
   * frontmatter covers), read its bytes and git-tracked descriptor from the
   * assets store. A referenced file with no bytes on disk is skipped — the export
   * fails cleanly for it rather than shipping a broken/empty asset. Bytes read
   * once per unique file.
   */
  private gatherAssets(items: ItemView[]): ExportedAsset[] {
    const referenced = new Set<string>();
    for (const i of items) for (const f of extractAssetFiles(i.body_markdown, i.frontmatter)) referenced.add(f);
    if (referenced.size === 0) return [];
    const descriptorByFile = new Map(this.assets.readDescriptors().map((d) => [d.file, d]));
    const out: ExportedAsset[] = [];
    for (const file of referenced) {
      const bytes = this.assets.read(file);
      if (!bytes) continue;
      const descriptor = descriptorByFile.get(file);
      out.push({ file, bytes, descriptorJson: descriptor ? serializeDescriptor(descriptor) : undefined });
    }
    return out;
  }
}

function toPageInput(item: ItemView): PageInput {
  const fm = item.frontmatter ?? {};
  const space =
    typeof fm['space'] === 'string'
      ? (fm['space'] as string)
      : typeof fm['topic'] === 'string'
        ? (fm['topic'] as string)
        : item.space_id;
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    status: item.status,
    space,
    ownerId: item.owner_id,
    tags: item.tags,
    categories: item.categories,
    groups: item.groups,
    rawMarkdown: item.raw_markdown,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}
