/**
 * The stdio app's `KnowledgeReadBackend`: fans each read out to the configured
 * sources and assembles the answer.
 *
 * THE CROSS-SOURCE RULE: scores from different sources come from different
 * indexes (an in-memory keyword index per local source, the server's FTS index
 * per remote) and are never compared. `knowledge.search` therefore returns one
 * group per source in `sources[]`, in configuration order, each group in that
 * source's own rank order with its own `total`. There is no merged ranking and
 * no top-level `results` list that would imply one.
 */
import { listContentTypes } from '@echozedlabs/content-model';
import { bundleSummaryLine, lint, validateOkfBundle } from '@echozedlabs/content-model';
import {
  ITEM_NOT_FOUND_MESSAGE,
  KnowledgeToolError,
  mapKnownToolError,
  validationResult,
  type ItemRefInput,
  type KnowledgeReadBackend,
  type SearchToolInput,
  type ValidateItemInput,
  type ValidateItemResult,
  type ValidateOkfBundleInput,
  type ValidateOkfBundleResult,
} from '@echozedlabs/mcp-tools';
import type { Logger } from './log.js';
import type { KnowledgeSource, SourceItem, SourceVocabulary } from './sources/types.js';

/** Per-call context: the optional `source` argument the stdio descriptors add. */
export interface AppCallContext {
  source?: string;
}

interface SourceError {
  source: string;
  source_type: string;
  error: { message: string; rpc_code: number };
}

export class MultiSourceBackend implements KnowledgeReadBackend<AppCallContext> {
  constructor(
    readonly sources: KnowledgeSource[],
    private readonly logger: Logger,
  ) {}

  sourceIds(): string[] {
    return this.sources.map((s) => s.id);
  }

  /** The sources a call targets: the named one, or all. An unknown name is the caller's mistake. */
  private selected(ctx: AppCallContext): KnowledgeSource[] {
    if (ctx.source === undefined) return this.sources;
    const source = this.sources.find((s) => s.id === ctx.source);
    if (!source) {
      throw new KnowledgeToolError(400, `Unknown source "${ctx.source}". Configured sources: ${this.sourceIds().join(', ')}.`, {
        sources: this.sourceIds(),
      });
    }
    return [source];
  }

  async search(input: SearchToolInput, ctx: AppCallContext = {}) {
    const targets = this.selected(ctx);
    const groups = await Promise.all(
      targets.map(async (source) => {
        try {
          return { source: source.id, source_type: source.type, ...(await source.search(input)) };
        } catch (err) {
          if (ctx.source !== undefined) throw err;
          return this.sourceError(source, err);
        }
      }),
    );
    const total = groups.reduce((sum, g) => {
      const n = (g as Record<string, unknown>)['total'];
      return sum + (typeof n === 'number' ? n : 0);
    }, 0);
    return { query: input, result_order: 'per-source' as const, sources: groups, total };
  }

  async getItem(ref: ItemRefInput, ctx: AppCallContext = {}) {
    const qualified = this.qualify(ref, ctx);
    if (qualified.source) {
      const item = await qualified.source.getItem(qualified.ref);
      if (!item) throw new KnowledgeToolError(404, `${ITEM_NOT_FOUND_MESSAGE} in source "${qualified.source.id}"`);
      return { item };
    }
    const found: SourceItem[] = [];
    const errors: SourceError[] = [];
    for (const source of this.sources) {
      try {
        const item = await source.getItem(qualified.ref);
        if (item) found.push(item);
      } catch (err) {
        errors.push(this.sourceError(source, err));
      }
    }
    if (found.length === 1) return { item: found[0]! };
    if (found.length > 1) {
      const refs = found.map((i) => i.ref);
      throw new KnowledgeToolError(409, `Ambiguous item reference: it matches ${refs.join(', ')}. Pass one of those source-qualified refs as \`id\`.`, {
        matches: refs,
      });
    }
    throw new KnowledgeToolError(404, ITEM_NOT_FOUND_MESSAGE, errors.length ? { source_errors: errors } : undefined);
  }

  async listSpaces(ctx: AppCallContext = {}) {
    const spaces: object[] = [];
    const errors: SourceError[] = [];
    for (const source of this.selected(ctx)) {
      try {
        spaces.push(...(await source.listSpaces()));
      } catch (err) {
        if (ctx.source !== undefined) throw err;
        errors.push(this.sourceError(source, err));
      }
    }
    return { spaces, total: spaces.length, ...(errors.length ? { source_errors: errors } : {}) };
  }

