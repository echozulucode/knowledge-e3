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

### GET /me/tokens

> Token management is session-only: requests to `/me/tokens` and `/admin/tokens` that authenticate with a bearer token are refused with 403, so a leaked token cannot mint, list, or revoke tokens.

**Auth**: Required (session cookie or bearer token).

Lists the caller's personal access tokens, newest first, including revoked ones. No part of the token value (raw, hash, or prefix) is ever returned here.

**Response**: 200 OK.
```json
{
  "tokens": [
    {
      "id": "uuid",
      "name": "string",
      "scope": "read" | "write",
      "created_at": "ISO-8601",
      "expires_at": "ISO-8601" | null,
      "last_used_at": "ISO-8601" | null,
      "revoked_at": "ISO-8601" | null
    }
  ],
  "policy": { "max_days": 90 | null }
}
```

---

### POST /me/tokens

**Auth**: Required.

Mints a personal access token. Any user may create either scope; a `write` token carries the caller's own rights, nothing more.

**Request body**:
```json
{
  "name": "string (1–100 chars)",
  "scope": "read" | "write",
  "expires_in_days": 30 | 90 | 365 | null
}
```

**Response**: 201 Created. The token view (see above) plus `"token": "e3_w…"` — the raw token, returned exactly once. Only its SHA-256 hash is stored.

**Errors**:
- 400 Bad Request when `expires_in_days` exceeds the admin maximum, or is `null` while a maximum is set.

**Bearer authentication**: send the raw token as `Authorization: Bearer e3_…` on any endpoint. Token format is `e3_` + scope letter (`r`/`w`) + 40 base62 characters. A session cookie, when present and valid, takes precedence. Rules:
- Invalid, expired, or revoked token → 401.
- `read` tokens may only send GET/HEAD/OPTIONS; any other method → 403 `{ "message": "Token scope is read-only" }`. The MCP endpoints (`POST /mcp`, `POST /mcp/jsonrpc`) are exempt from the method rule and instead hide and refuse `write` tools for `read` tokens.
- `last_used_at` is refreshed at most once per minute.

---

### DELETE /me/tokens/:id

**Auth**: Required.

Revokes one of the caller's tokens. Idempotent.

**Response**: 204 No Content.

**Errors**:
- 404 Not Found if the token does not belong to the caller.

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

### GET /admin/tokens

**Auth**: Required, admin role only (signed-in session; a bearer token is refused with 403).

One page of every user's tokens, newest first, each with `user_id`, `username` and `owner_disabled` (boolean: the owner's account is disabled, so the token cannot authenticate even though it is neither revoked nor expired) alongside the fields of `GET /me/tokens`. No part of any token's secret (value, hash, prefix or length) is returned.

**Query parameters** (all optional):
- `owner` — the owner's username or user id.
- `state` — `active` | `expired` | `revoked` | `owner_disabled` | `all` (default: every state). States follow one precedence: revoked, then expired, then owner disabled, so a token matches exactly one.
- `scope` — `read` | `write`.
- `q` — case-insensitive substring of the token's name (literal; `%` and `_` are not wildcards).
- `limit` — 1–200, default 50 (larger values are clamped to 200). `offset` — default 0.

**Response**: 200 OK.
```json
{ "tokens": [ ... ], "total": 123, "limit": 50, "offset": 0 }
```
`total` counts every token matching the filters. `{ tokens }` is the shape this route always had; `total`, `limit` and `offset` are additive, but the route now returns at most `limit` rows.

**Errors**: 400 for an unknown `state` or `scope`, or a malformed `limit` / `offset`; 401 without a session; 403 for a non-admin.

---

### DELETE /admin/tokens/:id

**Auth**: Required, admin role only.

Revokes any user's token. Idempotent. 204 No Content; 404 if unknown.

Audited as `token.revoke` with payload `{ id, self: false, token_name, owner_username }` (the self-service route records `self: true`). Names only, never any part of the secret.

---

### GET /admin/auth/settings

**Auth**: Required, admin role only.

Every setting on Admin → Authentication with its provenance. Read-only: each setting keeps its own write route (`PUT /admin/access`, `PUT /admin/auth/password-policy`, `PUT /admin/auth/token-policy`); login throttling has none.

