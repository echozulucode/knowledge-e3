# Knowledge E3

> An **OKF-native, git-backed, MCP-native** knowledge platform — Markdown-first, self-hostable, and portable by design.

Knowledge E3 is a wiki/knowledge base where your content is **plain Markdown you own**. It
speaks the [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog)
so knowledge can be imported, exported, and exchanged as a directory of Markdown files with YAML
frontmatter — and it can keep that corpus mirrored in **git as the source of record**, with the
database as a derived, rebuildable index. An **MCP server** exposes the whole corpus to agents.

This is the **open-core edition** (Apache-2.0). It is meant to be genuinely useful on its own:
self-host it with Docker or Node, author and search your knowledge, and import/export OKF bundles
with no lock-in.

## Highlights

- **Markdown-first, byte-stable codec** — content round-trips to Markdown without drift.
- **OKF import/export** — bring your knowledge in, take it out, as a standard OKF bundle
  (CLI, HTTP, MCP, and web folder-upload).
- **Git-of-record** — the corpus is continuously mirrored to git as a valid OKF bundle; the
  index can be dropped and **rebuilt from git**, including version history from commits.
- **Wiki-links + backlinks** — `[[Target]]` links, atomic rename with link rewriting, backlink index.
- **Full-text search** — SQLite FTS with recency weighting.
- **MCP server** — `search`, `get_item`, `create_item`, `list_spaces`, `list_taxonomy`, OKF
  import/export tools — the entire AI surface, no in-product LLM required.
- **Taxonomy** — spaces/topics, tags, categories, groups, and first-class content types (sections).
- **Self-host ready** — single NestJS server + React/Vite client, SQLite storage, Docker image,
  structured logging, backup + restore-drill scripts.

## Quick start

**Prerequisites:** Node 20+, pnpm 9+.

```bash
pnpm install
pnpm -r build          # build the workspace packages the server/web consume

# REQUIRED on first run: create the SQLite database, the admin user, and sample content.
# Until you seed, there is no account to log in with.
pnpm --filter @echozedlabs/server seed
```

Seeding creates an admin account — username **`admin`**, password **`admin-dev-password`** — plus
sample content to browse. Now start the app in two terminals:

```bash
# Terminal 1 — API on :3000
pnpm --filter @echozedlabs/server dev

# Terminal 2 — web on :5173 (proxies /api/v1 → :3000)
pnpm --filter @echozedlabs/web dev
```

Open http://localhost:5173 and sign in with the credentials above. Storage defaults to SQLite at
`./data/` — no external database required.

> **Tip:** setting `KNOWLEDGE_E3_AUTH_MODE=disabled` makes every request the local admin (no
> login, and MCP needs no cookie) — handy for a first look or a demo.

### Try the OKF bridge

A ready-made, valid OKF bundle ships at [`examples/okf-demo/`](./examples/okf-demo) (linked
concepts + a root `index.md`). Import it from **Admin → Data → Bundle folder** in the web UI (or
via the server's `import:okf` script), then search it and export it back out as an OKF bundle.

### Docker

A multi-stage `Dockerfile` and `docker-compose.yml` are included for containerized runs
(`docker-compose up --build`; the app listens on `:3000`).

## Architecture

Modular monolith: one **NestJS** HTTP server + one **React/Vite** web client in a single pnpm
workspace. Markdown is parsed via `gray-matter` (frontmatter) + `remark` (body) and serialized
back byte-stably by the `@echozedlabs/codec` package. `@echozedlabs/okf` builds/parses/validates
OKF bundles and translates links. Wiki-links are AST-aware and rewritten atomically with explicit
user consent. Search is SQLite **FTS5** with recency weighting. Auth is cookie-based sessions with
scrypt hashing. The **git-of-record** mirror commits the corpus as an OKF bundle out of the
request path; the index is fully **rebuildable from git**. The rich Markdown editor is the
reusable, separately published [`@echozedlabs/*` editor packages](https://www.npmjs.com/org/echozedlabs).

## Repository layout

```
packages/
  codec/    # @echozedlabs/codec — Markdown ↔ AST round-trip codec (byte-stable)
  okf/      # @echozedlabs/okf   — OKF build/parse/validate + link translation
server/     # @echozedlabs/server — NestJS: auth, pages, wiki, search, taxonomy,
            #                       OKF import/export, git mirror, MCP server, audit
web/        # @echozedlabs/web    — React + Vite client (editor, viewer, admin)
features/   # Gherkin feature specs
examples/   # Sample OKF bundle(s)
scripts/    # backup.sh, restore-drill.sh
docs/       # API reference, testing strategy, sample-data guide
deploy      # Dockerfile, docker-compose.yml
```

## Testing

```bash
pnpm test           # all workspace tests
pnpm test:codec     # codec round-trip gate
pnpm test:server    # server e2e
pnpm typecheck      # type-check all packages
```

See [`docs/testing-strategy.md`](./docs/testing-strategy.md) for the approach.

## Documentation

- [`docs/api-reference.md`](./docs/api-reference.md) — HTTP API
- [`docs/sample-data.md`](./docs/sample-data.md) — seeding sample content
- [`docs/testing-strategy.md`](./docs/testing-strategy.md) — testing approach

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution, including the note on OKF
(a third-party specification published by Google; this project's use does not imply endorsement or
affiliation).

Knowledge E3 implements the Open Knowledge Format but is an independent project by EchoZed Labs.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