  async listTaxonomy(ctx: AppCallContext = {}) {
    const out = { tags: [] as object[], categories: [] as object[], groups: [] as object[] };
    const errors: SourceError[] = [];
    for (const source of this.selected(ctx)) {
      try {
        const t = await source.listTaxonomy();
        out.tags.push(...t.tags);
        out.categories.push(...t.categories);
        out.groups.push(...t.groups);
      } catch (err) {
        if (ctx.source !== undefined) throw err;
        errors.push(this.sourceError(source, err));
      }
    }
    return { ...out, ...(errors.length ? { source_errors: errors } : {}) };
  }

  async listContentTypes() {
    return { content_types: listContentTypes() };
  }

  /**
   * Lint only; nothing is written anywhere. Vocabulary: the named source's
   * (a server source's is read from its taxonomy endpoints), or the union of
   * the local sources' when none is named.
   */
  async validateItem(input: ValidateItemInput, ctx: AppCallContext = {}): Promise<ValidateItemResult> {
    const vocab = await this.vocabularyFor(ctx);
    const diagnostics = lint(input.raw_markdown, {
      ...(input.topic ? { space: input.topic } : {}),
      ...(typeof input.published === 'boolean' ? { published: input.published } : {}),
      ...(vocab ? { known: { tags: vocab.tags, categories: vocab.categories, groups: vocab.groups } } : {}),
      ...(vocab?.slugs ? { resolvableSlugs: new Set(vocab.slugs) } : {}),
    });
    return validationResult(diagnostics);
  }

  async validateOkfBundle(input: ValidateOkfBundleInput, ctx: AppCallContext = {}): Promise<ValidateOkfBundleResult> {
    const vocab = input.topic ? await this.vocabularyFor(ctx) : null;
    const report = validateOkfBundle(
      { files: input.files },
      input.topic && vocab ? { space: input.topic, known: { tags: vocab.tags, categories: vocab.categories, groups: vocab.groups } } : {},
    );
    return { ...report, summary_line: bundleSummaryLine(report) };
  }

  /** Re-read every local source from disk (no git pull). */
  async refresh(ctx: AppCallContext = {}) {
    const refreshed = [];
    for (const source of this.selected(ctx)) {
      await source.load();
      refreshed.push(source.info());
    }
    return { sources: refreshed };
  }

  listSources() {
    return { sources: this.sources.map((s) => s.info()) };
  }

  private async vocabularyFor(ctx: AppCallContext): Promise<SourceVocabulary | null> {
    if (ctx.source !== undefined) return this.selected(ctx)[0]!.vocabulary();
    const local = this.sources.filter((s) => s.type !== 'server');
    if (!local.length) return null;
    const merged = { tags: new Set<string>(), categories: new Set<string>(), groups: new Set<string>(), slugs: new Set<string>() };
    for (const source of local) {
      try {
        const v = await source.vocabulary();
        v.tags.forEach((t) => merged.tags.add(t));
        v.categories.forEach((t) => merged.categories.add(t));
        v.groups.forEach((t) => merged.groups.add(t));
        v.slugs?.forEach((t) => merged.slugs.add(t));
      } catch {
        // an unloaded source contributes no vocabulary
      }
    }
    return { tags: [...merged.tags], categories: [...merged.categories], groups: [...merged.groups], slugs: [...merged.slugs] };
  }

  /**
   * `<source>:<id-or-slug>` in `id` or `slug` names one source unambiguously.
   * A plain ref goes to the `source` argument when given, else to every source.
   */
  private qualify(ref: ItemRefInput, ctx: AppCallContext): { source?: KnowledgeSource; ref: ItemRefInput } {
    for (const key of ['id', 'slug'] as const) {
      const value = ref[key];
      if (!value) continue;
      const cut = value.indexOf(':');
      if (cut <= 0) continue;
      const source = this.sources.find((s) => s.id === value.slice(0, cut));
      if (!source) continue;
      if (ctx.source !== undefined && ctx.source !== source.id) {
        throw new KnowledgeToolError(400, `The ref "${value}" names source "${source.id}" but \`source\` is "${ctx.source}".`);
      }
      return { source, ref: { [key]: value.slice(cut + 1) } };
    }
    if (ctx.source !== undefined) return { source: this.selected(ctx)[0]!, ref };
    return { ref };
  }

  private sourceError(source: KnowledgeSource, err: unknown): SourceError {
    const known = mapKnownToolError(err);
    if (known) return { source: source.id, source_type: source.type, error: { message: known.message, rpc_code: known.code } };
    this.logger.error(`[${source.id}] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return { source: source.id, source_type: source.type, error: { message: `Source "${source.id}" failed; see the server log on stderr.`, rpc_code: -32603 } };
  }
}