**Response**: 200 OK.
```json
{
  "read_access": {
    "read_mode": "public",
    "provenance": { "source": "admin", "updated_at": "2026-09-02T14:03:11.000Z", "updated_by_username": "eric", "env_vars": [] },
    "deploy_default": { "read_mode": "public", "source": "default", "updated_at": null, "updated_by_username": null, "env_vars": [] },
    "editable": true
  },
  "password_policy": { "policy": { "min_length": 8, "require_number": false, "require_symbol": false, "require_uppercase": false }, "provenance": { "source": "default", "updated_at": null, "updated_by_username": null, "env_vars": [] }, "editable": true },
  "token_policy": { "max_days": null, "provenance": { "source": "default", "updated_at": null, "updated_by_username": null, "env_vars": [] }, "editable": true },
  "login_throttle": { "window_ms": 900000, "per_username": 5, "per_ip": 20, "provenance": { "source": "env", "updated_at": null, "updated_by_username": null, "env_vars": ["LOGIN_THROTTLE_PER_IP"] }, "editable": false }
}
```

`provenance.source` is where the effective value came from:
- `admin` — saved through the admin API; `updated_at` and `updated_by_username` say when and by whom (the username is null if the row names no account).
- `env` — an environment variable; `env_vars` lists the variable NAMES in effect (`KNOWLEDGE_E3_DEFAULT_READ_ACCESS`, `LOGIN_THROTTLE_WINDOW`, `LOGIN_THROTTLE_PER_USERNAME`, `LOGIN_THROTTLE_PER_IP`), never their values.
- `config` — the config file (`readAccess.default`, `auth.loginThrottle.*`).
- `default` — the built-in default.

For read access an admin choice overrides the deploy default, which is reported separately in `deploy_default`. Password and token policy have no deploy-time layer (`admin` or `default` only); login throttling has no admin layer (`env`, `config` or `default`).

**Errors**: 401 without a session; 403 for a non-admin.

---

### GET /admin/auth/token-policy

**Auth**: Required, admin role only.

**Response**: 200 OK. `{ "max_days": number | null }` — the longest lifetime a new token may have; `null` means unlimited (tokens may be created with no expiry).

---

### PUT /admin/auth/token-policy

**Auth**: Required, admin role only.

**Request body**: `{ "max_days": 1–3650 | null }`

