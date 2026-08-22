# API Reference

The REST API of Storage ByAFR: how requests authenticate, what every response
looks like, and which endpoint families exist.

**The machine-readable spec served by the running app is authoritative:**

| URL | Contents |
|-----|----------|
| `GET /api/v1/openapi` | OpenAPI 3.0 document, generated from the code |
| `GET /api/v1/docs` | Human-readable endpoint listing |
| `GET /api/v1/me` | Who you are, which scopes the credential carries, and which endpoints it can reach |

This page explains the rules those documents assume. Where the two disagree, the
served spec is right and this page is stale — report it.

---

## Authentication

Four credential types are accepted, distinguished by prefix:

| Credential | Form | Created in |
|-----------|------|-----------|
| Session cookie | `httpOnly`, `secure` cookie | Browser login |
| User API key | `Authorization: Bearer sk_…` | Settings → API Keys |
| Master API key | `Authorization: Bearer skm_…` | Admin → API Keys (master accounts only) |
| OAuth access token | `Authorization: Bearer oat_…` | OAuth authorization flow |

A key is shown exactly once, at creation. Only its prefix and an Argon2id hash are
stored, so a lost key is replaced, never recovered.

Failed key authentication is rate limited per key prefix (20 attempts / 15 min).
Expired keys return `401`; a master key belonging to an account that is no longer
`master` is rejected outright.

---

## Scopes

### Storage scopes

| Scope | Grants |
|-------|--------|
| `read` | List files and folders, search, read metadata |
| `upload` | Presign → complete upload flow |
| `download` | Download files and ZIP archives |
| `delete` | Soft delete and permanent delete |
| `write` | Rename, move, favorite, restore, edit notes |
| `full` | All storage scopes above — **not** admin, **not** `brain.*` |

### Admin scopes (master keys only)

`admin:users`, `admin:settings`, `admin:stats`, `admin:monitoring`,
`admin:shares`, `admin:email`; `admin` covers all six. `supreme` satisfies every
scope check in the system.

### Second Brain scopes

A separate namespace: `brain.read`, `brain.search`, `brain.write`, `brain.link`,
`brain.delete`, `brain.export`, `brain.import`, `brain.consolidate`.

Two rules the code enforces rather than documents:

- The storage `full` scope grants **no** `brain.*` access. Keys issued before the
  Second Brain existed cannot read memories.
- OAuth access tokens can never carry `brain.*` scopes at all.

`brain.write` implies `brain.link`. See
[Second Brain MCP § Scopes](second-brain-mcp.md).

---

## Response format

Every JSON endpoint returns the same envelope.

```json
{ "success": true, "data": { } }
```

```json
{ "success": false, "error": "title: Required", "code": "VALIDATION_ERROR" }
```

`error` is a message intended for a human; `code` is stable enough to branch on.
SQL text and stack traces never appear in a response — they go to the server log.

| Status | Meaning |
|--------|---------|
| `400` | Validation failure (`VALIDATION_ERROR`) or bad request |
| `401` | Missing, expired, or invalid credential |
| `403` | Authenticated but the scope or role is insufficient (`Missing scope: …`) |
| `404` | Not found, or not visible to this account — the two are deliberately indistinguishable |
| `409` | Conflict; unique-constraint violations surface as `DUPLICATE` |
| `429` | Rate limited |
| `500` | Server error; details are in the log only |

