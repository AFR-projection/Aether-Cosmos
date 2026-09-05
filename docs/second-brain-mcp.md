# Brain MCP Server

The Model Context Protocol endpoint external AI agents use to reach a user's
Second Brain.

```
POST /api/brain/mcp
```

- Transport: **Streamable HTTP**, stateless
- Auth: `Authorization: Bearer sk_<agent key>`
- Server name: `aether-cosmos-brain`

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
    "aether-cosmos-brain": {
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
| `brain_context` | `brain.read` | 2.0 context engine: hybrid retrieval + pure scorer + redundancy filter + token packing + explanation |
| `brain_search` | `brain.search` | ranked full-text search, compact results |
| `brain_read` | `brain.read` | one memory in full, with provenance |
| `brain_get_recent` | `brain.read` | recently updated memories, cursor-paginated |
| `brain_get_memory_history` | `brain.read` | version history of one memory |
| `brain_get_backlinks` | `brain.read` | explicit memory links pointing at this memory |
| `brain_list_projects` | `brain.read` | projects and their memory counts |
| `brain_list_tags` | `brain.read` | how this brain is organized |
| `brain_remember` | `brain.write` | persist durable knowledge; dedupes on title+type |
| `brain_update` | `brain.write` | amend a memory (snapshots a version first); also archive/unarchive |
| `brain_delete` | `brain.delete` | soft-delete — **not** granted to agents by default |
| `brain_link_memory` | `brain.link` | explicit memory↔memory edge with a label |
| `brain_get_entity` | `brain.read` | find knowledge-graph nodes |
| `brain_get_related` | `brain.read` | edges, optionally around one node |
| `brain_link` | `brain.write` | link two entities by name, creating nodes as needed |
| `brain_path` | `brain.read` | shortest path between two entities in the knowledge graph |
| `brain_timeline` | `brain.read` | temporal slices: memories created/updated in a date range |
| `brain_related` | `brain.read` | related memories via graph algorithms (PageRank walk + label propagation) |
| `brain_explain` | `brain.read` | why a memory was retrieved or scored the way it was |
| `brain_health` | `brain.read` | brain health snapshot: completeness, quality, connections, recency |
| `brain_consolidate` | `brain.consolidate` | non-destructive consolidation preview or apply (merge duplicate entities, reconcile naming conflicts) |
| `brain_batch_search` | `brain.search` | up to 10 queries in one call, run in parallel and aggregated; deduplicates across result sets by default |
| `brain_batch_context` | `brain.read` | up to 5 independent tasks, one context package each with its own token budget |
| `brain_analytics` | `brain.read` | memory distribution by type, tag frequency, recency, confidence, retrieval effectiveness over `7d`/`30d`/`90d`/`all` |
| `brain_suggest_queries` | `brain.read` | query suggestions drawn from recent activity and gaps in coverage |
| `brain_semantic_status` | `brain.read` | whether embeddings are enabled, the active provider/model, how many memories are embedded, backfill progress |
| `brain_export_memories` | `brain.read` | portable JSON or Markdown snapshot of selected memories; never includes embeddings |

**29 tools.** The first 14 are the 1.0 surface, the next 9 are 2.0 intelligence-layer
additions, and the last 6 are the batch/observability tools registered separately by
`infrastructure/mcp/tools-advanced.ts`. See [Intelligence
Layer (2.0)](second-brain-2.0.md) for what the 2.0 tools do and their current limits.

Batching is a round-trip saving, not a different query: `brain_batch_search` is
`brain_search` run concurrently, and each `brain_batch_context` task gets the same
context engine a single `brain_context` call would. Both refuse the same way a single
call would if the scope is missing.

### Recommended usage

Call `brain_recall` **once** at the start of a task, then `brain_search` for
follow-ups. Call `brain_remember` only for knowledge that stays true after the
conversation ends. Prefer `brain_update` over writing a second memory that
contradicts the first, and `brain_update` with `archived: true` over
`brain_delete`.

The server sends these instructions to the client during `initialize`, so a
compliant agent sees them without extra prompting.

## Result caching

`infrastructure/mcp/cache.ts` is an in-process read-through cache with a TTL. It
exists because an agent typically calls the same context query many times in one
session, and rebuilding a context package is the most expensive read in the brain.

- **What is cached today:** `brain_context` only, for 60 seconds. Every other tool
  reads the database on every call. `CACHE_TTL` also defines windows for search,
  analytics and semantic status; those paths are not wired to the cache yet.
- **Keys** are `operation:brainId:sha256(sorted params)`, so two brains never collide
  and parameter order does not produce a second entry.
- **Invalidation** is explicit: `brain_remember`, `brain_update`, `brain_delete` and
  `brain_link_memory` drop every entry for that brain, so a write is visible to the
  next read.
- **Bounds:** 100 entries, 5 MB total, and 50 KB per entry — a result larger than that
  is simply not cached. Eviction is by soonest expiry.
- **Per process, not shared.** Behind several app workers each holds its own copy, so
  a write handled by one worker does not clear another's. The 60-second TTL is the
  upper bound on how long a stale context package can survive. Nothing in the cache is
  persisted, and it holds no key material.

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