**Response**: 200 OK. `{ "max_days": number | null }`. Applies to tokens created afterwards; existing tokens keep their expiry.

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
- 422 Unprocessable Entity (`reason: "lint_failed"`, with `diagnostics`) if `status` is `"published"` and the document has error-severity content-model diagnostics (`type`, `description`, a curated primary category). Nothing is written and the refusal is audited as `content.refused`. Save it as a draft instead, fix the diagnostics, then publish with `PUT /pages/:id`.

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
- 422 Unprocessable Entity (`reason: "lint_failed"`) if the update takes a draft to `"published"` and the document has error-severity diagnostics. Saves of an already-published page are never refused. An admin may pass `allow_lint_errors: true` in the body to publish over the diagnostics; it is audited (`content.publish_lint_override`).

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
- `type`: content type label, case-insensitive (optional; repeatable, values OR).
- `author`: author name (optional; repeatable, values OR). Matches frontmatter `authors` (list) or `author` (string), exact after whitespace collapse and Unicode case folding — `author=ada` does not match "Ada Lovelace". Replaces any `author:` in `q`.
- `is`: `verified` | `unverified` | `human-reviewed` | `machine-confirmed` | `needs-review` (alias `stale`) | `draft` | `published` (optional; repeatable, values OR). `unverified` includes items with no recorded tier; `needs-review` means at or past `stale_after`. `is=draft` never widens visibility, and combines with `status` (both must hold). Unknown values are ignored with a warning. Replaces any `is:` in `q`.
- `updated`: one `updated:` value — `>2026-01-01`, `<=2025-06`, `2026`, `2026-08`, or a window `7d` / `4w` / `6m` / `1y` (optional). Dates are UTC calendar periods; compared as instants. Replaces any `updated:` in `q`.
- `status`: `draft` | `published` (optional; `draft` only returns drafts when the caller is an admin).
- `since`: ISO 8601 timestamp (optional, filters to pages updated on or after).
- `sort`: `relevance` | `newest` | `oldest` | `az` | `verified` (optional, defaults to `relevance`). `verified` orders by `last_verified_at` descending, never-verified items last, then `updated_at` descending.
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
      "snippet": "plain-text excerpt around the match (≤ ~180 chars, word boundaries, no Markdown, no ellipsis characters)",
      "snippet_truncated": { "start": boolean, "end": boolean },
      "highlights": { "title": [[start, end]], "snippet": [[start, end]] }
    }
  ],
  "total": number,
  "offset": number,
  "limit": number,
  "facets": { "topics": [], "statuses": [], "tags": [], "types": [], "categories": [], "trust_tiers": [] },
  "warnings": ["string"],
  "groups": [{ "key": "string", "label": "string", "hits": [], "total": number }]
}
```

**Snippets and highlights**: `highlights` ranges are half-open `[start, end)` UTF-16 offsets into the returned `title` and `snippet`; a client wraps them in `<mark>` and never re-matches. Matching is lexical (case- and accent-insensitive, whole tokens; the word still being typed matches as a prefix and the whole word is marked; no stemming). The snippet comes from the body (Markdown reduced to prose first), else the description, else the taxonomy line; when nothing literally matches (a filter-only query, or a match FTS5 found only through stemming) it is the description or the opening of the body, unhighlighted. `snippet_truncated` says at which ends text was cut so the client draws `…`. Hits in `groups` are the same objects as in `results`.

**Query syntax** (`q`): free text plus `tag:` `category:` `group:` `topic:`/`space:` `type:` `status:` `author:` `updated:` `is:`; values OR within a key, keys AND, `-key:value`, `-term` and `-"phrase"` exclude. `updated:` and `status:` take one value; `status:` and `updated:` cannot be negated. Warnings name anything ignored.

**Ranking**:
- When `sort=relevance` and a query is present: `score = fts_rank * (1 + exp(-days_since_update / 365))`. Recency and full-text rank are both factors.
- When sort is `newest`, `oldest`, `az` or `verified`: score is 0; results are ordered by `updated_at DESC`, `updated_at ASC`, `title`, or most recently verified first (unverified last) respectively.

**Related/backlink snippets** (`GET /pages/:id/backlinks`): the readable text of the paragraph around the link, cut on word boundaries around the link's visible text, with `…` at a cut edge — never raw `[[…]]`. An anonymous caller does not see sources in private Topics.

**What free text matches**: the `pages_fts` index holds an item's title, aliases (frontmatter `aliases`), tags, Topic name, primary categories (key and curated label), group names, description and body. Its bm25 column weights are title 10 > aliases 8 > tags 6 > Topic = categories = groups 4 > description 3 > body 1 — defined once in `server/src/search/fts-index.ts`. Renaming a Topic or relabelling a category reindexes the items filed under it in the same transaction.

### GET /search/overview

**Auth**: Public read (same as `GET /search`).

What `/search` shows before anything is typed: the library's shape, counted over the **published** items this viewer may read — the same visibility predicate search applies, so an anonymous caller never sees a private Topic's items, name or tags, and drafts are never counted (not even for an admin).

**Response**: 200 OK, a `SearchOverview` (`@echozedlabs/knowledge-types`).
```json
{
  "total": 42,
  "types": [{ "value": "runbook", "label": "Runbook", "count": 12 }],
  "topics": [{ "value": "platform", "label": "Platform", "count": 20 }],
  "categories": [{ "value": "operations", "label": "operations", "count": 9 }],
  "tags": [{ "value": "kubernetes", "label": "kubernetes", "count": 7 }],
  "recently_verified": [ItemSummary],
  "recently_updated": [ItemSummary]
}
```
- `types`, `topics`, `categories`: every value, most used first. `tags`: the 24 most used.
- `recently_verified`: up to 6 items whose trust tier is `human-reviewed` or `machine-confirmed`, newest `last_verified_at` first.
- `recently_updated`: up to 6 items, newest `updated_at` first.
- Items carry `topic` (slug) and `topic_name` like other list surfaces.

---

## Taxonomy Endpoints

Tags, primary categories and groups. Reads are open to anyone who may read the library (an anonymous caller sees usage counts for published, non-private items only); every write is admin-only (401 without a session, 403 for a non-admin). Every entry has the shape `{ id, name, slug, count, color, icon, scope: { type: "global" | "space", space_id, space_slug } }`; `count` is the number of items carrying the term. Archive is soft: an archived row keeps its slug. None of these writes is recorded in the audit log.

### GET /taxonomy/tags · GET /taxonomy/categories · GET /taxonomy/groups

**Query**: `q` (optional) filters by name or slug. `GET /taxonomy/categories?curated=1` returns only the admin-curated catalog (what may be published into); without it the list is the catalog plus any category items carry. Group entries also carry `description`.

**Response**: 200 OK. `{ "tags" | "categories" | "groups": [ ... ], "total": number }`

---

### POST /taxonomy/categories · PUT /taxonomy/categories/:slug

**Auth**: Required, admin role only.

**Request body**: `{ "name": string, "slug"?: string }` (create) or `{ "name": string }` (rename; the slug never changes).

**Response**: 201 Created / 200 OK. `{ "category": { ... } }`

**Errors**: 400 for a blank name; 409 `primary category slug already exists`, or `an archived primary category already uses this slug; restore it instead`; 404 on rename of an unknown slug.

---

### DELETE /taxonomy/categories/:slug

**Auth**: Required, admin role only.

Archives the category: it can no longer be published into, and items already filed under it keep it. Allowed while items carry it (that is how new publishes into a term are stopped); the admin page offers Archive only for unused categories. **Response**: 200 OK. `{ "category": { ... } }`

**Errors**: 404 if unknown or already archived.

---

### GET /taxonomy/categories/archived

**Auth**: Required, admin role only.

**Response**: 200 OK. `{ "categories": [ { ..., "archived_at": "ISO-8601" } ], "total": number }`, most recently archived first.

---

### POST /taxonomy/categories/:slug/restore

**Auth**: Required, admin role only.

**Request body**: Empty. Un-archives the category under its old name.

**Response**: 200 OK. `{ "category": { ... } }`

**Errors**: 404 for an unknown slug; 409 `primary category is not archived`.

---

### POST /taxonomy/groups

**Auth**: Required, admin role only.

**Request body**: `{ "name": string, "slug"?: string, "description"?: string, "scope"?: "global", "space_id"?: string, "space_slug"?: string }`. Without a topic the group is available in all topics.

**Response**: 201 Created. `{ "group": { ... } }`

**Errors**: 409 `group slug already exists`; 404 for an unknown topic.

---

### PUT /taxonomy/groups/:id

**Auth**: Required, admin role only.

**Request body**: `{ "name"?: string, "description"?: string | null, "scope"?: "global" | "space", "space_id"?: string, "space_slug"?: string }`. The slug and id are fixed. Scope is unchanged unless one of `scope`, `space_id` or `space_slug` is sent; `"scope": "global"` makes the group available in all topics. A rename reindexes the group's items for search in the same transaction.

**Response**: 200 OK. `{ "group": { ..., "description": string | null } }`

**Errors**: 400 for a blank name; 404 for an unknown or archived group, or an unknown topic.

---

### DELETE /taxonomy/groups/:id

**Auth**: Required, admin role only.

Archives the group. **Response**: 200 OK. `{ "group": { ... } }`

**Errors**: 409 `group is in use by N items` while any item is in the group; 404 if unknown or already archived.

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

The read tools (`knowledge.search`, `knowledge.get_item`, `knowledge.list_spaces`, `knowledge.list_taxonomy`,
`knowledge.list_content_types`, `knowledge.validate_item`, `knowledge.validate_okf_bundle`) are declared once in
`packages/mcp-tools` — descriptors, argument normalization and the result/error envelopes — and served by both
this endpoint and the read-only stdio server `@echozedlabs/knowledge-mcp` (`apps/knowledge-mcp`), so an agent sees
the same names and argument shapes against the server and against local folders. The write tools below are
server-only.

- `knowledge.get_item`: Gets one item by stable `id` first, else `slug`, else exact `title`, with the same read gates
  as search: drafts only for their owner or an admin, private-topic items never for an anonymous caller. Output
  `{ item }` with body, raw Markdown, frontmatter, taxonomy and derived lifecycle signals. A miss is an `isError`
  result with `rpc_code` -32004 ("could not find an item").
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

## OKF Data Bridge Endpoints

Whole-library Open Knowledge Format interchange, used by Admin → Data (`/admin/data`). Every route is
**admin-only**: 401 without a session, 403 for a signed-in non-admin.

The import doors and their dry runs share body parsers registered ahead of the global 100 KB cap
(`configureApp` in `server/src/bootstrap.ts`): the JSON routes accept up to **50 MB**, the archive routes
take the raw `.tar.gz` bytes (any `Content-Type`) up to **50 MB**.

### GET /okf/export

Query: `space` (optional topic slug/name), `type` (optional). Response 200:
`{ okf_version, item_count, conformance, files: [{ path, content }] }`. The `files` envelope is exactly
what `POST /okf/import` accepts. Audited as `okf.export`.

### GET /okf/export/archive

Same query. Response 200 `application/gzip` — concepts plus referenced assets and their `.meta.json`
sidecars. Headers `X-OKF-Item-Count`, `X-OKF-Conformant`. Audited as `okf.export`.

### GET /okf/audit

Query: `space`, `type`, `asOf` (`YYYY-MM-DD`), all optional. Read-only health audit of the *current
library*: `{ okf_version, item_count, conformant, conceptCount, conformance, policy, advisories, signals }`.

### POST /okf/import

**Request body**: `{ "files": [{ "path": "concepts/orders.md", "content": "---\ntype: …" }] }`

**Response**: 201 `{ created, updated, ids, defaulted, default_status, unrecognized_status, assets_imported,
assets_failed, validation }` — `validation` is the three-tier report below.

**Errors**: 422 `{ reason: "bundle_not_conformant", message, validation }` when the conformance tier carries
a `critical`; nothing is written. 409 when two concepts resolve to the same identity; nothing is written.
Policy findings never refuse — they come back in `validation.policy` and are recorded for Content health.
Audited as `okf.import` / `okf.import_rejected`.

Each concept is written through the content command path, like any other save: its concept file, then its
item row and outbox row in one transaction, then the git commit. The guarantee is per item, not per bundle:
every identity is resolved before the first write, but a failure the preflight cannot see (a concurrent
edit, a file changed on disk, a read-only source) after some items landed returns the underlying error's
status and body plus `partial_import: { created, updated, ids, failed: { index, title } }`, naming what was
written. `okf.import_rejected` then carries `partial: { created, updated }`. An import that fails before
writing anything returns the underlying error unchanged.

### POST /okf/import/archive

**Request body**: the raw `.tar.gz` bytes. **Response**: 201, as `POST /okf/import`. Gated before the asset
restore. **Errors**: 400 when the body is empty or cannot be decompressed; 422 as above.

### POST /okf/validate

The dry run for `POST /okf/import`: the same body, the same evaluation the import gate makes, and
**nothing written** — no item, no content diagnostic, no file, no commit, no audit row.

**Request body**: `{ "files": [{ "path": "…", "content": "…" }] }` (malformed entries are dropped exactly as
the import drops them).

**Response**: 200 — including for a bundle the import would refuse; `summary.conformant` is the verdict.
```json
{
  "conformance": [{ "path": "concepts/orders.md", "code": "type.missing", "severity": "critical", "message": "…" }],
  "policy": [],
  "advisory": [],
  "summary": {
    "conceptCount": 2, "conformant": false, "meetsPolicy": true,
    "conformanceCount": 1, "policyCount": 0, "advisoryCount": 0,
    "criticalCount": 1, "policyErrorCount": 0
  },
  "summary_line": "Not an OKF bundle: 1 critical conformance issue(s) across 2 concept document(s). …"
}
```

| Tier | Answers | Blocks an import? |
| --- | --- | --- |
| `conformance` | Is this an OKF bundle at all? | Yes — any `critical` |
| `policy` | Does it meet this instance's content rules? | No — imported and recorded for Content health |
| `advisory` | Unresolved links, trust/provenance/freshness notes | No |

Issue fields: `path` (bundle file), `code`, `severity` (`critical` | `error` | `warning` | `info`),
`message`, and optionally `field` (frontmatter key or `body`), `target` (link findings) and `fix`.
Conformance-tier issues carry no `field` today — the OKF conformance checker reports a file and a rule, and
its `message` names the key; `field` is populated on policy issues and on frontmatter link advisories.
`summary_line` is the same prose verdict the MCP `knowledge.validate_okf_bundle` tool returns.

### POST /okf/validate/archive

The dry run for `POST /okf/import/archive`. **Request body**: the raw `.tar.gz` bytes. The archive is
extracted **in memory** with the import's own reader (never to disk) and its concept documents are gated
exactly as the import would gate them.

**Response**: 200, the `POST /okf/validate` shape plus `assets` — the number of binary asset files the import
would try to restore (counted, not validated: the upload policy that decides them runs at write time).

**What will change** (both validate routes): for a conformant bundle the response also carries
`would_create` and `would_update` — how many concepts the import would create and how many would update an
existing item, resolved with the import's own identity match (embedded `e3_id`, else exact title in the
destination topic) and read-only. Both are **omitted** for a bundle the import would refuse, and when the
import could not run at all (two concepts resolving to the same identity — the import's 409). Additive: a
client that ignores them is unaffected.

**Errors**: 400 when the body is empty or cannot be decompressed.

---

## Files (Images and Attachments) Endpoints

Uploaded files are content-addressed (`<sha16>.<ext>`) and served at `/assets/<file>`. Types are resolved from the bytes against an allowlist: PNG, JPG, GIF, WebP (10 MB), SVG (2 MB, download only), PDF and ZIP (25 MB), CSV, JSON and TXT (10 MB); the raw request body is capped at 25 MB.

A file is **used** when an item references it (a body embed or link to `/assets/<file>`, or a `cover` / `cover_image` / `hero_image` frontmatter key — trashed items included) or when the site shows it (the configured logo, dark logo or favicon, or a pinned-topic cover). Only a file used by nothing can be deleted.

### POST /images

**Auth**: Required (any signed-in user). **Query**: `filename` (the download name), `alt`. **Body**: the raw file bytes with its `Content-Type`.

**Response**: 201, the file (the `ImageView` below). Identical bytes return the existing file. **Errors**: 400 with a `message` naming the reason (`unsupported or unrecognized file type`, `content does not match image/png`, `file exceeds the 10 MB limit for image/png`); 413 above the 25 MB body cap.

### GET /admin/images

**Auth**: Required, admin role only (401 without a session, 403 for a non-admin).

The library. With no parameters, every file, largest first — the shape this route always had (the asset picker and the Overview read it).

**Query parameters** (all optional):
- `q` — case-insensitive literal substring of the download name, stored name or alt text.
- `type` — `image` (any `image/*`) | `document` (PDF, CSV, JSON, plain text) | `other` (everything else, e.g. ZIP).
- `usage` — `used` | `unused` (see "used" above; `unused` is exactly the deletable set).
- `sort` — `newest` | `largest` (default) | `name` (download name, else stored name, case-insensitive).
- `limit` — 1–200 (larger values are clamped); absent returns every match. `offset` — default 0.

**Response**: 200 OK.
```json
{
  "images": [
    {
      "id": "uuid",
      "file": "a1b2c3d4e5f6a7b8.png",
      "url": "/assets/a1b2c3d4e5f6a7b8.png",
      "mime": "image/png",
      "byte_size": 48213,
      "alt": "string | null",
      "original_filename": "diagram.png | null",
      "created_at": "ISO-8601",
      "used_by": 2,
      "site_asset": false,
      "orphan": false
    }
  ],
  "total": 312,
  "limit": 50,
  "offset": 0,
  "summary": { "count": 312, "total_bytes": 1503238553, "unused": 23, "reclaimable_bytes": 188743680 }
}
```
`used_by` counts referencing items; `site_asset` is true when the site shows the file; `orphan` is `used_by = 0 and not site_asset`. `total` counts matches of the filters; `summary` describes the whole library regardless of filters; `limit` is `null` when not given. `total`, `limit`, `offset`, `summary` and `site_asset` are additive.

**Errors**: 400 for an unknown `type`, `usage` or `sort`, or a malformed `limit` / `offset`; 401; 403.

### GET /admin/images/:id

**Auth**: Required, admin role only (401 / 403, with no file or item data in the body).

One file for the Files detail sheet: the list fields plus `created_by` (user id), `created_by_username` (null when the account is gone) and `used_by_items` — up to 50 referencing items, live items before trashed ones, then by title: `{ item_id, slug, title, status: "draft" | "published", deleted: boolean, topic: { slug, name, visibility } | null }`. `used_by` remains the full count. Because the route is admin-only and admins read every item, the list is not filtered: drafts, private-topic items and trashed items are all named (each one blocks deletion). A member-facing variant would have to filter by the caller's access.

**Response**: 200 `{ "image": { ... } }`. **Errors**: 401; 403; 404 for an unknown id.

### DELETE /admin/images/:id

**Auth**: Required, admin role only.

Deletes the file's record, its bytes and its descriptor (the removal is committed to the bundle's git history). **Response**: 200 `{ "ok": true }`. **Errors**: 404 for an unknown id; 409 `file is referenced by one or more pages and cannot be deleted` while any item references it; 409 `file is used by the site (logo, favicon or a pinned-topic cover) and cannot be deleted`.

---

## Audit Endpoints

### GET /admin/audit

**Auth**: Required, admin role only (401 without a session, 403 for a non-admin; no audit data in either body). A read-scoped token of an admin may read.

The append-only audit log, newest first. Payloads are redacted when written (any key containing `password`, `token`, `secret`, `authorization` or `cookie` is dropped, except the exact key `token_name`); the endpoint never returns more than what was stored.

**Query** (all optional, combined with AND):
- `actor` — who acted: a user id or a username (case-insensitive). A deleted account's id still matches its rows. A value nobody matches returns an empty page, not everything.
- `subject` — the account or thing acted ON: a user id, a username, or another id. Matches rows whose payload names it under `user_id`, `id`, `source_id` or `space_id` (exact) or `username`, `username_attempted`, `owner_username` (case-insensitive). A value that resolves to an account matches both its id and its username, so older rows that carry only `user_id` are found by username. Never matches the actor. Reads each candidate payload (no index); bounded by retention.
- `action` — an action code, verbatim (`user.role_change`).
- `page_id` — the item a row is about.
- `entry` — one row by its numeric `id` (a shared link to a single entry). Non-numeric → 400.
- `since` — inclusive; `until` — exclusive. Each an ISO instant, or a bare `YYYY-MM-DD` read as UTC midnight (a bare `until` means the start of the NEXT day, so the day itself is included). The web page sends instants built from the viewer's local days. Unparseable → 400.
- `limit` — 1–200, default 50. `cursor` — the previous page's `next_cursor`.

**Response**: 200 OK.
```json
{
  "entries": [
    {
      "id": 42,
      "occurred_at": "2026-09-13T23:02:11.000Z",
      "actor_id": "uuid | null",
      "actor_username": "string | null",
      "action": "config.read_access_change",
      "page_id": "string | null",
      "page_slug": "string | null",
      "page_title": "string | null",
      "version_id": "string | null",
      "payload": { "from": "authenticated", "to": "public" }
    }
  ],
  "next_cursor": "opaque string | null",
  "actions": ["auth.login", "config.read_access_change"],
  "limit": 50
}
```

`actor_id` is null for sign-in failures (`auth.login_failed`, `auth.login_throttled`; the attempted name is `payload.username_attempted`) and for rows the server writes itself (`audit.retention_trim`, `backup.drill_run`). `actor_username` is null when the account no longer exists. `actions` is every action code present in the log, independent of the filters.

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

### GET /admin/health/content

**Auth**: Admin (403 otherwise).

**Query**: `topic` (optional; topic slug or id).

**Response**: 200 — `{ totals, audit, signals, queues, sync, mirror }`. `audit` is the OKF audit's counts
(`conformant`, `conformance`, `policy`, `advisories`; the findings themselves are `GET /okf/audit`). `queues`
maps each queue name (`untyped`, `uncategorized`, `stale`, `superseded_without_successor`,
`machine_unverified`, `drafts_older_than_30d`, `lint_failed_inbound`, `declined_removal_still_deleted`) to
`{ count, items }`: `count` is the full size, `items` the first 50 item summaries (each now carries `source`,
the registry source its file lives in, when recorded). `sync` and `mirror` are instance-wide and ignore `topic`.

### GET /admin/health/content/queues/:queue

**Auth**: Admin (403 otherwise).

One page of one fix-it queue — how a table reaches past the report's first 50 members. Same membership rules
as the report, without its OKF export and audit.

**Query**: `topic` (optional, as above), `offset` (whole number ≥ 0, default 0), `limit` (1–200, default 50).

**Response**: 200.
```json
{ "queue": "stale", "count": 120, "total": 120, "offset": 50, "limit": 50, "items": [ /* item summaries */ ] }
```
`total` repeats `count` under the name the other paged admin lists use. An offset past the end returns
`items: []` with the real `total`. `lint_failed_inbound` members carry `lint` as in the report.

**Errors**: 404 for an unknown queue name; 400 for a malformed `offset` or `limit` (negative, fractional,
non-numeric, `limit` 0 or over 200).

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

