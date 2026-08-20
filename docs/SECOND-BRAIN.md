# Second Brain

Persistent, user-owned memory and knowledge infrastructure for humans and AI agents.

> My agent can change. My server can die. My model can change. My Brain stays mine.

## Why it exists

An AI agent is disposable. It gets reinstalled, moved to another VPS, upgraded,
replaced, or destroyed with the server it ran on. The user's long-term
knowledge — facts, decisions, preferences, projects, relationships — must not go
with it.

So the Brain lives in PostgreSQL, alongside (not inside) the storage product, and
agents reach it only through an authorized API.

```
                    STORAGE BYAFR
                         │
              ┌──────────┴──────────┐
              │                     │
        FILE STORAGE          SECOND BRAIN
              │                     │
        Cloudflare R2          PostgreSQL
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                 Memory        Knowledge          Graph
                    │          (entities)     (relationships)
              Versioning
                    │
                Brain API  ── lib/brain/*-service.ts
                    │
           ┌────────┴────────┐
           │                 │
      REST (web)         MCP (agents)
                             │
                  OpenClaw / Hermes / any MCP client
```

### Boundaries that are not negotiable

| Component | Role for the Brain |
|---|---|
| PostgreSQL | **canonical source of truth** |
| Cloudflare R2 | file/object storage only — never core memory |
| Redis | cache, queues, rate limits — never memory |
| AI agents | consumers, never the store; no direct DB access |

If Redis or R2 is down, the Brain still works.

## Data model

Added by `drizzle/0013_second_brain.sql`. Every brain-owned row carries `brain_id`
and cascades from `brains`.

| Table | Holds |
|---|---|
| `brains` | one knowledge space; `owner_user_id`, `is_default`, `status` |
| `memories` | the memory itself + provenance, `importance`, `confidence`, generated `search_vector` |
| `memory_versions` | immutable history; unique on `(memory_id, version_number)` |
| `memory_tags`, `memory_tag_map` | per-brain tags |
| `brain_projects` | groups memories by the work they belong to; unique on `(brain_id, name)` |
| `brain_entities` | knowledge-graph nodes; unique on `(brain_id, name, type)` |
| `brain_relationships` | typed edges; unique on `(source, target, relationship_type)` |
| `brain_agents` | agent identities, each optionally bound to one API key |
| `brain_access` | grants: `(brain_id, principal_type, principal_id) → role + scopes` |
| `brain_audit_logs` | append-only trail of every write and every agent read |

Notable constraints:

- `brains_owner_default_unique` — a **partial** unique index on `(owner_user_id)
  WHERE is_default`, so two concurrent first-time requests cannot both create a
  default brain.
- `memories_brain_keyset_idx` on `(brain_id, created_at, id)` — matches the keyset
  pagination order exactly.
- `memories_search_vector_idx` — GIN over the generated tsvector
  (`title` weight A, `content` weight B, `simple` config, same as files).
- `memories.project_id` is `ON DELETE SET NULL` — deleting a project ends the work,
  it does not delete the knowledge gathered under it.

## Isolation

Every request resolves in one order, at one choke point
(`lib/brain/access.ts` for REST, `lib/brain/mcp/principal.ts` for MCP):

```
authenticated principal → authorized brain → authorized resource → operation
```

- `requireBrainContext(request, brainId, scopes)` — REST. Loads the brain by
  `(id, owner_user_id)`, so a brain id belonging to someone else is a 404 before
  any resource query runs.
- Agent callers are narrowed **twice**: by the `brain.*` scopes on their API key,
  and again by the scopes on their `brain_access` row for that specific brain.
  Revoking either one locks the agent out.
- `requireBrainOwnerContext` — for endpoints an agent must never reach even with a
  valid grant (audit trail, agent management, connection info).
- Version and relationship reads join back to their parent row **with the brain id
  attached**, so a memory id from another brain cannot be used as a side door.

## Scopes

`brain.*` is a namespace of its own, deliberately separate from the storage scopes:

