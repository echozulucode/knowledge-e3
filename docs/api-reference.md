# Knowledge E3 API — v1 Reference

> The canonical API surface. Versioned at `/api/v1/`. JSON. Auth via signed session cookie (`kp_session`).

## Conventions

- **Auth**: Cookie-based session via `POST /auth/login`. Subsequent requests must carry the `kp_session` cookie. The session cookie is HttpOnly, SameSite=Lax, Secure in production. Sessions last 30 days with sliding-window refresh on activity.
- **Error shape**: NestJS-standard `{ statusCode, message, error }`.
- **Optimistic concurrency**: Page mutations require an `If-Match` header carrying the page's `version_token` (an integer). Mismatch returns 409 with the current version's `version_token` in the response.
- **Soft delete**: `DELETE /pages/:id` is a soft delete. 30-day recovery via `POST /pages/:id/restore`. Hard purge is admin-only and out of v0.1 scope.

---

## Authentication Endpoints

### POST /auth/login

**Auth**: Public (no session required).

**Request body**:
```json
{
  "username": "string",
  "password": "string"
}
```

**Response**: 200 OK. Sets `kp_session` cookie.
```json
{
  "user": {
    "id": "uuid",
    "username": "string",
    "email": "string",
    "role": "user" | "admin"
  }
}
```

**Errors**:
- 401 Unauthorized if username not found or password mismatch.

---

### POST /auth/logout

**Auth**: Required (session cookie).

**Request body**: Empty.

**Response**: 204 No Content. Clears `kp_session` cookie.

---

### GET /me

**Auth**: Required (session cookie).

**Response**: 200 OK.
```json
{
  "user": {
    "id": "uuid",
    "username": "string",
    "email": "string",
    "role": "user" | "admin"
  }
}
```

**Errors**:
- 401 Unauthorized if not authenticated.

---

### POST /me/password

**Auth**: Required (session cookie).

**Request body**:
```json
{
  "old_password": "string",
  "new_password": "string (min 8 chars)"
}
```

**Response**: 204 No Content.

**Errors**:
- 401 Unauthorized if old password is incorrect.
- 400 Bad Request if new password fails validation.

---

## User Administration Endpoints

### POST /admin/users

**Auth**: Required, admin role only.

**Request body**:
```json
{
  "email": "valid-email@example.com",
  "username": "string (min 2 chars)",
  "password": "string (min 8 chars)",
  "role": "user" | "admin" (optional, defaults to "user")
}
```

**Response**: 201 Created.
```json
{
  "user": {
    "id": "uuid",
    "username": "string",
    "email": "string",
    "role": "user" | "admin"
  }
}
```

**Errors**:
- 409 Conflict if email or username already exists.
- 403 Forbidden if not admin.

---

## Pages Endpoints

### POST /pages

**Auth**: Required (session cookie).

**Request body**:
```json
{
  "title": "string (required, max 500 chars)",
  "body": "string (required, markdown body text)",
  "status": "draft" | "published" (optional, defaults to "draft"),
  "frontmatter": {
    "tags": ["tag1", "tag2"],
    "owner": "username (optional)"
  } (optional, user-facing fields),
  "tags": ["tag1", "tag2"] (optional, array of tag strings)
}
```

**Response**: 201 Created.
```json
{
  "page": {
    "id": "uuid",
    "slug": "derived-from-title",
    "title": "string",
    "status": "draft" | "published",
    "owner_id": "uuid | null",
    "created_at": "ISO 8601 timestamp",
    "updated_at": "ISO 8601 timestamp",
    "version_token": integer,
    "current_version_id": "uuid",
    "body_markdown": "string",
    "raw_markdown": "string (full markdown with frontmatter)",
    "frontmatter": {
      "title": "string",
      "status": "draft" | "published",
      "tags": ["string"],
      "owner": "string | null",
      "created_at": "ISO date",
      "updated_at": "ISO date",
      "authors": ["username"],
      "slug": "string"
    },
    "tags": ["string"]
  },
  "version_token": integer
}
```

**Errors**:
- 400 Bad Request if title is empty or exceeds 500 chars.

---

### GET /pages

**Auth**: Required (session cookie).

