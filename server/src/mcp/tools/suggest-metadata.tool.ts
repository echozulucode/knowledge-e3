import { Injectable } from '@nestjs/common';
import { parse } from '@echozedlabs/codec';
import { suggestMetadata, type MetadataSuggestion } from '@echozedlabs/content-model';
import { KnowledgeQueryService } from '../../query/knowledge-query.service.js';
import { viewerFrom } from '../../query/viewer.js';
import { SpacesService } from '../../taxonomy/spaces.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';

export interface McpSuggestMetadataInput extends Record<string, unknown> {
  raw_markdown?: string;
  topic?: string;
}

export interface McpSuggestMetadataResponse extends MetadataSuggestion {
  similar_items: Array<{ id: string; slug: string; title: string; type: string | null }>;
}

const SIMILAR_LIMIT = 10;
const BODY_EXCERPT_CHARS = 200;

/**
 * Deterministic metadata suggestion (plan §5.2): the content-model's
 * heading/template match for `type`, plus tags/categories that co-occur on the
 * items a title search finds. No model in-product; the calling agent decides.
 */
@Injectable()
export class SuggestMetadataTool implements McpTool<McpSuggestMetadataInput, McpSuggestMetadataResponse> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.suggest_metadata',
    title: 'Suggest metadata for a draft',
    description:
      'Suggest a content type (from the body headings vs. each registry template), primary category candidates, and tags (co-occurring on similar existing items) for a raw Markdown document, plus the similar items found and a duplicate-title flag. Deterministic; nothing is written.',
    inputSchema: {
      type: 'object',
      properties: {
        raw_markdown: stringProp('Full raw Markdown document with optional frontmatter.'),
        topic: stringProp('Topic slug/id to scope the similar-item search.'),
      },
      required: ['raw_markdown'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly query: KnowledgeQueryService,
    private readonly spaces: SpacesService,
  ) {}

  async call(input: McpSuggestMetadataInput, context: McpToolContext = {}): Promise<McpSuggestMetadataResponse> {
    const raw = typeof input.raw_markdown === 'string' ? input.raw_markdown : '';
    const topic = typeof input.topic === 'string' && input.topic.trim() ? input.topic.trim() : undefined;
    const q = searchTextFor(raw);
    // Same vocabularies ContentCommands lints against (tags/categories/groups as
    // they stand now). Categories are the CURATED catalog, matching `lintContext`:
    // suggesting a term the publish gate would then refuse is worse than
    // suggesting nothing (primary categories are curated, not emergent —
    // Eric, 2026-09-11).
    const [hits, tags, categories, groups] = await Promise.all([
      q ? this.query.search({ q, space: topic, limit: SIMILAR_LIMIT }, viewerFrom(context.user)) : null,
      this.spaces.listTags(),
      this.spaces.listCuratedCategories(),
      this.spaces.listGroups(),
    ]);
    const similar = hits?.results ?? [];
    const suggestion = suggestMetadata(raw, {
      similar: similar.map((hit) => ({ title: hit.title, type: hit.type ?? undefined, tags: hit.tags, categories: hit.categories })),
      known: { tags: tags.map((t) => t.slug), categories: categories.map((c) => c.slug), groups: groups.map((g) => g.slug) },
    });
    return {
      ...suggestion,
      similar_items: similar.map((hit) => ({ id: hit.id, slug: hit.slug, title: hit.title, type: hit.type ?? null })),
    };
  }
}

/**
 * The full-text query for "similar items": the title (frontmatter, else the
 * first H1), falling back to the first ~200 body characters when there is
 * none. Search ANDs its terms, so the short title query gives better recall
 * than title + body would.
 */
function searchTextFor(raw: string): string {
  let title = '';
  let body = raw;
  try {
    const parsed = parse(raw);
    body = parsed.body;
    if (typeof parsed.frontmatter['title'] === 'string') title = parsed.frontmatter['title'];
    if (!title) title = /^#\s+(.+)$/m.exec(parsed.body)?.[1] ?? '';
  } catch {
    // Unparseable frontmatter: fall through to the body excerpt.
  }
  const text = title.trim() || body.slice(0, BODY_EXCERPT_CHARS);
  return text.replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
