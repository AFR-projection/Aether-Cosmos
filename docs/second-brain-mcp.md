# Brain MCP Server

The Model Context Protocol endpoint external AI agents use to reach a user's
Second Brain.

```
POST /api/brain/mcp
```

- Version: **2.3.0**
- Transport: **Streamable HTTP**, stateless
- Auth: `Authorization: Bearer sk_<agent key>`
- Server name: `aether-cosmos-brain`

Stateless matters: no `Mcp-Session-Id` is issued or required, so nothing depends on
a session map held in one process's memory. The endpoint works unchanged behind
nginx or `docker compose` with several app workers — the failure mode of the
previous MCP implementation. Conversation lifecycle state is client-carried too:
the client sends a free-form `sessionId` for correlation and an `exclude` list of
memory IDs already injected, so lifecycle calls remain safe across workers without
a session table or migration.

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

Returns the MCP URL, the auth header format, connected agents, lifecycle REST
endpoints, and generated templates for Claude Code, Claude Desktop, Codex, OpenCode,
and Hermes — no secrets. These are examples, not an allowlist: **any AI agent or
client that supports MCP can connect** with the endpoint and Bearer credential. Every
template contains `sk_YOUR_AGENT_KEY`; Claude Code and Codex read the real key from
`AETHER_BRAIN_AGENT_KEY`. Merge generated files into existing configuration rather
than replacing it, and never commit a raw key.

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
agent working on one project can keep its context to that project. Brain-wide standing
instructions are always included; a project's own rules override same-titled brain-wide
ones (see [Project overrides](#project-overrides)).

Brain selection: every brain-scoped tool takes an **optional** `brainId`. Omit it
and the credential's default (or only) brain is used. A `brainId` outside the
credential's grants is a 404 — an agent cannot name a brain it was not given.

| Tool | Scope | Purpose |
|---|---|---|
| `brain_list_brains` | — | which brains this credential may access, and with what scopes |
| `brain_recall` | `brain.read` | bounded context package for a task: standing instructions (project overrides applied), relevant memories, important memories, recent changes, related graph nodes |
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
| `brain_session_start` | `brain.read` | start a client-carried session and return standing instructions plus bounded topic context and the IDs already shown |
| `brain_session_turn` | `brain.search` | precise, low-cost context for one prompt, excluding memories already injected; empty when nothing new is relevant |
| `brain_session_end` | `brain.ingest` | conservatively mine durable knowledge from the closing transcript and optionally write it back |
| `brain_ingest` | `brain.ingest` | run the same explainable writeback pipeline mid-session over transcript turns or explicit candidates |

**32 tools.** The first 28 comprise the original, intelligence, and
batch/observability surfaces; the final 4 add the stateless conversation lifecycle
and conservative writeback. See [Intelligence Layer (2.0)](second-brain-2.0.md) for
what the 2.0 retrieval tools do and their current limits.

Batching is a round-trip saving, not a different query: `brain_batch_search` is
`brain_search` run concurrently, and each `brain_batch_context` task gets the same
context engine a single `brain_context` call would. Both refuse the same way a single
call would if the scope is missing.

### Recommended usage

With generated lifecycle integration, let `brain_session_start` load memory before the
first substantive turn, `brain_session_turn` inject only new prompt-specific context,
and `brain_session_end` harvest durable knowledge. Without hooks, call
`brain_recall` **once** at the start of a task, then `brain_search` for follow-ups.
Call `brain_remember` only for knowledge that stays true after the conversation ends.
Prefer `brain_update` over writing a second memory that contradicts the first, and
`brain_update` with `archived: true` over `brain_delete`.

The server sends these instructions to the client during `initialize`, so a
compliant agent sees them without extra prompting.

## Conversation lifecycle and automatic writeback

MCP cannot push new context into a conversation already in progress. Version 2.3.0
therefore exposes each lifecycle moment both as an MCP tool and as a Bearer-authenticated
REST endpoint:

| Moment | MCP tool | REST endpoint | Required scope |
|---|---|---|---|
| Start | `brain_session_start` | `POST /api/brain/{id}/session/start` | `brain.read` |
| Turn | `brain_session_turn` | `POST /api/brain/{id}/session/turn` | `brain.search` |
| End | `brain_session_end` | `POST /api/brain/{id}/session/end` | `brain.ingest` |
| Explicit ingest | `brain_ingest` | `POST /api/brain/{id}/ingest` | `brain.ingest` |

Start returns a bounded recall package and every memory ID shown. The client keeps
those IDs in `exclude`; turn returns at most three new, short memories and an updated
ID list. It uses precise AND-style full-text matching because silently injecting a
wrong memory is worse than injecting none. No terms or no new match returns `text: ""`,
so a hook adds zero prompt tokens in the common no-op case.

There is no server-side session record. `sessionId` is correlation/provenance text,
not a database session key, and the client carries both it and `exclude` across calls.
The exclusion list is deduplicated and capped at 200 IDs.

### Claude Code hooks

`GET /api/brain/{id}/connect` returns a tested three-file Claude Code template:

- `.mcp.json` connects with `${AETHER_BRAIN_AGENT_KEY}`.
- `.claude/settings.json` installs `SessionStart`, `UserPromptSubmit`, and `SessionEnd`
  command hooks. Start also runs after resume, clear, compact, and fork.
- `.claude/hooks/aether-brain.cjs` reads hook JSON from stdin, stores only `sessionId`
  and `exclude` in the OS temporary directory, prints start/turn context to stdout,
  and sends the last 60 user/assistant transcript turns at session end.

Set `AETHER_BRAIN_AGENT_KEY` in the environment; do not replace it with a committed
literal. Claude Code writes transcripts asynchronously, so `SessionEnd` can miss the
last in-memory turn. If that turn contains critical durable knowledge, use
`brain_ingest` before ending rather than relying only on the closing transcript.

Other generated templates (Claude Desktop, Codex, OpenCode, and Hermes) include the
MCP connection plus lifecycle bootstrap instructions. Their hosts do not all offer
the same deterministic hook events, so the agent calls lifecycle tools when hooks did
not already inject or harvest context.

### Conservative ingest decisions

Session end and explicit ingest share one pipeline. It first mines or accepts bounded
candidates, then applies these gates in order:

1. **Salience:** durable instructions, preferences, decisions, procedures, facts,
   identity, and corrections score up; questions, pleasantries, ephemeral requests,
   and code dumps score down. English and Indonesian signals are recognized.
2. **Deterministic sampling:** a stable hash of session plus candidate makes the same
   input produce the same decision; there is no `Math.random` rollout drift.
3. **Importance and write budget:** weak candidates stop before a database read, and
   the strongest candidates spend a maximum of five writes per call first.
4. **Fuzzy duplicate search:** normalized title/body comparison combines character
   trigrams, token overlap, and containment, restricted to live memories in the same
   project when one is specified.
5. **Safe disposition:** create a new memory, raise confidence for corroboration,
   append genuinely new material through versioned `brain_update`, report a possible
   duplicate for review, or skip. Existing content is never destructively replaced.

Conversation memories use `sourceType: "conversation"` and carry session, agent, role,
turn-index, inferred-type, and merge provenance in metadata. Existing metadata is
preserved during append merges. Tags are normalized and deduplicated.

Every result explains its disposition and threshold decisions. Set `commit: false`
for a full preview: it reports what would be created or merged but performs no write,
cache invalidation, audit entry, or realtime event. A committed session end is audited
even when every candidate is rejected, preserving the lifecycle bracket without
pretending a memory changed. `brain.ingest` is intentionally a separate risky scope:
`brain.write` does **not** imply permission to harvest an unattended conversation,
and default agent grants omit it. `brain.full` still covers it explicitly.

Per-turn lookup is deliberately not audited: it can run on every prompt and does not
mutate data, so logging it would create a high-volume transcript-shaped activity trail.
Session start and committed ingest/end operations retain the normal lifecycle/write
audit behavior.

## Standing instructions arrive with the connection

MCP has no server-initiated push into a conversation: a server cannot inject context
mid-session, and no MCP config flag can make an agent recall on its own. There are
exactly two automatic paths, and the brain uses both.

**1. The handshake.** `InitializeResult.instructions` is placed in the system prompt by
compliant clients, so it is the one channel that reaches the model without being asked.
Since 2.2.0 that string is built per credential and carries the user's own rules:

```
Brain: "Personal Brain".

Standing instructions — the user's own rules, already in force. Follow them:
- Answer style: Reply in Indonesian, casual register
- [project] Commit style: Plain sentences, no conventional-commit prefixes
(3 more not shown; call brain_recall to see the rest.)

This is the user's Second Brain: their protected, persistent long-term memory.
Protocol: …
```

- A rule is any live memory of type `instruction` or `preference`. Create them from
  `/brain/memories` or with `brain_remember`.
- One line per rule, each clipped to 320 characters, the block capped at 1800. Over the
  cap, whole rules are dropped and counted — never cut mid-sentence, because an agent
  cannot tell it has read half a rule.
- Requires `brain.read`. A write-only credential gets the protocol alone: connecting is
  not a read, and the user's rules are not a side effect of saying hello.
- Read once per brain and cached for 60s. The transport is stateless — every HTTP
  request builds a fresh server — so without the cache this read would ride on every
  tool call rather than on every connect.
- If the database is unreachable the handshake falls back to the static protocol.
  Losing the rules for one session is recoverable; losing the handshake is not.

**2. Prompts.** Clients surface MCP prompts as commands, which is how a *person* loads
context in one keystroke instead of asking in prose.

| Prompt | Arguments | Claude Code command |
|---|---|---|
| `session_start` | `topic` (optional) | `/mcp__aether-cosmos-brain__session_start` |
| `standing_instructions` | — | `/mcp__aether-cosmos-brain__standing_instructions` |

`session_start` returns the full `brain_recall` package for the topic;
`standing_instructions` returns the rules alone, for a mid-session refresh. Both need
`brain.read` and neither needs a new scope.

> When a prompt declares an `argsSchema`, the SDK parses `params.arguments` strictly, so
> a client that omits the field — which the spec permits — gets `Invalid arguments`
> rather than a result. Send at least `"arguments": {}` for `session_start`.
> `standing_instructions` declares no schema for exactly this reason.

### Project overrides

A rule with no project is brain-wide and always applies. A rule attached to a project
**replaces** a brain-wide rule with the same title when that project is the context —
title matching ignores case and collapses whitespace, because the user is writing rules,
not database keys. Two contradictory rules in one prompt is worse than either alone.

With no project named, every rule is returned and labelled. Narrowing there would hide a
rule from every session that did not happen to name the project it was attached to.

### GET /api/brain/{id}/connect

The connect payload's `mcp.autoContext` block reports how many rules are in force, the
prompt names, and each prompt's client command — so a config snippet can never name a
prompt this server does not register.

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

- Lifecycle and ingest REST routes follow the shared CSRF policy. Cookie-authenticated
  callers must send matching `x-csrf-token` and `csrf_token` values; programmatic
  `Authorization: Bearer sk_…` agent requests use the established Bearer exemption.
  Authentication and per-brain scopes are still enforced after that check.
- `brain.ingest` is not in the default agent scope set and is not implied by
  `brain.write`; grant it only to clients allowed to harvest conversations unattended.
- Authorization is resolved **before** the MCP transport parses the request body, so an
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