**Query parameters**:
- `status`: `draft` | `published` (optional, filters by status; drafts excluded by default for non-admins)
- `tag`: `string` (optional, filters to pages tagged with this tag)
- `since`: ISO 8601 timestamp (optional, returns pages updated on or after this time)
- `limit`: integer (optional, defaults to 50, max 100)

**Response**: 200 OK.
```json
{
  "items": [
    {
      "id": "uuid",
      "slug": "string",
      "title": "string",
      "status": "draft" | "published",
      "owner_id": "uuid | null",
      "created_at": "ISO 8601 timestamp",
      "updated_at": "ISO 8601 timestamp",
      "version_token": integer,
      "current_version_id": "uuid",
      "body_markdown": "string",
      "raw_markdown": "string",
      "frontmatter": { /* as above */ },
      "tags": ["string"]
    }
  ],
  "total": integer (count of items returned, not full count)
}
```

---

### GET /pages/:id

**Auth**: Required (session cookie).

**Path parameters**:
- `id`: Page UUID.

**Response**: 200 OK. Sets `ETag` header to the page's current `version_token`.
```json
{
  "page": { /* full PageView object as above */ },
  "version_token": integer
}
```

**Errors**:
- 404 Not Found if page does not exist or is deleted.

---

### GET /pages/by-title/:title

**Auth**: Required (session cookie).

**Path parameters**:
- `title`: Exact page title (case-sensitive).

**Response**: 200 OK.
```json
{
  "page": { /* full PageView object */ }
}
```

**Errors**:
- 404 Not Found if no page with this title exists (or it is deleted).

This endpoint is used for wiki-link resolution.

---

### PUT /pages/:id

**Auth**: Required (session cookie).

**Headers**:
- `If-Match`: The page's current `version_token` (integer, required). Mismatch triggers 409.

**Request body** (all fields optional; partial update):
```json
{
  "body": "string",
  "raw": "string (takes precedence over body + frontmatter if provided)",
  "title": "string (updates frontmatter.title; max 500 chars)",
  "status": "draft" | "published",
  "frontmatter": { "tags": [], "owner": "string" },
  "tags": ["string"]
}
```

**Response**: 200 OK.
```json
{
  "page": { /* updated PageView object */ },
  "version_token": integer (new version_token)
}
```

**Errors**:
- 400 Bad Request if title is empty or exceeds 500 chars.
- 409 Conflict if `If-Match` does not match the current `version_token`. Response includes current version in 409 body.
- 404 Not Found if page does not exist.

---

### DELETE /pages/:id

**Auth**: Required (session cookie).

**Response**: 204 No Content.

This is a soft delete. The page can be restored within 30 days via `POST /pages/:id/restore`.

---

### POST /pages/:id/restore

**Auth**: Required (session cookie).

**Request body**: Empty.

**Response**: 200 OK.
```json
{
  "page": { /* restored PageView object */ }
}
```

**Errors**:
- 404 Not Found if page does not exist or was deleted more than 30 days ago.

---

### POST /pages/:id/rename

**Auth**: Required (session cookie).

**Headers**:
- `If-Match`: The page's current `version_token` (required).

**Request body**:
```json
{
  "new_title": "string (max 500 chars)",
  "link_action": "update_all" | "skip",
  "expected_affected_versions": {
    "page_id_1": version_token_1,
    "page_id_2": version_token_2
    /* optional: version tokens for all pages expected to be updated */
  } (optional)
}
```

**Response**: 200 OK.
```json
{
  "page": { /* the renamed page */ },
  "affected_pages": [
    {
      "id": "uuid",
      "slug": "string",
      "title": "string"
    }
  ]
}
```

**Details**:
- `link_action: "update_all"` rewrites all inbound wiki-links (references to the old title) in a single atomic transaction.
- `link_action: "skip"` renames only the source page; inbound links become broken.
- If any of the affected pages has changed since the client last read them (version mismatch), the entire transaction rolls back and a 409 is returned.

**Errors**:
- 409 Conflict if `If-Match` does not match or if any affected page's version changed.
- 400 Bad Request if title is empty or exceeds 500 chars.

---

### GET /pages/:id/versions

