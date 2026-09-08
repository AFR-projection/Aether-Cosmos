# 🧠 Second Brain

Persistent, user-owned memory and knowledge infrastructure for AI agents.

---

## Overview

> **"My agent can change. My server can die. My model can change. My Brain stays mine."**

Second Brain is a knowledge management system designed for AI agents. Unlike ephemeral agent memory that resets with each session, Second Brain stores memories, relationships, and knowledge in PostgreSQL, making it:

- **Persistent** — Survives agent reinstalls, VPS migrations, model changes
- **Protected** — Brain data has no standalone download surface; encrypted AFR account
  backup provides backup and recovery
- **Isolated** — Multi-tenant with row-level `brain_id` authorization
- **Auditable** — Complete activity timeline with agent attribution

---

## Key Features

### Memories
- **Versioned** — Full edit history with restore capability
- **Provenanced** — Track who created/modified (user or agent)
- **Structured** — Title, content, type, tags, importance, confidence
- **Searchable** — PostgreSQL FTS with ranked results

### Knowledge Graph
- **Interactive Visualization** — Pan, zoom, hover, click, right-click
- **Relationship Tiers:**
  - **Derived** — TF-IDF cosine similarity between memory content (not embeddings)
  - **Explicit** — User-created memory links
- **Local Graph** — Focus on one memory, see N-hop neighborhood (depths 1-6)
- **Filters** — Search queries, hide orphans
- **Groups** — Up to 12 custom color-coded rules
- **Pop-out Workspace** — Independent window with cross-window sync (1-2ms)

### Projects
- Organize memories into projects with metadata
- Filter memories by project

### AI Agent Integration
- **MCP Server** — 32 tools for reading, writing, searching memories, using the
  2.0 intelligence layer (retrieval, context, health, consolidation), batching and
  observability, plus the stateless lifecycle and conservative ingest pipeline
- **Universal MCP compatibility** — Any AI agent or client that supports MCP can
  connect. Claude Code, Claude Desktop, Codex, OpenCode, and Hermes templates are
  examples, not an allowlist.
- **Scoped Access** — Per-brain API keys with 8 granular scopes: `brain.read`,
  `brain.search`, `brain.write`, `brain.link`, `brain.delete`, `brain.import`,
  `brain.consolidate`, `brain.ingest`
- **Rate Limited** — Separate `brain:*` buckets so agent traffic cannot starve file
  uploads

---

## Setup

### Prerequisites
Second Brain is included by default. No additional environment variables required.

### Database Migrations

Migrations are already applied via `npm run db:push`. If applying manually:

```bash
npx tsx scripts/apply-migration.ts drizzle/0013_second_brain.sql
npx tsx scripts/apply-migration.ts drizzle/0014_brain_projects.sql
npx tsx scripts/apply-migration.ts drizzle/0015_brain_memory_links.sql
```

All migrations are additive and idempotent.

### Default Brain

A default "Personal Brain" is created automatically on first access. Access via:
- Sidebar → **Second Brain**
- Command palette: `⌘K` → type "brain"

---

## Connecting an AI Agent

### 1. Create Agent Credentials

Navigate to **Second Brain** → **Agents** → **Create Agent**.

The API key is shown once and only its hash is stored.

### 2. Configure MCP Client

Point any AI agent or client with MCP support to:

```
POST https://yourdomain.com/api/brain/mcp
Authorization: Bearer sk_<agent-key>
```

Claude Code, Claude Desktop, Codex, OpenCode, Hermes, OpenClaw, and other named
clients are examples only, not an allowlist. Compatibility depends on MCP support
and the endpoint plus Bearer credential.

### 3. Grant Permissions

Default scopes for a new agent: `brain.read`, `brain.search`, `brain.write`,
`brain.link`.

`brain.write` implies `brain.link` — an agent that can create memories can link
them. `brain.delete`, `brain.import`, and `brain.consolidate` are user-only by
default. `brain.ingest` is separate and must be granted explicitly for unattended
conversation harvesting.

---

## Usage

### Web Interface

**Dashboard** — Memory count, recent memories, projects, agents  
**Memories** — List, create, edit, version history  
**Graph** — Interactive knowledge graph visualization  
**Projects** — Organize memories into projects  
**Agents** — Manage API keys and permissions  
**Activity** — Audit timeline of all operations  

### Graph Keyboard Shortcuts

- **Arrow keys** — Pan canvas
- **+/−** — Zoom in/out
- **0** — Fit graph to view
- **Double-click node** — Center local graph
- **Right-click node** — Context menu

---

## Protected Backup & Recovery

Second Brain has no standalone download surface in the web UI, REST API, or MCP. Brain
data is protected with the rest of the account, and the supported backup/recovery path
is the encrypted AFR account backup. The backup system includes Brain data internally
without publishing a separate Brain archive endpoint.

An owner-controlled import primitive remains available for compatible Brain archives:

```bash
POST /api/brain/{id}/import
```

The system validates and previews the archive, merges projects, entities, tags, and
relationships by natural key, and adds memories, memory links, and versions. The
internal archive builder and parser remain available to account backup, restore, and
import code; they are not standalone export features.

---

## Architecture

See [Second Brain Architecture](second-brain-architecture.md) for:
- Data model and schema
- Authorization and isolation
- Memory semantics
- Security model

---

## Knowledge Graph

See [Second Brain Graph](second-brain-graph.md) for:
- Graph implementation details
- Relationship building algorithms
- Filter and group logic
- Browser QA verification

---

## MCP Integration

See [Second Brain MCP](second-brain-mcp.md) for:
- Available MCP tools
- Authentication flow
- Security best practices
- Example agent workflows

---

## Implementation Status

**Second Brain 1.0** (memories, versions, projects, entities, tags, relationships,
graph, MCP 1.0, export/import, audit) is covered by unit and integration tests and
in production use by the maintainer.

**Second Brain 2.0** (hybrid retrieval, context engine, enrichment, health,
provenance, feedback loop, consolidation, extended MCP tools) is covered by unit
tests and reachable through MCP only. See
[Intelligence Layer (2.0)](second-brain-2.0.md) for capabilities and limits.

Test count is reported in [docs/README.md § Project status](README.md#project-status).

⏭️ **Future:**
- Backlinks panel in memory detail
- Advanced graph layouts (hierarchical, radial)
- Visual refinement (UI design review)

---

## Known Limitations

- Detail page loading race on newly-created memories (UI timing issue)
- Max 12 custom groups (performance ceiling)
- Cross-window delete sync requires UI mutation path
- Import is non-idempotent for memories — importing the same archive twice creates
  duplicates; see [Second Brain 2.0 § Import](second-brain-2.0.md#import-non-idempotency)

---

**Next Steps:**
- [Second Brain Architecture](second-brain-architecture.md) — Deep dive into design
- [Second Brain Graph](second-brain-graph.md) — Graph implementation
- [Second Brain MCP](second-brain-mcp.md) — Connect your AI agent
