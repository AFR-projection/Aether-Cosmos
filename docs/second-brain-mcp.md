# Brain MCP Server

The Model Context Protocol endpoint external AI agents use to reach a user's
Second Brain.

```
POST /api/brain/mcp
```

- Transport: **Streamable HTTP**, stateless
- Auth: `Authorization: Bearer sk_<agent key>`
- Server name: `storage-byafr-brain`

Stateless matters: no `Mcp-Session-Id` is issued or required, so nothing depends on
a session map held in one process's memory. The endpoint works unchanged behind
nginx or `docker compose` with several app workers — the failure mode of the
previous MCP implementation.

## Connecting an agent

### 1. Mint an agent key

```bash
curl -s -X POST "$APP_URL/api/brain/$BRAIN_ID/agents" \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF" -b "csrf_token=$CSRF; storage_session=$SESSION" \
  -d '{"name":"OpenClaw","scopes":["brain.read","brain.search","brain.write"]}'
```

The response contains `rawKey` **once**. Only its argon2 hash is stored; it can
never be shown again. Losing it means minting a new agent.

### 2. Read the connection details

```bash
curl -s "$APP_URL/api/brain/$BRAIN_ID/connect" -b "storage_session=$SESSION"
```

Returns the MCP URL, the auth header format, an example client config, and the
agents already connected — no secrets.

### 3. Point the client at it

```json
{
  "mcpServers": {
    "storage-byafr-brain": {
      "type": "http",
      "url": "https://your-app.example.com/api/brain/mcp",
      "headers": { "Authorization": "Bearer sk_YOUR_AGENT_KEY" }
    }
  }
}
```

Client config shapes differ; the two things every client needs are the URL and the
`Authorization` header.

### 4. Verify

```bash
curl -s -X POST "$APP_URL/api/brain/mcp" \
  -H "Authorization: Bearer sk_YOUR_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

Project scoping: `brain_recall`, `brain_search`, `brain_get_recent` and
`brain_remember` accept an optional `projectId` (see `brain_list_projects`), so an
agent working on one project can keep its context to that project. Standing
instructions and preferences are always included regardless.

Brain selection: every brain-scoped tool takes an **optional** `brainId`. Omit it
and the credential's default (or only) brain is used. A `brainId` outside the
credential's grants is a 404 — an agent cannot name a brain it was not given.

| Tool | Scope | Purpose |
|---|---|---|
| `brain_list_brains` | — | which brains this credential may access, and with what scopes |
| `brain_recall` | `brain.read` | bounded context package for a task: standing instructions, relevant memories, important memories, recent changes, related graph nodes |
| `brain_search` | `brain.search` | ranked full-text search, compact results |
| `brain_read` | `brain.read` | one memory in full, with provenance |
| `brain_get_recent` | `brain.read` | recently updated memories, cursor-paginated |
| `brain_get_memory_history` | `brain.read` | version history of one memory |
| `brain_list_projects` | `brain.read` | projects and their memory counts |
| `brain_list_tags` | `brain.read` | how this brain is organized |
| `brain_remember` | `brain.write` | persist durable knowledge; dedupes on title+type |
| `brain_update` | `brain.write` | amend a memory (snapshots a version first); also archive/unarchive |
| `brain_delete` | `brain.delete` | soft-delete — **not** granted to agents by default |
| `brain_get_entity` | `brain.read` | find knowledge-graph nodes |
| `brain_get_related` | `brain.read` | edges, optionally around one node |
| `brain_link` | `brain.write` | link two things by name, creating nodes as needed |

### Recommended usage

Call `brain_recall` **once** at the start of a task, then `brain_search` for
follow-ups. Call `brain_remember` only for knowledge that stays true after the
conversation ends. Prefer `brain_update` over writing a second memory that
contradicts the first, and `brain_update` with `archived: true` over
`brain_delete`.

The server sends these instructions to the client during `initialize`, so a
compliant agent sees them without extra prompting.

## Security

- Authorization is resolved **before** the transport parses the request body, so an
  unauthenticated or unscoped caller never reaches a tool.
- The principal is captured in each tool's closure rather than read per call — a
  tool cannot run without an authorization context.
- Tools call the Brain service layer directly. There is no raw-query tool, no SQL
  passthrough, and no HTTP hop back through the REST API.
- Rate limit: 120 requests/minute per key prefix, checked before the argon2 verify
  so a looping agent cannot burn CPU without bound.
- Errors returned to agents are typed messages or a generic `INTERNAL`; SQL and
  stack traces stay in the server log.
- Every write, and every `brain_recall` / `brain_search`, lands in
  `brain_audit_logs` with `transport: "mcp"` and the agent name.

### Revoking access

| Action | Effect |
|---|---|
| `DELETE /api/brain/{id}/agents/{agentId}` | drops the agent's grant on that brain; its key still works for other brains |
| `PATCH /api/brain/{id}/agents/{agentId}` with `{"status":"revoked"}` | kills the agent everywhere: deletes its API key and every grant it holds |

## Smoke test

```bash
npx next start                                   # in another shell
npx tsx scripts/test-brain-mcp-flow.ts http://localhost:3000
```

Creates a throwaway brain and agent, runs the full protocol, asserts cross-brain
isolation over both MCP and REST, then deletes everything it made. It writes to
whatever `DATABASE_URL` points at.