Security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`) are attached to every response.

---

## CSRF

Mutating requests made with a **session cookie** must send `x-csrf-token`
matching the `csrf_token` cookie; fetch one from `GET /api/auth/csrf`. Comparison
is timing-safe.

Requests carrying `sk_`, `skm_`, or `oat_` Bearer tokens skip the check — a browser
never attaches those automatically, so there is no CSRF risk, and requiring a
cookie would break every headless client.

---

## Rate limits

Per user, per minute, from the admin **Rate Limit** setting (default `60`).
Buckets are separate so one kind of traffic cannot starve another: Second Brain
requests use `brain:*` buckets, storage uses `api`. Bulk endpoints get a
multiplier rather than a fixed floor, so lowering the admin setting lowers batch
throughput proportionally instead of being ignored.

Counters are Redis fixed-window, with an in-process fallback when Redis is
disabled. Login has its own IP-based throttle.

---

## Endpoint families

Roughly 100 routes live under `app/api/**/route.ts`. Not all of them accept an API
key — many are browser-only by design, and reach for the session cookie directly.

**Reachable with an API key or OAuth token:**

| Route | Method | Scope |
|-------|--------|-------|
| `/api/files` | `GET` | `read` |
| `/api/files` | `PATCH` | `write`, or `delete` when `action: "delete"` |
| `/api/files` | `DELETE` | `delete` |
| `/api/files/[id]` | `GET` / `PUT` | `read` / `write` |
| `/api/files/batch` | `DELETE` | `delete` |
| `/api/folders` | `GET` | `read` |
| `/api/search` | `GET` | `read` |
| `/api/upload/presign`, `/presign-batch`, `/complete`, `/complete-batch` | | `upload` |
| `/api/uploads/init`, `/active`, `/[id]`, `/[id]/parts/{sign,commit}`, `/[id]/{complete,abort,retry}` | | `upload` |
| `/api/download/[id]`, `/api/download/zip`, `/api/download/archive/[id]`, `/api/folders/[id]/download` | `GET` | `download` |
| `/api/deletions/[id]` | `DELETE` | `delete` |
| `/api/brain`, `/api/brain/[id]/*`, `/api/brain/mcp` | | `brain.*` |
| `/api/admin/{users,settings,stats,monitoring,shares,email}` | | `admin:*`, master key only |
| `/api/v1/{me,docs,openapi}` | `GET` | any credential |

**Session cookie only** — no API key path exists for these:

| Family | Routes |
|--------|--------|
| Auth | `/api/auth/*` — login, register, OTP, 2FA, step code, password, sessions, CSRF, impersonate |
| File extras | `/api/files/[id]/{preview,thumbnail,versions}`, `/versions/restore`, `/archive/{listing,extract}`, `/api/files/edit` |
| Folders | `/api/folders/[id]/members`, `/api/folders/batch` |
| Sharing | `/api/shares`, `/api/shares/[id]/access-logs`, `/api/invitations`, `/api/shared-with-me` |
| Recycle bin | `/api/recycle-bin`, `/api/upload/cancel` |
| Overview | `/api/dashboard`, `/api/activity`, `/api/activity/scope` |
| Realtime | `/api/events` (SSE) |
| Keys | `/api/settings/api-keys` |
| Webhooks | `/api/webhooks`, `/api/webhooks/[id]`, `/api/webhooks/[id]/test` |
| OAuth (browser leg) | `/api/oauth/{authorize,approve,connections}` |
| Admin | `/api/admin/api-keys`, `/api/admin/events` (SSE) — master session, not a key |

`/api/shared/[token]` and `/api/shared/[token]/preview` are public share-link
routes and need no credential at all — the token is the credential.
`/api/oauth/register` and `/api/oauth/token` authenticate with client credentials
rather than a scope.

If you need programmatic access to something in the second table, say so rather
than working around it — widening a route's auth surface is a deliberate change,
not a configuration flag.

### Second Brain routes

| Route | Purpose |
|-------|---------|
| `/api/brain` | List and create brains |
| `/api/brain/[id]` | Read, update, delete one brain |
| `/api/brain/[id]/memories` | List, search-free listing, create |
| `/api/brain/[id]/memories/[memoryId]` | Read, update, delete |
| `/api/brain/[id]/memories/[memoryId]/versions` | Version history; `/versions/[versionId]/restore` restores one |
| `/api/brain/[id]/memories/[memoryId]/links` | Memory↔memory links |
| `/api/brain/[id]/search` | Hybrid search |
| `/api/brain/[id]/graph` | Graph snapshot for the workspace |
| `/api/brain/[id]/projects`, `/entities`, `/relationships`, `/tags` | Structure around memories |
| `/api/brain/[id]/agents` | Agent registrations and their scopes |
| `/api/brain/[id]/audit` | Audit log |
| `/api/brain/[id]/export`, `/import` | `.afrbrain` archive round-trip |
| `/api/brain/[id]/consolidate` | Non-destructive consolidation pass |
| `/api/brain/mcp` | The MCP endpoint agents connect to |

Every one of these resolves `brain_id` through a single authorization choke point
before touching data. A `brain_id` in a request body or path is never trusted on
its own. Details in
[Second Brain Architecture § Isolation](second-brain-architecture.md#isolation).

---

## Example

```bash
# Discover what a key can do
curl -H "Authorization: Bearer sk_…" https://storage.example.com/api/v1/me

# List files
curl -H "Authorization: Bearer sk_…" https://storage.example.com/api/files

# Fetch the OpenAPI document
curl -H "Authorization: Bearer sk_…" https://storage.example.com/api/v1/openapi
```

A master key (`skm_`) receives the admin paths in the OpenAPI document as well; a
user key does not see them.

---

**See also:** [Second Brain MCP](second-brain-mcp.md) ·
[Architecture](architecture.md) · [Development](development.md)
