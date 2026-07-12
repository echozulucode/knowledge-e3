# Testing Strategy

> Layered tests: cheapest first, most realistic last. Every behaviour described
> in [`features/*.feature`](../features/) has at least one test in this stack.

## Layers

| Layer | Where | Runner | Speed | What it catches |
|-------|-------|--------|-------|-----------------|
| **Codec unit tests** | `packages/codec/tests/` | Vitest | <1 s | Markdown round-trip; wiki-link extraction; AST-aware rewriting; ≥80% kill-criterion gate (currently 100% on 33 fixtures) |
| **Server e2e** | `server/tests/*.e2e.test.ts` | Vitest + supertest + in-memory SQLite | ~5 s | API contract: auth, page CRUD, versioning, optimistic concurrency, wiki-rename, search ranking, audit log writes, bug-report endpoint |
| **Web component unit** | `web/src/**/*.test.ts(x)` | Vitest (node env) | <2 s | Pure logic in the web client — e.g. editor host-services, copyable-content, topic filters; expand as `web/src/` grows |
| **Full-stack e2e (Playwright)** | `web/tests/e2e/` | Playwright + Chromium | ~30–60 s | Real browser drives real server. Catches integration bugs the lower layers miss (tsx-no-decorator-metadata was the canonical example) |

## Source of intent: `features/*.feature`

Plain Gherkin files in [`features/`](../features/). They are the *spec for
behaviour*, written before tests so the intent is obvious. Each `.feature`
file maps 1:1 to a Playwright spec under `web/tests/e2e/` (and many
scenarios are also covered at lower layers — that's the layered-tests
strategy at work).

| Feature | Layers covering it |
|---------|---------------------|
| 01 — authentication | server e2e + Playwright |
| 02 — page lifecycle | server e2e + Playwright |
| 03 — editor | Playwright (UI) |
| 04 — wiki-links and rename | codec unit + server e2e + Playwright |
| 05 — search | server e2e + Playwright |
| 06 — optimistic concurrency | server e2e + Playwright |
| 07 — audit and telemetry | server e2e + log inspection in Playwright |

Pending scenarios (tagged `@pending @wave-X` in the `.feature` files) get
their tests written when the corresponding wave ships. The `@perf`
scenario in 05 is exercised by `pnpm --filter @echozedlabs/server bench`.

## Run

From the repo root:

```bash
pnpm test:codec      # 1s — codec round-trip
pnpm test:server     # 5s — server e2e against in-memory SQLite
pnpm test:web        # 2s — web unit tests (vitest)
pnpm test:e2e        # 60s — Playwright full-stack browser tests
pnpm test            # everything except e2e
```

First-time-only on a fresh checkout:

```bash
pnpm install
pnpm test:e2e:install   # downloads Chromium for Playwright
```

## CI

`.github/workflows/test.yml` runs codec + server + web unit tests on every
push/PR.

## When to add a test

- **A new endpoint** → server e2e test (in-memory SQLite via supertest).
- **A new UI flow** → Playwright spec mapping to a feature scenario.
- **A new pure-logic module** → Vitest unit test next to the source.
- **A new Markdown corner case** → fixture in `packages/codec/tests/fixtures/`.

## When NOT to write a new test

- Don't duplicate behaviour across layers. If the server e2e covers it,
  the Playwright spec doesn't need to also assert it — pick the cheapest
  layer that catches the regression you're worried about.
- Don't write tests against unstable third-party UI internals. Test what
  *we* expose: the editor's data flow, the round-trip of saved Markdown, the
  conflict-on-save behaviour.
