# Aether Cosmos ByAFR — Documentation

Documentation for Aether Cosmos ByAFR **v0.4.0** — a self-hosted cloud storage platform
with a Second Brain knowledge layer for AI agents.

This directory is the single home for all project documentation. The root
[`README.md`](../README.md) is a landing page only; every detail lives here.

---

## Start here

| # | Guide | For |
|---|-------|-----|
| 1 | [Getting Started](getting-started.md) | Running it locally: install, configure, verify |
| 2 | [Deployment](deployment.md) | Production on an Ubuntu VPS: the one-command install, redeploy, and the `aether` CLI |
| 3 | [Architecture](architecture.md) | Tech stack, project layout, data flow, security layers |

---

## Platform

- [Features](features.md) — Files, sharing, encryption, realtime, background jobs
- [Backup & Restore](backup.md) — Per-account `.afrbak` archives, recovery phrases, merge vs replace
- [Admin Panel](admin.md) — Users, settings, analytics, email senders, activity logs
- [API Reference](api-reference.md) — Auth, conventions, endpoint families, OpenAPI spec
- [Development](development.md) — Workflow, tests, conventions, verification gates
- [Troubleshooting](troubleshooting.md) — Local and production failure modes
- [Security Assessment](security-assessment.md) — White-box review of 2026-08-26: 29 findings, all remediated in-tree

## Second Brain

- [Overview](second-brain.md) — What it is, setup, connecting an agent, usage
- [Architecture](second-brain-architecture.md) — Data model, isolation, scopes, semantics
- [Knowledge Graph](second-brain-graph.md) — Interactive graph: pipeline, physics, filters
- [MCP Server](second-brain-mcp.md) — Endpoint, tool catalogue, security, revocation
- [Intelligence Layer (2.0)](second-brain-2.0.md) — Retrieval, enrichment, context engine, health, provenance

---

## Documentation map

```
docs/
├── README.md                     # This index — the only index
├── getting-started.md            # Local setup
├── deployment.md                 # Production VPS deployment
├── architecture.md               # Tech stack & structure
├── features.md                   # Platform features
├── backup.md                     # Per-account backup & restore
├── admin.md                      # Admin panel
├── api-reference.md              # REST API
├── development.md                # Contributor workflow
├── troubleshooting.md            # Common issues
├── security-assessment.md        # Point-in-time security review
├── second-brain.md               # Second Brain overview
├── second-brain-architecture.md  # Data model & security
├── second-brain-graph.md         # Graph visualization
├── second-brain-mcp.md           # MCP server for agents
├── second-brain-2.0.md           # Intelligence layer
└── superpowers/specs/            # Design specs, cited by section number from the code
```

`superpowers/specs/` is not prose documentation and is not summarised here. Those files
are referenced directly by source comments, tests and migrations; deleting one breaks
the trail from a line of code to the decision behind it.

---

## Project status

| | |
|---|---|
| **Version** | 0.4.0 |
| **Automated tests** | 3422 passing, 35 skipped (171 test files, 3 skipped) |
| **Typecheck / lint** | `tsc --noEmit` and `eslint` clean |
| **Storage platform** | In production use by the maintainer |
| **Per-account backup** | `.afrbak` export/restore for Files and Brain — unit and integration tested; see [Backup & Restore](backup.md) |
| **Second Brain 1.0** | Memories, versions, graph, MCP — covered by tests |
| **Second Brain 2.0** | Retrieval, enrichment, context engine, health, provenance — covered by unit tests, reachable through MCP only; see [Intelligence Layer](second-brain-2.0.md#status-and-limits) |

Status wording in these docs is deliberate: **verified** means an automated test or
a reproducible manual check backs the claim, **partially verified** means the unit
level is covered but the integration is not, and **not verified** means neither.
No feature is described as complete on the strength of the code alone.

---

## Conventions

- **Language:** English throughout this documentation set. (Some older code
  comments are still in Indonesian; new comments are written in English.)
- **One index:** this file. Documents link to each other, never to a second index.
- **No duplication:** a fact lives in exactly one document; others link to it.
- **Numbers:** version and test counts are stated here and in the root README
  only, so there is one place to update them. The exception is
  [Security Assessment](security-assessment.md), which is a dated record and keeps the
  numbers that were true when it was written.
- **AI instruction files:** `AGENTS.md` in the repository root is instructions for AI
  coding assistants, not user documentation.

