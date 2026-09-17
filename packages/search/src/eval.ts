/**
 * Relevance eval harness (§3.5 item 5).
 *
 * A case names a query and the item ids that must appear in the top k. Run
 * against any `SearchProvider` so ranking changes are regression-tested and
 * providers can be compared on the same corpus. Cases live in
 * `packages/search/eval/queries.yaml`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { SearchProvider, Viewer } from '@echozedlabs/knowledge-types';

/**
 * The one eval set, addressable from any package. `src/` and `dist/` are both a
 * single directory under the package root, so this resolves to
 * `packages/search/eval/queries.yaml` whether the caller loaded the sources
 * (vitest) or the build (the server).
 */
export const EVAL_QUERIES_PATH = fileURLToPath(new URL('../eval/queries.yaml', import.meta.url));

export interface EvalCase {
  /** Stable name for the case, so a report line or another run can refer to it. */
  id?: string;
  query: string;
  /** Item ids expected in the top k. */
  expect: string[];
  /**
   * A stricter cutoff for this case: every expected id must rank within the top
   * `top` (1 = first). The run's own k still applies when it is smaller. For a
   * case whose point is ORDER rather than presence — "the acronym-titled page
   * comes first".
   */
  top?: number;
  note?: string;
}

export interface EvalCaseResult {
  id?: string;
  query: string;
  note?: string;
  /** True when every expected id is in the top k (or within the case's own `top`, when that is smaller). */
  hit: boolean;
  /** Each expected id with its 1-based rank, or null when it was not in the top k. */
  ranks: { id: string; rank: number | null }[];
  /** Ids actually returned, in rank order. */
  returned: string[];
}

export interface EvalReport {
  k: number;
  total: number;
  passed: number;
  /** `passed / total`; 0 when there are no cases so an empty set never reads as green. */
  successRate: number;
  cases: EvalCaseResult[];
}

const ANONYMOUS: Viewer = { userId: null, role: 'anonymous' };

export async function evaluate(
  cases: EvalCase[],
  provider: SearchProvider,
  opts: { k?: number; viewer?: Viewer } = {},
): Promise<EvalReport> {
  const k = opts.k ?? 5;
  const viewer = opts.viewer ?? ANONYMOUS;

  const results: EvalCaseResult[] = [];
  for (const evalCase of cases) {
    const hits = await provider.query({ q: evalCase.query, limit: k }, viewer);
    const returned = hits.slice(0, k).map((hit) => hit.id);
    const cutoff = Math.min(k, evalCase.top ?? k);
    const ranks = evalCase.expect.map((id) => {
      const index = returned.indexOf(id);
      return { id, rank: index === -1 ? null : index + 1 };
    });
    const hit = ranks.every((r) => r.rank !== null && r.rank <= cutoff);
    const result: EvalCaseResult = { query: evalCase.query, hit, ranks, returned };
    if (evalCase.id) result.id = evalCase.id;
    if (evalCase.note) result.note = evalCase.note;
    results.push(result);
  }

  const passed = results.filter((r) => r.hit).length;
  return {
    k,
    total: results.length,
    passed,
    successRate: results.length === 0 ? 0 : passed / results.length,
    cases: results,
  };
}

/** Reads a `queries.yaml` file: `{ cases: [{ id?, query, expect, top?, note? }] }` (see eval/README.md). */
export async function loadEvalCases(path: string): Promise<EvalCase[]> {
  const doc: unknown = parse(await readFile(path, 'utf8'));
  const cases = (doc as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(cases)) throw new Error(`${path}: expected a top-level \`cases\` list`);

  // Ids name cases across runs (the server's eval reports them), so a duplicate
  // is an error rather than one case silently shadowing another.
  const seenIds = new Set<string>();
  return cases.map((raw, i) => {
    const item = raw as Partial<EvalCase> | null;
    const query = item?.query;
    const expect = item?.expect;
    if (typeof query !== 'string' || !query.trim()) throw new Error(`${path}: case ${i + 1} needs a non-empty \`query\``);
    if (!Array.isArray(expect) || expect.length === 0 || !expect.every((id) => typeof id === 'string')) {
      throw new Error(`${path}: case ${i + 1} needs a non-empty \`expect\` list of item ids`);
    }
    const evalCase: EvalCase = { query, expect };
    if (item?.id !== undefined) {
      if (typeof item.id !== 'string' || !item.id.trim()) throw new Error(`${path}: case ${i + 1} has an empty or non-string \`id\``);
      if (seenIds.has(item.id)) throw new Error(`${path}: case id \`${item.id}\` is used twice`);
      seenIds.add(item.id);
      evalCase.id = item.id;
    }
    if (item?.top !== undefined) {
      if (typeof item.top !== 'number' || !Number.isInteger(item.top) || item.top < 1) {
        throw new Error(`${path}: case ${i + 1} needs \`top\` to be a positive integer`);
      }
      evalCase.top = item.top;
    }
    if (typeof item?.note === 'string') evalCase.note = item.note;
    return evalCase;
  });
}
