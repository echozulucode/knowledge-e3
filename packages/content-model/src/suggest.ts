/**
 * Deterministic metadata suggestion (plan §4/§6): no model, no I/O.
 *   - type: Jaccard overlap between the document's H2 headings and each registry
 *     template's H2 headings, +0.5 when frontmatter already names that type.
 *   - tags / categories: frequency-ranked from `similar` items, filtered to the
 *     known vocabulary when one is given, top 5.
 *   - duplicate_title: exact case-insensitive title match in `similar`.
 */
import { parse, type ParsedPage } from '@echozedlabs/codec';
import type { LintContext } from '@echozedlabs/knowledge-types';
import { CONTENT_TYPES, findContentType } from './registry.js';

export interface SuggestInput {
  similar?: Array<{ title: string; type?: string; tags?: string[]; categories?: string[] }>;
  known?: LintContext['known'];
}

export interface MetadataSuggestion {
  /** Best-scoring type label, when any type scored above zero. */
  type?: string;
  /** Every registry type with its score, best first. */
  types: Array<{ label: string; score: number }>;
  categories: string[];
  tags: string[];
  duplicate_title: boolean;
}

const SUGGESTION_LIMIT = 5;

let templateHeadings: Map<string, Set<string>> | undefined;

export function suggestMetadata(raw: string, input: SuggestInput = {}): MetadataSuggestion {
  let parsed: ParsedPage | undefined;
  try {
    parsed = parse(raw);
  } catch {
    parsed = undefined;
  }
  const fm = parsed?.frontmatter ?? {};
  const headings = parsed ? h2Headings(parsed) : new Set<string>();
  const declared = typeof fm['type'] === 'string' ? findContentType(fm['type']) : undefined;

  if (!templateHeadings) {
    templateHeadings = new Map(CONTENT_TYPES.map((t) => [t.key, h2Headings(parse(t.template))]));
  }
  const types = CONTENT_TYPES.map((t) => ({
    label: t.label,
    score: jaccard(headings, templateHeadings!.get(t.key)!) + (declared?.key === t.key ? 0.5 : 0),
  })).sort((a, b) => b.score - a.score); // stable: registry order breaks ties
  const best = types[0];

  const similar = input.similar ?? [];
  const title = typeof fm['title'] === 'string' ? fm['title'].trim().toLowerCase() : '';

  return {
    ...(best && best.score > 0 ? { type: best.label } : {}),
    types,
    categories: rank(similar.flatMap((s) => s.categories ?? []), input.known?.categories),
    tags: rank(similar.flatMap((s) => s.tags ?? []), input.known?.tags),
    duplicate_title: title !== '' && similar.some((s) => s.title.trim().toLowerCase() === title),
  };
}

/** Frequency-rank values (ties keep first-seen order), filtered to `known` when given, top 5. */
function rank(values: string[], known?: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const allowed = known ? new Set(known.map((k) => k.trim().toLowerCase())) : undefined;
  return [...counts.entries()]
    .filter(([v]) => !allowed || allowed.has(v.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUGGESTION_LIMIT)
    .map(([v]) => v);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let common = 0;
  for (const v of a) if (b.has(v)) common++;
  return common / (a.size + b.size - common);
}

type Node = ParsedPage['ast']['children'][number];

function h2Headings(parsed: ParsedPage): Set<string> {
  const out = new Set<string>();
  for (const node of parsed.ast.children) {
    if (node.type === 'heading' && node.depth === 2) {
      const text = plainText(node).trim().toLowerCase();
      if (text) out.add(text);
    }
  }
  return out;
}

function plainText(node: Node): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return (node.children as Node[]).map(plainText).join('');
  }
  return '';
}
