/**
 * The server's implementation of the shared MCP read contract
 * (`@echozedlabs/mcp-tools` `KnowledgeReadBackend`).
 *
 * Every read goes through the same seams REST uses — `KnowledgeQueryService`
 * for search and items (draft visibility and the private-topic gate live
 * there), `SpacesService` for the taxonomy lists, `ContentCommandsService` for
 * the lint — so an MCP answer and a REST answer cannot disagree. The tool
 * classes in `tools/` are thin adapters that route through `callReadTool`, which
 * owns argument normalization for this host and the stdio knowledge-mcp app.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { BundleValidationOptions } from '@echozedlabs/content-model';
import {
  ITEM_NOT_FOUND_MESSAGE,
  toMcpItem,
  validationResult,
  type GetItemResult,
  type ItemRefInput,
  type KnowledgeReadBackend,
  type SearchToolInput,
  type ValidateItemInput,
  type ValidateItemResult,
  type ValidateOkfBundleInput,
  type ValidateOkfBundleResult,
} from '@echozedlabs/mcp-tools';
import { ContentCommandsService } from '../content/content-commands.service.js';
import { listContentTypes } from '../content-types/content-types.registry.js';
import { ItemsService } from '../items/items.service.js';
import { bundleSummaryLine, inspectBundle } from '../okf/okf-bundle-validation.js';
import { KnowledgeQueryService, withLifecycleSignals, type ItemViewWithSignals } from '../query/knowledge-query.service.js';
import { toReadActor, viewerFrom } from '../query/viewer.js';
import { SpacesService } from '../taxonomy/spaces.service.js';
import type { McpToolContext } from './tools/schemas.js';

function isAnonymousViewer(context: McpToolContext): boolean {
  return viewerFrom(context.user).role === 'anonymous';
}

@Injectable()
export class McpReadBackend implements KnowledgeReadBackend<McpToolContext> {
  constructor(
    private readonly query: KnowledgeQueryService,
    private readonly items: ItemsService,
    private readonly spaces: SpacesService,
    private readonly content: ContentCommandsService,
  ) {}

  async search(input: SearchToolInput, context: McpToolContext = {}) {
    // Same filters as REST /search; the draft-visibility rule lives in the seam.
    return this.query.search(
      {
        q: input.q,
        space: input.space,
        tag: input.tag,
        category: input.category,
        group: input.group,
        type: input.type,
        status: input.status,
        include_drafts: input.include_drafts,
        sort: input.sort,
        limit: input.limit,
      },
      viewerFrom(context.user),
    );
  }

  async getItem(ref: ItemRefInput, context: McpToolContext = {}): Promise<GetItemResult> {
    const page = await this.findPage(ref, context);
    // A miss is the caller's answer, not a server fault: an HttpException keeps
    // the message public on both transports instead of collapsing it into
    // the generic internal error an unexpected Error gets.
    if (!page) throw new NotFoundException(ITEM_NOT_FOUND_MESSAGE);
    return { item: toMcpItem(page) };
  }

  // MCP is open to anonymous callers on a public instance (@PublicRpc), so the
  // lists apply the same private-topic gate as REST /spaces and /taxonomy/*:
  // an anonymous caller never learns a private topic's name or its counts.
  async listSpaces(context: McpToolContext = {}) {
    const spaces = await this.spaces.listWithCounts({ anonymousViewer: isAnonymousViewer(context) });
    return { spaces, total: spaces.length };
  }

  async listTaxonomy(context: McpToolContext = {}) {
    const opts = { anonymousViewer: isAnonymousViewer(context) };
    const [tags, categories, groups] = await Promise.all([
      this.spaces.listTags(undefined, opts),
      this.spaces.listCategories(undefined, opts),
      this.spaces.listGroups(undefined, opts),
    ]);
    return { tags, categories, groups };
  }

  async listContentTypes() {
    return { content_types: listContentTypes() };
  }

  /** Dry run of the content-model lint (plan §5.2, §6.2) with the live vocabularies; nothing is written. */
  async validateItem(input: ValidateItemInput): Promise<ValidateItemResult> {
    const diagnostics = await this.content.lint(input.raw_markdown, {
      space: input.topic,
      ...(typeof input.published === 'boolean' ? { published: input.published } : {}),
    });
    return validationResult(diagnostics);
  }

  async validateOkfBundle(input: ValidateOkfBundleInput): Promise<ValidateOkfBundleResult> {
    const report = inspectBundle(input.files, input.topic ? await this.vocabularyContext(input.topic) : {});
    return { ...report, summary_line: bundleSummaryLine(report) };
  }

  private async findPage(ref: ItemRefInput, context: McpToolContext): Promise<ItemViewWithSignals | null> {
    const viewer = viewerFrom(context.user);
    if (ref.id) return this.query.item(ref.id, viewer);
    if (ref.slug) return this.query.item(ref.slug, viewer);
    if (ref.title) {
      const item = await this.items.getByTitle(ref.title, toReadActor(viewer));
      return item ? withLifecycleSignals(item) : null;
    }
    return null;
  }

  /**
   * The same vocabularies ContentCommands lints a single edit against. They are
   * instance-wide (tags and categories are not partitioned by topic); `space`
   * still travels so a future per-topic vocabulary lands here without changing
   * the tool's contract.
   *
   * Categories are the CURATED catalog, exactly as `lintContext` reads them, so
   * this preview and the gate agree; a preview that passed a term the gate
   * refuses would be worse than no preview.
   */
  private async vocabularyContext(topic: string): Promise<BundleValidationOptions> {
    const [tags, categories, groups] = await Promise.all([
      this.spaces.listTags(),
      this.spaces.listCuratedCategories(),
      this.spaces.listGroups(),
    ]);
    return {
      space: topic,
      known: {
        tags: tags.map((t) => t.slug),
        categories: categories.map((c) => c.slug),
        groups: groups.map((g) => g.slug),
      },
    };
  }
}
