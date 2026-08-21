# 🧠 Second Brain

Persistent, user-owned memory and knowledge infrastructure for AI agents.

---

## Overview

> **"My agent can change. My server can die. My model can change. My Brain stays mine."**

Second Brain is a knowledge management system designed for AI agents. Unlike ephemeral agent memory that resets with each session, Second Brain stores memories, relationships, and knowledge in PostgreSQL, making it:

- **Persistent** — Survives agent reinstalls, VPS migrations, model changes
- **Portable** — Export/import via `.afrbrain.zip` format
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
  - **Semantic** (4 edges) — Similar content via embeddings
  - **Context** (10 edges) — Shared tags, entities, projects
  - **Explicit** (0 edges) — User-created memory links
- **Local Graph** — Focus on one memory, see N-hop neighborhood (depths 1-6)
- **Filters** — Toggle tiers, search queries, hide orphans
- **Groups** — Up to 12 custom color-coded rules
- **Pop-out Workspace** — Independent window with cross-window sync (1-2ms)

### Projects
- Organize memories into projects with metadata
- Filter memories by project

### AI Agent Integration
- **MCP Server** — 17 tools for reading, writing, searching memories
- **Scoped Access** — Per-brain API keys with granular permissions
- **Rate Limited** — Protect against agent abuse

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

Point your MCP client (Hermes, OpenClaw, etc.) to:

```
POST https://yourdomain.com/api/brain/mcp
Authorization: Bearer sk_<agent-key>
```

### 3. Grant Permissions

Default scopes: `brain.read`, `brain.search`, `brain.write`

Never grant: `delete`, `export` (user-only operations)

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

## Export & Import

### Export Brain

```bash
GET /api/brain/{id}/export
```

Downloads `.afrbrain.zip` containing:
- Memories with full version history
- Entities and relationships
- Projects and tags
- Agent configurations (no secrets)

### Import Brain

```bash
POST /api/brain/{id}/import
```

Upload `.afrbrain.zip`. The system:
1. Validates format
2. Previews counts
3. Deduplicates on title+type
4. Restores data

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

✅ **Complete & Verified:**
- Memory CRUD with versioning
- Projects and tags
- Knowledge graph visualization
- Semantic + context relationships
- Local/global graph views
- Filters, groups, settings persistence
- Pop-out workspace with cross-window sync
- MCP server with 17 tools
- Export/import
- Audit logging
- 313 tests passing

⏭️ **Future Enhancements:**
- Backlinks panel in memory detail
- Advanced graph layouts (hierarchical, radial)
- Visual refinement (UI design review)

---

## Known Limitations

- Detail page loading race on newly-created memories (UI timing issue)
- Max 12 custom groups (performance ceiling)
- Cross-window delete sync requires UI mutation path

---

**Next Steps:**
- [Second Brain Architecture](second-brain-architecture.md) — Deep dive into design
- [Second Brain Graph](second-brain-graph.md) — Graph implementation
- [Second Brain MCP](second-brain-mcp.md) — Connect your AI agent