**Auth**: Required (session cookie).

**Response**: 200 OK.
```json
{
  "versions": [
    {
      "id": "uuid",
      "page_id": "uuid",
      "created_at": "ISO 8601 timestamp",
      "created_by": "uuid",
      "parent_version_id": "uuid | null",
      "body_markdown": "string",
      "raw_markdown": "string",
      "frontmatter_json": "JSON string",
      "parsed_ast_json": "JSON string"
    }
  ]
}
```

Versions are ordered newest-first.

---

### GET /pages/:id/versions/:vid

**Auth**: Required (session cookie).

**Path parameters**:
- `id`: Page UUID.
- `vid`: Version UUID.

**Response**: 200 OK.
```json
{
  "version": {
    "id": "uuid",
    "page_id": "uuid",
    "created_at": "ISO 8601 timestamp",
    "created_by": "uuid",
    "parent_version_id": "uuid | null",
    "body_markdown": "string",
    "raw_markdown": "string",
    "frontmatter_json": "JSON string",
    "parsed_ast_json": "JSON string"
  }
}
```

---

### GET /pages/:id/backlinks

**Auth**: Required (session cookie).

**Response**: 200 OK.
```json
{
  "backlinks": [
    {
      "source_page": {
        "id": "uuid",
        "title": "string",
        "slug": "string"
      },
      "snippet": "brief context around the wiki-link"
    }
  ]
}
```

**Errors**:
- 404 Not Found if page does not exist.

---

## Search Endpoints

### GET /search

**Auth**: Required (session cookie).

**Query parameters**:
- `q`: Search query string (optional; if omitted, returns a sorted list of all published pages).
- `space`: Filter results by space/topic id, slug, or display name (optional).
- `tag`: Filter results to pages tagged with this tag (optional).
- `category`: Filter results to pages in this category (optional).
- `group`: Filter results to pages in this group id, slug, or display name (optional).
- `status`: `draft` | `published` (optional; `draft` only returns drafts when the caller is an admin).
- `since`: ISO 8601 timestamp (optional, filters to pages updated on or after).
- `sort`: `relevance` | `newest` | `oldest` | `az` (optional, defaults to `relevance`).
- `include_drafts`: `true` | `1` (optional; only honored for admin users; non-admins always see published only).
- `limit`: integer (optional, defaults to 25, clamped to 1–100).

**Response**: 200 OK.
```json
{
  "results": [
    {
      "id": "uuid",
      "slug": "string",
      "title": "string",
      "updated_at": "ISO 8601 timestamp",
      "status": "draft" | "published",
      "score": number (search relevance score; 0 for non-relevance sorts),
      "snippet": "optional snippet around query match"
    }
  ]
}
```

**Ranking**:
- When `sort=relevance` and a query is present: `score = fts_rank * (1 + exp(-days_since_update / 365))`. Recency and full-text rank are both factors.
- When sort is `newest`, `oldest`, or `az`: score is 0; results are ordered by `updated_at DESC`, `updated_at ASC`, or `title` respectively.

---

## MCP Endpoints

### POST /mcp/jsonrpc

**Auth**: Required (session cookie).

JSON-RPC 2.0-style endpoint for MCP clients. Supported methods are `tools/list` and `tools/call`. Successful JSON-RPC calls return HTTP 200, including tool calls that produce an MCP-level error object.

**Request body (`tools/list`)**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Response**: 200 OK.
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "knowledge.list_spaces",
        "title": "List knowledge spaces/topics",
        "description": "List active knowledge spaces/topics with stable ids, slugs, display names, optional visual metadata, and item counts...",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
      }
    ]
  }
}
```

**Request body (`tools/call`)**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "knowledge.search",
    "arguments": {
      "q": "runbook",
      "space": "research-lab",
      "tag": "ai",
      "category": "architecture",
      "group": "roadmap",
      "status": "published",
      "limit": 10
    }
  }
}
```

**Tools**:

- `knowledge.list_spaces`: Lists active spaces/topics. Output shape:
  ```json
  {
    "spaces": [
      {
        "id": "space_research-lab",
        "slug": "research-lab",
        "name": "Research Lab",
        "description": null,
        "color": null,
        "icon": null,
        "counts": { "items": 2, "published": 1, "draft": 1 }
      }
    ],
    "total": 1
  }
  ```
