# @echozedlabs/knowledge-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that runs on your machine over
stdio and lets an AI agent search and read knowledge from sources you choose:

- **folders** of Markdown (plain notes, or an OKF bundle with `concepts/`),
- **git working trees** (read like a folder; optionally fast-forwarded once at start),
- **Knowledge E3 servers** (over the REST API, with a personal access token).

It offers the same tool names and arguments as the Knowledge E3 server's own MCP endpoint, so an agent that knows one
knows the other.

**Read-only.** No tool creates, updates, publishes, imports or exports anything. Nothing is written to your folders.
The only git operation that changes anything is the optional fast-forward at start (see below); there is no commit,
push, checkout, reset or stash. Requests to a server are GET only.

**Keyword search only.** Whole words, quoted phrases, the word you are still typing as a prefix, and `key:value`
filters — the same query language as the Knowledge E3 search box. No stemming and no approximate matching.

## Run it

Requires Node.js 20 or later.

```sh
# zero config: serve one or more folders
npx -y @echozedlabs/knowledge-mcp --folder ~/notes --folder ~/src/handbook

# with a config file
npx -y @echozedlabs/knowledge-mcp --config ~/knowledge-mcp.yaml
```

`KNOWLEDGE_MCP_CONFIG` may name the config file instead of `--config`. `--folder` sources are added to a config's.

## Configure

```yaml
# knowledge-mcp.yaml — relative paths are relative to this file
sources:
  - id: notes
    type: folder
    path: ./notes
    topic: Notes            # optional: topic for files that name none
    default_status: published  # optional: status for files that declare none (default published)
    include: ['**/*.md']    # optional globs; default: the OKF concepts/ layout if present, else every *.md
    exclude: ['drafts/**']

  - id: handbook
    type: git
    path: ~/src/handbook
    pull: on-start          # or manual (the default): never contact the remote

  - id: intranet
    type: server
    url: https://kb.example.com        # the API root /api/v1 is added when missing
    token_env: KNOWLEDGE_E3_TOKEN      # the NAME of the environment variable holding the token
    topics: [ops, platform]            # optional: only these topics
    timeout_ms: 15000                  # optional
```

Source ids prefix item references (`notes:pump-restart`), so they are letters, digits, `-` and `_`.

### The token rule

A personal access token is **never** put in the config file — a `token` (or `secret`, `password`) key there is an
error, reported without its value. Put the token in an environment variable and name that variable with
`token_env`. The token is sent only as `Authorization: Bearer …` to the configured server (redirects are refused),
and never appears in tool output, errors or logs — not even its length. `knowledge.list_sources` shows only the
variable's name and whether it is set. The server still enforces the token's scope and topic visibility; use a
`read` token.

### Git sources

The working tree is read exactly like a folder; `.git` is never read. With `pull: on-start`, one
`git merge --ff-only` to the branch's upstream runs at startup, and only when the configured path is the repository
top level, the branch has an upstream, and no tracked file has local changes. Hooks are disabled and credential
prompts are off. Anything else skips the pull with a warning and serves the tree as it is. `knowledge.refresh`
re-reads files but never pulls.

## Use it from a client

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "npx",
      "args": ["-y", "@echozedlabs/knowledge-mcp", "--config", "/Users/me/knowledge-mcp.yaml"],
      "env": { "KNOWLEDGE_E3_TOKEN": "paste-your-read-token-here" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add knowledge --env KNOWLEDGE_E3_TOKEN=$KNOWLEDGE_E3_TOKEN -- npx -y @echozedlabs/knowledge-mcp --config ~/knowledge-mcp.yaml
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "knowledge": { "command": "npx", "args": ["-y", "@echozedlabs/knowledge-mcp", "--folder", "./docs"] }
  }
}
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "@echozedlabs/knowledge-mcp", ...]` if the client
cannot start `npx` directly.

## Tools

| Tool | What it does |
| --- | --- |
| `knowledge.search` | Keyword search. Results are grouped **per source** in `sources[]`, each group in that source's own rank order with its own `total`; scores from different sources are never merged into one ranking. Each hit has `source` and `ref`. Optional `source` searches one source. |
| `knowledge.get_item` | One item by `id` (a `<source>:<id-or-slug>` ref from search), `slug` or `title`. A plain ref that matches items in several sources is refused as ambiguous, with the candidate refs. |
| `knowledge.list_spaces` | Topics, each labelled with its `source`. |
| `knowledge.list_taxonomy` | Tags, categories and groups, each labelled with its `source`. |
| `knowledge.list_content_types` | The content-type registry (same as the server's). |
| `knowledge.validate_item` | Lint a draft (nothing is written), against a source's vocabulary or the local sources' combined one. |
| `knowledge.validate_okf_bundle` | Three-tier OKF bundle report (nothing is written). |
| `knowledge.list_sources` | What is configured, item counts, pull outcome, token presence (never the token). |
| `knowledge.refresh` | Re-read local folders and git working trees from disk. |

Query syntax: `tag:`, `category:`, `group:`, `type:`, `topic:`, `author:`, `updated:` (`>2026-01-01`, `2026-08`,
`30d`), `is:` (`verified`, `needs-review`, `draft`, …), `status:`, `-term`, `-key:value`, `"exact phrase"`.
Drafts are returned only when asked for (`include_drafts`, `status: draft`, `status:draft` or `is:draft`).

## What gets read

Only the configured directories. Symbolic links and junctions inside them are not followed, every file is checked
by real path to lie inside its root, and dot-directories (`.git`, `.e3`, editor state), `assets/` and
`node_modules/` are skipped. Files over 5 MB are skipped. Item references are looked up in the index; a tool
argument is never used as a file path.

Files map to items the way the Knowledge E3 server maps them: OKF frontmatter (`e3_id`, `title`, `type`, `tags`,
`categories`, `groups`, `topic`, `status`, `verified`, `stale_after`, …), a title from the first `# heading` or the
file name for plain notes, the topic from frontmatter, a `<topic>/concepts/` subtree or the source's `topic`, and
`index.md` as topic presentation rather than an item. A file without an id gets its path (without `.md`) as id.

## Troubleshooting

- **Logs are on stderr.** stdout carries only MCP messages. Most clients show the server's stderr in their MCP log
  (Claude Desktop: `~/Library/Logs/Claude/mcp-server-knowledge.log` on macOS, `%APPDATA%\Claude\logs` on Windows).
  Set `KNOWLEDGE_MCP_LOG_LEVEL=debug` for more.
- **Config errors** print every problem and exit with code 2. Run `knowledge-mcp --help`.
- **`Source "intranet" refused the search request: not authenticated`** — the variable named by `token_env` is not
  set in the client's environment, or the token was revoked. **`forbidden`** — the token's scope or the topic's
  visibility does not allow it.
- **A git source was not pulled** — `knowledge.list_sources` shows `last_pull` with the reason (local changes,
  diverged branch, no upstream, not the top level).
- **Edited files do not show up** — call `knowledge.refresh`; the index is built at start.

## Develop

```sh
pnpm --filter @echozedlabs/knowledge-mcp build     # tsc, then the esbuild bundle dist/knowledge-mcp.js
pnpm --filter @echozedlabs/knowledge-mcp test      # needs the bundle for the stdio end-to-end test
```

The bundle inlines everything (the private `@echozedlabs/*` workspace packages and the MCP SDK), so the published
package has no runtime dependencies.
