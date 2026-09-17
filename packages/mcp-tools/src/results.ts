/**
 * Result shapes of the read tools, built the same way by every host.
 *
 * The server's MCP tests pin these shapes; the stdio app produces them from a
 * working tree or a remote REST response, so an agent's code that reads
 * `result.item.body_markdown` or `result.counts.error` works against either.
 */
import type { BundleValidationReport, Diagnostic, ItemView, LifecycleSignals } from '@echozedlabs/knowledge-types';

/** `knowledge.validate_item` */
export interface ValidateItemResult {
  /** True when no error-severity diagnostic was produced. */
  ok: boolean;
  diagnostics: Diagnostic[];
  counts: { error: number; warning: number; info: number };
}

export function validationResult(diagnostics: Diagnostic[]): ValidateItemResult {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] += 1;
  return { ok: counts.error === 0, diagnostics, counts };
}

/** `knowledge.validate_okf_bundle` */
export interface ValidateOkfBundleResult extends BundleValidationReport {
  /** The same verdict in prose, for a log line or a human reading the transcript. */
  summary_line: string;
}

/** `knowledge.get_item` → `item`. */
export interface McpItem extends LifecycleSignals {
  id: string;
  slug: string;
  title: string;
  status: ItemView['status'];
  type: string | null;
  space: unknown;
  tags: string[];
  categories: string[];
  groups: string[];
  path: string;
  url: string;
  updated_at: string;
  version_token: number;
  body_markdown: string;
  raw_markdown: string;
  frontmatter: Record<string, unknown>;
}

export interface GetItemResult {
  item: McpItem;
}

/** The message a `knowledge.get_item` miss carries on every host. */
export const ITEM_NOT_FOUND_MESSAGE = 'knowledge.get_item could not find an item for the supplied id, slug, or title';

/** The fields `toMcpItem` reads — structural, so a host's own item view type fits without a cast. */
export type McpItemSource = Pick<
  ItemView,
  'id' | 'slug' | 'title' | 'status' | 'type' | 'space_id' | 'tags' | 'categories' | 'groups' | 'updated_at' | 'version_token' | 'body_markdown' | 'raw_markdown' | 'frontmatter'
> &
  LifecycleSignals;

/** The item view an MCP client receives: taxonomy, both bodies, frontmatter and the derived lifecycle signals. */
export function toMcpItem(item: McpItemSource): McpItem {
  const frontmatter = item.frontmatter ?? {};
  const spaceValue =
    typeof frontmatter['space'] === 'string'
      ? frontmatter['space']
      : typeof frontmatter['topic'] === 'string'
        ? frontmatter['topic']
        : item.space_id;
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    status: item.status,
    type: item.type,
    space: spaceValue,
    tags: item.tags,
    categories: item.categories,
    groups: item.groups,
    path: `/items/${item.id}`,
    url: `/p/${item.slug}`,
    updated_at: item.updated_at,
    version_token: item.version_token,
    body_markdown: item.body_markdown,
    raw_markdown: item.raw_markdown,
    frontmatter,
    // Derived lifecycle/trust signals (additive; same derivation REST serves).
    display_state: item.display_state,
    lifecycle_status: item.lifecycle_status,
    trust_tier: item.trust_tier,
    stale: item.stale,
    stale_after: item.stale_after,
    last_verified_at: item.last_verified_at,
    generated_by: item.generated_by,
    superseded_by: item.superseded_by,
  };
}