- `knowledge.list_taxonomy`: Lists filterable taxonomy values. Tags and categories have global scope; groups include their stable group id and space scope metadata. Output shape:
  ```json
  {
    "tags": [
      { "id": "tag_ai", "slug": "ai", "name": "ai", "count": 2, "scope": { "type": "global", "space_id": null, "space_slug": null } }
    ],
    "categories": [
      { "id": "category_architecture", "slug": "architecture", "name": "architecture", "count": 1, "scope": { "type": "global", "space_id": null, "space_slug": null } }
    ],
    "groups": [
      { "id": "group_roadmap", "slug": "roadmap", "name": "roadmap", "count": 2, "scope": { "type": "space", "space_id": "space_default", "space_slug": "default" } }
    ]
  }
  ```
- `knowledge.search`: Searches knowledge items through the same shared search service used by `GET /search`, so filters have REST parity. Input arguments: `q`, `space`, `tag`, `category`, `group`, `status`, `sort`, `include_drafts`, and `limit`. Results include stable item ids, status, optional snippet, and enriched taxonomy context (`space`, `tags`, `categories`, `groups`).
- `knowledge.create_item`: Creates a validated draft item for agent/MCP capture and returns diagnostics for safe retry behavior. Input accepts `title`, `body`, `raw` or `raw_markdown`, `space`, `status` (`draft` by default), `tags`, `categories`, `groups`, `frontmatter` object, optional `client` context object (`name`, `version`, `session_id` strings), optional `client_request_id`, and optional `source_fingerprint`. The tool rejects invalid Markdown/body/taxonomy field shapes, invalid status, malformed `frontmatter`/`client` objects, and duplicate titles in the same topic/space before writing. If the same `client_request_id` or source fingerprint is replayed in the same effective space, the existing MCP-created item is returned instead of creating a duplicate. Output shape:
  ```json
  {
    "id": "uuid",
    "title": "MCP Draft Runbook",
    "slug": "mcp-draft-runbook",
    "path": "/items/uuid",
    "url": "/p/mcp-draft-runbook",
    "version_token": 1,
    "indexing_status": "indexed",
    "warnings": [],
    "duplicate_title": {
      "checked": true,
      "duplicate": false,
      "scope": "agent-inbox",
      "matches": []
    },
    "idempotency": {
      "replayed": false,
      "key": "client_request_id:req-visible-1"
    },
    "item": {
      "id": "uuid",
      "slug": "mcp-draft-runbook",
      "title": "MCP Draft Runbook",
      "status": "draft",
      "version_token": 1,
      "frontmatter": {
        "space": "Agent Inbox",
        "source": {
          "type": "mcp",
          "tool": "create_item",
          "client": { "name": "agent-client", "version": "0.1.0" },
          "client_request_id": "req-visible-1",
          "fingerprint": "sha256-or-client-supplied-fingerprint"
        }
      }
    }
  }
  ```

---

## Telemetry Endpoints

### POST /events/page-view

**Auth**: Required (session cookie).

**Request body**:
```json
{
  "page_id": "uuid (required)",
  "dwell_ms": integer (optional, milliseconds spent on page)
}
```

**Response**: 204 No Content.

This endpoint logs page views to the `page_views` table for engagement analytics in v0.3+. Client should call this when a page becomes visible (visibility-change), and optionally log dwell time when visibility changes to hidden.

---

## Bug Report Endpoint

### POST /bug-report

**Auth**: Public (no session required), but captures authenticated user ID if logged in.

**Request body**:
```json
{
  "body": "string (required, max 20,000 chars, user's bug description)",
  "context": {
    "browser": "string",
    "url": "string",
    "lastActions": ["action1", "action2"],
    /* arbitrary context object captured from client */
  } (required, JSON object),
  "page_id": "uuid (optional, current page if applicable)"
}
```

**Response**: 201 Created.
```json
{
  "id": "uuid"
}
```

All bug reports are stored in the `bug_reports` table and trigger an email to the builder.

---

## Health Endpoints

### GET /healthz

