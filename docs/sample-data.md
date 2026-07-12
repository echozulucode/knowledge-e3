# Sample data: load lots of topics & categories for testing

Three scripts (run from anywhere with `pnpm --filter @echozedlabs/server …`) let you generate a large, deterministic dataset and load it into the database:

| Script | What it does |
|---|---|
| `data:generate` | Writes a dataset file (`server/data/sample-dataset.json`) — topics, categories, groups, items. No DB touched. |
| `data:reset` | **Empties all content + taxonomy** (pages, topics, categories, groups, tags, links, audit…). Keeps your **admin/user accounts** and the built-in **Default** topic. |
| `data:import` | Imports the dataset file (append). Add `--reset` to empty first. |
| `data:load` | Convenience = **reset + import** in one. |

## Simple steps — empty everything, then import

> Stop the dev server first (so it isn't writing to the DB at the same time), then:

```powershell
# 1. (optional) create the dataset file — defaults to 60 topics, 50 categories, 40 groups, 750 items
pnpm --filter @echozedlabs/server data:generate

# 2. empty everything, then import the dataset (one command)
pnpm --filter @echozedlabs/server data:load
```

That's it. Restart the dev server and sign in as usual (`admin` / `admin-dev-password`) — the topics and categories are populated.

If you prefer the two steps separately:

```powershell
pnpm --filter @echozedlabs/server data:reset     # empty
pnpm --filter @echozedlabs/server data:import     # load (auto-generates a default dataset if the file is missing)
```

## Choosing the size

Set env vars when generating (deterministic, so re-running is repeatable):

```powershell
$env:SAMPLE_TOPICS=120; $env:SAMPLE_CATEGORIES=80; $env:SAMPLE_GROUPS=60; $env:SAMPLE_ITEMS=2000
pnpm --filter @echozedlabs/server data:generate
pnpm --filter @echozedlabs/server data:load
```

| Env var | Default |
|---|---|
| `SAMPLE_TOPICS` | 60 |
| `SAMPLE_CATEGORIES` | 50 |
| `SAMPLE_GROUPS` | 40 |
| `SAMPLE_ITEMS` | 750 |
| `SAMPLE_SEED` | 42 |

## Which database?

The scripts use the same default as the server: `DB_URL=./data/kp.sqlite` (i.e. `server/data/kp.sqlite`). If you run the server with a **different** `DB_URL`, pass the same one to these commands so they write to the database the app reads:

```powershell
$env:DB_URL="./data/kp.sqlite"
pnpm --filter @echozedlabs/server data:load
```

Custom dataset path: pass it as the first argument, e.g. `pnpm --filter @echozedlabs/server data:import ./data/my-dataset.json --reset`.

## Notes

- **Reset keeps users** — you stay signed in as the same admin.
- Items carry `topic`, `categories`, `groups`, and `tags` in frontmatter, so topic/category counts, filters, and search are all populated (just like app-created content). Generated groups are global.
- Generated data is fully deterministic for a given size + seed, so test runs are repeatable.
- `server/data/` is gitignored, so the dataset file and DB are never committed.
