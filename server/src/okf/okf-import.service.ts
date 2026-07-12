import { Injectable } from '@nestjs/common';
import { parseBundleFiles, type OkfImportItem } from '@echozedlabs/okf';
import { ItemsService } from '../items/items.service.js';
import type { ReadActor } from '../pages/pages.service.js';

export interface OkfImportResult {
  created: number;
  updated: number;
  ids: string[];
}

export interface OkfImportOptions {
  /** Force every imported item into this topic (slug/name), overriding frontmatter. */
  space?: string;
}

/**
 * Import OKF concept documents back into Knowledge E3 — the reverse of the
 * export tool, completing the bidirectional bridge (OKF study Option C).
 *
 * Each concept is matched to an existing item by its embedded `e3_id` first,
 * then by exact title, so re-importing a bundle into the same instance UPDATES
 * items rather than duplicating them. Unmatched concepts are created.
 */
@Injectable()
export class OkfImportService {
  constructor(private readonly items: ItemsService) {}

  async importBundleFiles(
    actor: ReadActor,
    files: { path: string; content: string }[],
    opts: OkfImportOptions = {},
  ): Promise<OkfImportResult> {
    return this.importItems(actor, parseBundleFiles(files), opts);
  }

  async importItems(
    actor: ReadActor,
    items: OkfImportItem[],
    opts: OkfImportOptions = {},
  ): Promise<OkfImportResult> {
    const result: OkfImportResult = { created: 0, updated: 0, ids: [] };
    for (const item of items) {
      const outcome = await this.importItem(actor, item, opts);
      if (outcome.action === 'created') result.created++;
      else result.updated++;
      result.ids.push(outcome.id);
    }
    return result;
  }

  async importItem(
    actor: ReadActor,
    item: OkfImportItem,
    opts: OkfImportOptions = {},
  ): Promise<{ action: 'created' | 'updated'; id: string }> {
    const frontmatter = toE3Frontmatter(item);
    // Pull-into-topic forces the destination topic, overriding the file's own.
    if (opts.space) frontmatter['topic'] = opts.space;
    const existing =
      (item.e3Id ? await this.items.getById(item.e3Id, actor) : null) ??
      (await this.items.getByTitle(item.title, actor));

    if (existing) {
      const updated = await this.items.update(actor, existing.id, existing.version_token, {
        title: item.title,
        body: item.body,
        frontmatter,
        ...(item.status ? { status: item.status } : {}),
        tags: item.tags,
      });
      return { action: 'updated', id: updated.id };
    }

    const created = await this.items.create(actor.id, {
      title: item.title,
      body: item.body,
      frontmatter,
      ...(item.status ? { status: item.status } : {}),
      tags: item.tags,
    });
    return { action: 'created', id: created.id };
  }
}

/** Rebuild E3-shaped frontmatter from a recovered OKF item. */
export function toE3Frontmatter(item: OkfImportItem): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...item.extraFrontmatter, title: item.title };
  if (item.status) fm['status'] = item.status;
  if (item.tags.length > 0) fm['tags'] = item.tags;
  if (item.categories.length > 0) fm['categories'] = item.categories;
  if (item.groups.length > 0) fm['groups'] = item.groups;
  if (item.space) fm['topic'] = item.space; // E3 persists space association via frontmatter.topic
  if (item.description) fm['summary'] = item.description;
  return fm;
}
