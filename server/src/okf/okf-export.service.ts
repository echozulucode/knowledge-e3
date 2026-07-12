import { Injectable } from '@nestjs/common';
import {
  buildBundle,
  validateBundle,
  type ConformanceReport,
  type LinkStyle,
  type OkfBundle,
  type PageInput,
} from '@echozedlabs/okf';
import { ItemsService, type ItemView } from '../items/items.service.js';
import type { ReadActor } from '../pages/pages.service.js';

const MAX_EXPORT = 100_000;

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
}

/**
 * Build an OKF bundle from the items a caller may see — the shared export path
 * used by the HTTP endpoint (and available to other callers). Permission-aware:
 * filtering and visibility are delegated to ItemsService.
 */
@Injectable()
export class OkfExportService {
  constructor(private readonly items: ItemsService) {}

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
    const bundle = buildBundle(pages, {
      linkStyle: opts.linkStyle ?? 'dual',
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Exported from Knowledge E3 in Open Knowledge Format (OKF v0.1).',
    });
    return { bundle, item_count: pages.length, conformance: validateBundle(bundle) };
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