**Auth**: Public (no session required).

**Response**: 200 OK.
```
ok
```

Simple liveness check. Returns a plain-text string, not JSON. Convention: plain-text response keeps these probes cheap and Kubernetes-friendly.

---

### GET /readyz

**Auth**: Public (no session required).

**Response**: 200 OK (if database is reachable) or 503 Service Unavailable (if not).
```
ok
```

Readiness check. Verifies that the application can reach SQL Server. Returns a plain-text string, not JSON. Convention: plain-text response keeps these probes cheap and Kubernetes-friendly.

---

## Data Models

### AuthedUser

```typescript
interface AuthedUser {
  id: string;           // UUID
  username: string;
  email: string;
  role: 'user' | 'admin';
}
```

Returned by `/auth/login`, `/me`, and `/admin/users` endpoints.

---

### PageView

The canonical page object returned by page CRUD endpoints.

```typescript
interface PageView {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  owner_id: string | null;
  created_at: string;           // ISO 8601 timestamp
  updated_at: string;           // ISO 8601 timestamp
  version_token: number;        // Integer; used in If-Match headers
  current_version_id: string | null;
  body_markdown: string;        // Parsed markdown body (no frontmatter)
  raw_markdown: string;         // Full markdown with frontmatter header
  frontmatter: {
    title: string;
    status: 'draft' | 'published';
    tags?: string[];
    owner?: string | null;
    created_at: string;         // ISO date (auto-maintained)
    updated_at: string;         // ISO date (auto-maintained)
    authors: string[];          // Accumulated from edit history (auto-maintained)
    slug: string;               // Derived from title, immutable in v0.1 (auto-maintained)
    [key: string]: unknown;     // Unknown keys preserved on round-trip
  };
  tags: string[];
}
```

---

### PageVersion

Returned by version listing and retrieval endpoints.

```typescript
interface PageVersion {
  id: string;
  page_id: string;
  created_at: string;           // ISO 8601 timestamp
  created_by: string;           // User UUID
  parent_version_id: string | null;
  body_markdown: string;
  raw_markdown: string;
  frontmatter_json: string;     // JSON-serialized frontmatter object
  parsed_ast_json: string;      // JSON-serialized AST
}
```

---

### SearchHit

Returned by the search endpoint.

```typescript
interface SearchHit {
  id: string;
  slug: string;
  title: string;
  updated_at: string;           // ISO 8601 timestamp
  status: 'draft' | 'published';
  score: number;                // Search relevance score (0 if sort is not relevance)
  snippet?: string;             // Optional context snippet around the query match
}
```

---

### Backlink

Returned by the backlinks endpoint.

```typescript
interface Backlink {
  source_page: {
    id: string;
    title: string;
    slug: string;
  };
  snippet: string;              // Brief context around the wiki-link
}
```

---

## Frontmatter Schema (v0.1)

All pages have frontmatter in YAML at the top of the raw markdown:

```yaml
title: "Required string, free text, 1–500 characters."
status: draft  # Required. Enum: draft | published.
tags: [optional, array, of, strings]
owner: alice   # Optional. User ID or username; auto-filled with creator if omitted.

# Auto-maintained by the system; not user-editable:
created_at: 2026-04-12     # ISO date, set on create
updated_at: 2026-04-25     # ISO date, set on every save
authors: [alice, bob]      # Accumulated from edit history
slug: my-page-title        # Derived from title at creation; immutable in v0.1
```

**Validation rules in v0.1**:
- `title` is required, non-empty, max 500 characters.
- `status` must be `draft` or `published`.
- All other user-facing fields are optional.
- Unknown YAML keys are preserved on round-trip (neither warned about nor stripped). This protects forward compatibility.

**Editor editing rules**:
- The structured form in the editor surfaces only: `title`, `status`, `tags`, `owner`.
- The raw YAML toggle exposes everything, including read-only auto-maintained fields (greyed out).
- Author cannot edit `created_at`, `updated_at`, `authors`, `slug` — the editor rejects such edits in raw YAML mode with a clear error.

---

## OpenAPI / Swagger

OpenAPI documentation is generated from `@nestjs/swagger` decorators and served at `/api/docs`.

