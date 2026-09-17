# Search relevance eval set

`queries.yaml` is the regression gate for ranking changes (architecture plan §3.5, item 5).
Every `SearchProvider` implementation is scored against the same cases, so a ranker tweak or a
new provider that silently loses a query fails the tests.

**Two runs, one file** (reader UX plan §5.8). The set is scored against:

| Run | Where | What it proves |
|---|---|---|
| `InMemorySearchProvider` over `EVAL_CORPUS` | `packages/search/tests/eval.test.ts`, k=3 | the reference implementation and the ranking model |
| `SearchService` over a seeded SQLite database | `server/tests/search-eval.e2e.test.ts`, k=3 and k=5 | **the search `/search` and ⌘K actually call** — FTS5, the weighted ranker, the real visibility rules |

Both gate at `successRate === 1`. The second run exists because this gate was once green on a
feature the product did not have: the in-memory provider honoured `-term` exclusion, `SearchService`
did not, and only the in-memory provider was evaluated. `server/tests/search-provider-conformance.e2e.test.ts`
keeps the two from drifting again.

## File format

```yaml
cases:
  - id: docker-cache                     # optional, unique: names the case in reports and across runs
    query: docker cache                  # the string a reader would type (parser syntax allowed)
    expect: [troubleshoot-docker-build-cache]   # item ids that must all appear in the top k
    top: 1                               # optional: a stricter cutoff for this case (1 = must rank first)
    note: optional, why this case exists
```

- `query` is passed through `parseSearchQuery`, so quotes, `-excluded`, `tag:x`, `author:`, `updated:`
  and `is:` filters work. Use absolute `updated:` values here: a relative window (`30d`) moves with the
  clock and would make the gate flaky.
- `expect` lists item ids, not slugs or titles. All of them must be in the top k for the case to pass.
- `top` is for a case whose point is ORDER (the identifier boost), not presence; the smaller of `top`
  and the run's k applies.
- `note` is free text carried into the report so a failure explains itself.

`k` is not part of the file; the runner chooses it. The corpus both runs are written against is
`src/eval-corpus.ts` (`EVAL_CORPUS`) — it lives in `src/` rather than in `tests/` because the server
seeds the same documents into SQLite to evaluate the real search path.

## Running

```ts
import { InMemorySearchProvider, evaluate, loadEvalCases } from '@echozedlabs/search';

const cases = await loadEvalCases('packages/search/eval/queries.yaml');
const report = await evaluate(cases, provider, { k: 3 });
// report.successRate === 1, report.cases[i].ranks[j].rank is 1-based or null when missed
```

`pnpm --filter @echozedlabs/search test` runs the in-memory gate; `pnpm --filter @echozedlabs/server test`
runs the same set against the real `SearchService`. A relevance change has to pass both.

## Adding a case

1. Add the document to `src/eval-corpus.ts` if the query needs one that is not there — both runs
   index it, so one edit covers the provider and the product.
2. Add the case with a `note` that says what ranking behaviour it protects.
3. Run the tests. If the case fails, fix the ranking, not the expectation: the point of the set
   is to catch regressions, and an expectation that only passes because it was loosened protects
   nothing.
