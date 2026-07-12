# Web e2e tests (Playwright)

End-to-end tests that drive the real browser against a real server, against a
test SQLite DB seeded with an admin.

## What's covered

| Spec file | Maps to feature file |
|-----------|---------------------|
| `01-authentication.spec.ts` | `features/01-authentication.feature` |
| `02-page-lifecycle.spec.ts` | `features/02-page-lifecycle.feature` |
| `03-editor.spec.ts` | `features/03-editor.feature` |
| `04-wikilinks.spec.ts` | `features/04-wikilinks-and-rename.feature` |
| `05-search.spec.ts` | `features/05-search.feature` |
| `06-optimistic-concurrency.spec.ts` | `features/06-optimistic-concurrency.feature` |

Scenarios in the `.feature` files tagged `@pending @wave-X` are not yet
testable through the UI; they'll get a corresponding spec when that wave
ships.

## How it boots

`playwright.config.ts` runs both `pnpm --filter @echozedlabs/server dev` and
`pnpm --filter @echozedlabs/web dev` as managed `webServer` processes, on ports 3001
and 5174 (so they don't collide with your dev loop on 3000/5173).

A `globalSetup` in `tests/e2e/global-setup.ts` runs once before any tests:
it deletes `server/data/test-e2e.sqlite` and runs the seed script against
that DB so the admin exists.

## Run

From the repo root:

```bash
pnpm --filter @echozedlabs/web exec playwright install chromium    # first time
pnpm test:e2e                                              # full run
KEEP_DB=1 pnpm test:e2e                                    # keep DB across runs (faster local loop)
pnpm test:e2e --grep "authentication"                      # filter
```

The HTML reporter writes to `playwright-report/` on CI; the trace and screenshot
artefacts only appear on failures.

## Adding a new scenario

1. Add the scenario to the relevant `features/*.feature` file (keep it
   readable; this is the source of truth for *intent*).
2. Add a Playwright test mapping to it. Reference the feature scenario in a
   comment so future-you can follow the trail.
3. If a new `.feature` file appears, add a new spec file + register it in
   the table above.