| Scope | Grants |
|---|---|
| `brain.read` | read memories, tags, entities, relationships, recall |
| `brain.search` | full-text search |
| `brain.write` | create/update memories, upsert entities and relationships |
| `brain.delete` | soft-delete memories, delete entities/edges, delete a brain |
| `brain.export` | bulk export |

New agents default to `read + search + write` — never `delete`, never `export`.

**The storage `full` scope does NOT grant any `brain.*` scope.** Every API key
already issued with `full` would otherwise silently gain access to the owner's
memories. See `keyHasScope` in `lib/auth/api-key.ts` and the test in
`lib/brain/constants.test.ts`.

OAuth access tokens can never reach the Brain: `brain.*` is not in `OAUTH_SCOPES`,
so `parseScopes` strips it.

## Memory semantics

**Versioning.** Any edit to `title`, `content`, `summary`, or `metadata` snapshots
the previous state into `memory_versions` and bumps `version`, inside one
transaction with `SELECT … FOR UPDATE` on the memory row. Archiving or re-tagging
does not create a version. Restoring a version is itself an edit, so the
pre-restore state is preserved too — history never shrinks.

**Provenance.** `source_type`, `source_id`, `created_by` (human) and
`created_by_agent` are separate fields, so an agent's inference is never presented
as a human-confirmed fact.

**Confidence and importance.** Both `real` in `[0, 1]`. `importance ≥ 0.7` is what
`brain_recall` treats as durable identity/project-level knowledge.

**Deletion.** Soft by default (`deleted_at`), with `archived_at` as the softer
option agents are pointed at first. Deleting a brain is a hard cascade and is
refused for the default brain.

## Agent memory protocol

```
SESSION START
     ↓
brain_recall(task)          ← standing instructions + relevant + important + recent + graph
     ↓
AGENT WORK
     ↓
brain_search / brain_read   ← look things up as needed
     ↓
brain_remember(...)         ← only what is worth keeping permanently
brain_update(...)           ← correct existing memory rather than contradicting it
brain_link(a, b, type)      ← record relationships
     ↓
SESSION END
```

`brain_recall` is bounded (default 6000 characters, capped sections, truncated
snippets). `brain_remember` updates an existing memory when title+type already
match, and reports near-duplicates it found instead of silently forking them.

See [MCP.md](./MCP.md) for the tool list and how to connect an agent.

## Web UI

`/brain`, one client of the Brain API among several — it holds no privileged path
into the data.

| Route | What it does |
|---|---|
| `/brain` | counters, recently updated memories, agent activity, connect shortcut |
| `/brain/memories` | search + type/project/tag/archived filters, create |
| `/brain/memories/[memoryId]` | read, edit, version history with restore, archive, delete |
| `/brain/projects` | create, re-status, delete; deep-links into filtered memories |
| `/brain/graph` | entities and their edges |
| `/brain/agents` | mint an agent (key shown once), revoke, MCP connection details |
| `/brain/activity` | the audit trail, rendered as an agent timeline |
| `/brain/settings` | rename, archive, export, add another brain |

The selected brain lives in `localStorage` via `lib/brain/active-brain.ts` and is
read through `useSyncExternalStore`, so it survives navigation and stays in sync
across tabs.

The graph view is an adjacency list, not a force layout: §40 requires that a graph
of thousands of nodes must not freeze the browser, and a physics simulation is the
most likely way to break that. Nodes are capped at 60 per view and filterable;
edges are listed per selected node.

## Portability

A brain must be recoverable outside the runtime that wrote it.

- `GET /api/brain/{id}/export` returns the brain, its memories with tags, its
  projects, and the full graph as one JSON document, gated behind `brain.export`
  and always audited. `/brain/settings` downloads it as a dated `.json` file.

**Not yet implemented:** the packaged `.afrbrain` format (manifest + JSONL per
table) and the import path. Until import exists, export is a backup, not
portability. Tracked as the remaining Priority 5 work.
