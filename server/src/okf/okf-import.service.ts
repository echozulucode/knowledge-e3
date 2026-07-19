import { Injectable } from '@nestjs/common';
import { parseBundleFiles, type OkfImportItem } from '@echozedlabs/okf';
import { ItemsService } from '../items/items.service.js';
import type { ReadActor } from '../pages/pages.service.js';

export type ImportStatus = 'draft' | 'published';

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
}

export interface OkfImportOptions {
  /** Force every imported item into this topic (slug/name), overriding frontmatter. */
  space?: string;
  /**
   * Status for items whose frontmatter declares none. Callers that know the
   * source (e.g. a repo pull, which knows the binding's default_status) should
   * pass it; otherwise the instance-wide fallback applies.
   */
  defaultStatus?: ImportStatus;
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
    const defaultStatus = opts.defaultStatus ?? instanceDefaultImportStatus();
    const result: OkfImportResult = {
      created: 0,
      updated: 0,
      ids: [],
      defaulted: 0,
      default_status: defaultStatus,
      unrecognized_status: [],
    };
    for (const item of items) {
      if (!item.status) result.defaulted++;
      if (item.unrecognizedStatus) {
        result.unrecognized_status.push({ title: item.title, value: item.unrecognizedStatus });
      }
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
    // Items without an explicit status take the caller's default (a repo's
    // configured default_status) or the instance fallback.
    const status = item.status ?? opts.defaultStatus ?? instanceDefaultImportStatus();
    const frontmatter = toE3Frontmatter(item);
    // Pull-into-topic forces the destination topic, overriding the file's own.
    if (opts.space) frontmatter['topic'] = opts.space;
    // Reflect the resolved status in the mirrored frontmatter too (keeps git + DB consistent).
    frontmatter['status'] = status;
    const existing =
      (item.e3Id ? await this.items.getById(item.e3Id, actor) : null) ??
      (await this.items.getByTitle(item.title, actor));

    if (existing) {
      const updated = await this.items.update(actor, existing.id, existing.version_token, {
        title: item.title,
        body: item.body,
        frontmatter,
        status,
        tags: item.tags,
      });
      return { action: 'updated', id: updated.id };
    }

    const created = await this.items.create(actor.id, {
      title: item.title,
      body: item.body,
      frontmatter,
      status,
      tags: item.tags,
    });
    return { action: 'created', id: created.id };
  }
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
